import { randomUUID } from 'node:crypto';
import { PaymentDatabase, type Tx } from '@resolveai/payment-store';
import { activeCaseStates } from '@resolveai/shared';
import {
  CaseStore,
  event,
  fail,
  replay,
  remember,
  member,
  type Actor,
} from './cases.js';
import { PrivateStorage, sha } from './storage.js';
import { scan, validateIsolated } from './scanner.js';
export class EvidenceService {
  constructor(
    readonly cases: CaseStore,
    readonly storage: PrivateStorage,
  ) {}
  async row(tx: Tx, a: Actor, caseId: string, id: string) {
    const r = (
      await tx.query(
        'SELECT * FROM "Evidence" WHERE id=$1 AND "caseId"=$2 AND "merchantId"=$3 FOR UPDATE',
        [id, caseId, a.merchantId],
      )
    ).rows[0];
    if (!r) fail('NOT_FOUND', 404);
    return r;
  }
  async upload(a: Actor, caseId: string, id: string, bytes: Buffer) {
    const lease = randomUUID();
    const record = await this.cases.tx(a, async (tx) => {
      const c = await this.cases.locked(tx, a, caseId);
      if (!(activeCaseStates as readonly string[]).includes(c.status))
        fail('CASE_CLOSED');
      const r = await this.row(tx, a, caseId, id);
      if (r.uploaderUserId !== a.userId) fail('NOT_FOUND', 404);
      if (r.uploadState !== 'RESERVED' || r.expiresAt < new Date())
        fail('UPLOAD_EXPIRED_OR_USED');
      if (bytes.length !== Number(r.sizeBytes) || sha(bytes) !== r.sha256)
        fail('UPLOAD_HASH_OR_SIZE_MISMATCH', 422);
      await tx.query(
        'UPDATE "Evidence" SET "uploadState"=\'UPLOADING\',"leaseOwner"=$2,"leaseUntil"=now()+interval \'60 seconds\' WHERE id=$1',
        [id, lease],
      );
      return r;
    });
    try {
      await this.storage.put(
        this.storage.env.S3_QUARANTINE_BUCKET,
        record.objectKey,
        bytes,
      );
      const changed = await this.cases.tx(a, (tx) =>
        tx.query(
          'UPDATE "Evidence" SET "uploadState"=\'UPLOADED\',"actualSize"=$3,"actualHash"=$4,"leaseUntil"=NULL WHERE id=$1 AND "leaseOwner"=$2 AND "uploadState"=\'UPLOADING\' RETURNING id',
          [id, lease, bytes.length, sha(bytes)],
        ),
      );
      if (!changed.rowCount) {
        await this.storage.delete(
          this.storage.env.S3_QUARANTINE_BUCKET,
          record.objectKey,
        );
        fail('UPLOAD_LEASE_LOST');
      }
    } catch (e) {
      await this.cases.tx(a, (tx) =>
        tx.query(
          'UPDATE "Evidence" SET "uploadState"=\'FAILED\',"failureCode"=\'UPLOAD_FAILED\',"leaseUntil"=NULL WHERE id=$1 AND "leaseOwner"=$2',
          [id, lease],
        ),
      );
      throw e;
    }
    return { id, uploaded: true };
  }
  async complete(
    a: Actor,
    caseId: string,
    id: string,
    key: string,
    version: number,
  ) {
    return this.cases.tx(a, async (tx) => {
      const c = await this.cases.locked(tx, a, caseId);
      const r = await this.row(tx, a, caseId, id);
      if (r.uploaderUserId !== a.userId && !(await member(tx, a)))
        fail('NOT_FOUND', 404);
      const old = await replay(tx, a, 'complete:' + id, key, {});
      if (old) return old;
      if (c.version !== version) fail('STALE_VERSION');
      if (!(activeCaseStates as readonly string[]).includes(c.status))
        fail('CASE_CLOSED');
      if (
        r.uploadState !== 'UPLOADED' ||
        r.actualHash !== r.sha256 ||
        r.actualSize !== r.sizeBytes
      )
        fail('UPLOAD_INCOMPLETE');
      await tx.query(
        'UPDATE "Evidence" SET "uploadState"=\'QUEUED\',"nextAttemptAt"=now() WHERE id=$1',
        [id],
      );
      await tx.query(
        'INSERT INTO "OutboxEvent"("merchantId","aggregateType","aggregateId","eventType","schemaVersion","payloadIds","dedupeKey") VALUES($1,\'Evidence\',$2,\'evidence.validate\',1,$3,$4) ON CONFLICT("merchantId","dedupeKey") DO NOTHING',
        [
          a.merchantId,
          id,
          JSON.stringify({ evidenceId: id }),
          'evidence-' + id,
        ],
      );
      await tx.query(
        'UPDATE "Case" SET version=version+1,"dataRevision"="dataRevision"+1 WHERE id=$1',
        [caseId],
      );
      await event(tx, a, caseId, 'EVIDENCE_QUEUED', c.status, c.status, {
        evidenceId: id,
      });
      const result = { id, state: 'QUEUED' };
      await remember(tx, a, 'complete:' + id, key, {}, result);
      return result;
    });
  }
  async download(a: Actor, caseId: string, id: string) {
    const r = await this.cases.tx(a, async (tx) => {
      await this.cases.locked(tx, a, caseId);
      return this.row(tx, a, caseId, id);
    });
    if (
      r.scanStatus !== 'CLEAN' ||
      r.uploadState !== 'AVAILABLE' ||
      !r.scannedAt ||
      !r.cleanObjectKey
    )
      fail('EVIDENCE_UNAVAILABLE', 409);
    const bytes = await this.storage.get(
      this.storage.env.S3_CLEAN_BUCKET,
      r.cleanObjectKey,
    );
    if (sha(bytes) !== r.sha256) fail('EVIDENCE_INTEGRITY_FAILURE', 503);
    return { bytes, mime: r.detectedType as string };
  }
}
export class EvidenceProcessor {
  constructor(
    readonly db: PaymentDatabase,
    readonly storage: PrivateStorage,
  ) {}
  async assertSafe() {
    const r = await this.db.rows(
      "SELECT rolname,rolsuper,rolbypassrls,rolcreaterole,rolcreatedb,EXISTS(SELECT 1 FROM pg_auth_members WHERE member=r.oid) AS membership,EXISTS(SELECT 1 FROM pg_class c WHERE c.relowner=r.oid AND c.relnamespace='public'::regnamespace) AS owns FROM pg_roles r WHERE rolname=current_user",
    );
    const role = r[0];
    if (
      !role ||
      !['resolve_evidence', 'resolve_evidence_test'].includes(role.rolname) ||
      role.rolsuper ||
      role.rolbypassrls ||
      role.rolcreaterole ||
      role.rolcreatedb ||
      role.membership ||
      role.owns
    )
      throw Error('UNSAFE_EVIDENCE_ROLE');
    const tables = await this.db.rows(
      "SELECT count(*)::int AS n,bool_and(relrowsecurity AND relforcerowsecurity) AS protected,has_schema_privilege(current_user,'public','CREATE') AS creates FROM pg_class WHERE relnamespace='public'::regnamespace AND relname=ANY(ARRAY['Evidence','Case','CaseTimelineEvent','OutboxEvent','EvidenceWorkerTenant'])",
    );
    if (
      tables[0]?.n !== 5 ||
      tables[0]?.protected !== true ||
      tables[0]?.creates !== false
    )
      throw Error('EVIDENCE_RLS_REQUIRED');
  }
  async tenants() {
    return this.db.rows<{ merchantId: string }>(
      'SELECT "merchantId" FROM "EvidenceWorkerTenant"',
    );
  }
  async process(merchantId: string, id: string) {
    const lease = randomUUID();
    const r = await this.db.transaction(
      merchantId,
      null,
      async (tx) =>
        (
          await tx.query(
            'UPDATE "Evidence" SET "uploadState"=\'PROCESSING\',"leaseOwner"=$3,"leaseUntil"=now()+interval \'90 seconds\',attempts=attempts+1 WHERE id=$1 AND "merchantId"=$2 AND "uploadState" IN (\'QUEUED\',\'PROCESSING\') AND ("leaseUntil" IS NULL OR "leaseUntil"<now()) AND ("nextAttemptAt" IS NULL OR "nextAttemptAt"<=now()) RETURNING *',
            [id, merchantId, lease],
          )
        ).rows[0],
    );
    if (!r) return;
    const cleanKey = `${merchantId}/${r.caseId}/${id}/${lease}`;
    try {
      const bytes = await this.storage.get(
        this.storage.env.S3_QUARANTINE_BUCKET,
        r.objectKey,
      );
      if (bytes.length !== Number(r.sizeBytes) || sha(bytes) !== r.sha256)
        throw Error('INTEGRITY_FAILURE');
      const scanned = await scan(bytes);
      if (!scanned.clean) throw Error('MALWARE_DETECTED');
      await validateIsolated(bytes, r.declaredType, r.filename);
      await this.db.transaction(merchantId, null, (tx) =>
        tx.query(
          'UPDATE "Evidence" SET "promotionKeys"=array_append("promotionKeys",$3) WHERE id=$1 AND "leaseOwner"=$2',
          [id, lease, cleanKey],
        ),
      );
      await this.storage.put(this.storage.env.S3_CLEAN_BUCKET, cleanKey, bytes);
      const done = await this.db.transaction(merchantId, null, async (tx) => {
        const changed = await tx.query(
          'UPDATE "Evidence" SET "uploadState"=\'AVAILABLE\',"scanStatus"=\'CLEAN\',"cleanObjectKey"=$3,"detectedType"="declaredType","scannerVersion"=$4,"scannedAt"=now(),"failureCode"=NULL,"leaseUntil"=NULL WHERE id=$1 AND "leaseOwner"=$2 AND "uploadState"=\'PROCESSING\' RETURNING id',
          [id, lease, cleanKey, scanned.version],
        );
        if (changed.rowCount)
          await tx.query(
            'INSERT INTO "CaseTimelineEvent"("merchantId","caseId",action,visibility,metadata) VALUES($1,$2,\'EVIDENCE_AVAILABLE\',\'CUSTOMER\',$3)',
            [merchantId, r.caseId, JSON.stringify({ evidenceId: id })],
          );
        return !!changed.rowCount;
      });
      if (!done)
        await this.storage.delete(this.storage.env.S3_CLEAN_BUCKET, cleanKey);
    } catch (e) {
      const code = e instanceof Error ? e.message : 'VALIDATION_FAILED';
      const permanent =
        /MALWARE|INTEGRITY|TYPE_MISMATCH|UNSUPPORTED|PDF_|TEXT_|Input|Invalid|corrupt|UTF-8/.test(
          code,
        );
      await this.db.transaction(merchantId, null, (tx) =>
        tx.query(
          'UPDATE "Evidence" SET "uploadState"=$3,"scanStatus"=$4::"EvidenceState","failureCode"=$5,"leaseUntil"=NULL,"nextAttemptAt"=now()+interval \'60 seconds\' WHERE id=$1 AND "leaseOwner"=$2',
          [
            id,
            lease,
            permanent ? 'REJECTED' : 'QUEUED',
            permanent ? 'REJECTED' : 'QUARANTINED',
            permanent
              ? 'VALIDATION_REJECTED'
              : 'SCANNER_OR_STORAGE_UNAVAILABLE',
          ],
        ),
      );
      try {
        await this.storage.delete(this.storage.env.S3_CLEAN_BUCKET, cleanKey);
      } catch {
        /* Cleanup retries are retained by the failed record. */
      }
      if (!permanent) throw Error('EVIDENCE_RETRY_REQUIRED', { cause: e });
    }
  }
  async cleanup(merchantId: string) {
    const artifacts = await this.db.transaction(
      merchantId,
      null,
      async (tx) =>
        (
          await tx.query(
            'SELECT id,"cleanObjectKey","promotionKeys" FROM "Evidence" WHERE cardinality("promotionKeys")>0 AND ("leaseUntil" IS NULL OR "leaseUntil"<now())',
          )
        ).rows,
    );
    for (const row of artifacts)
      for (const key of row.promotionKeys as string[])
        if (key !== row.cleanObjectKey) {
          await this.storage.delete(this.storage.env.S3_CLEAN_BUCKET, key);
          await this.db.transaction(merchantId, null, (tx) =>
            tx.query(
              'UPDATE "Evidence" SET "promotionKeys"=array_remove("promotionKeys",$2) WHERE id=$1 AND ("leaseUntil" IS NULL OR "leaseUntil"<now())',
              [row.id, key],
            ),
          );
        }
    const rows = await this.db.transaction(
      merchantId,
      null,
      async (tx) =>
        (
          await tx.query(
            'UPDATE "Evidence" SET "uploadState"=\'EXPIRED\',"leaseOwner"=gen_random_uuid(),"leaseUntil"=now()+interval \'60 seconds\' WHERE "merchantId"=$1 AND (("uploadState" IN (\'RESERVED\',\'UPLOADING\',\'UPLOADED\') AND "createdAt"<now()-interval \'24 hours\') OR ("uploadState" IN (\'FAILED\',\'REJECTED\',\'EXPIRED\') AND "createdAt"<now()-interval \'7 days\')) AND ("leaseUntil" IS NULL OR "leaseUntil"<now()) RETURNING *',
            [merchantId],
          )
        ).rows,
    );
    for (const r of rows) {
      await this.storage.delete(
        this.storage.env.S3_QUARANTINE_BUCKET,
        r.objectKey,
      );
      if (r.cleanObjectKey)
        await this.storage.delete(
          this.storage.env.S3_CLEAN_BUCKET,
          r.cleanObjectKey,
        );
      await this.db.transaction(merchantId, null, (tx) =>
        tx.query(
          'UPDATE "Evidence" SET "leaseUntil"=now()+interval \'7 days\' WHERE id=$1 AND "leaseOwner"=$2',
          [r.id, r.leaseOwner],
        ),
      );
    }
    return rows.length;
  }
}
