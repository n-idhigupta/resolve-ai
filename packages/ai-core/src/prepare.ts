import { randomUUID } from 'node:crypto';
import {
  PaymentDatabase,
  encryptReceipt,
  decryptReceipt,
  hashPayload,
} from '@resolveai/payment-store';
import { PrivateStorage, sha } from '@resolveai/case-store';
import { extractEvidence } from './extraction.js';
import { redact, type AISource } from './contracts.js';
import { preparedRequest, type BaseContext } from './service.js';
export const EXTRACTOR_VERSION = 'local-pdfjs6-sharp035-v1';
export class ContextPreparer {
  constructor(
    readonly db: PaymentDatabase,
    readonly storage: PrivateStorage,
    readonly key: string,
  ) {}
  async process(merchantId: string, id: string) {
    const lease = randomUUID();
    const row = await this.db.transaction(
      merchantId,
      null,
      async (tx) =>
        (
          await tx.query(
            'UPDATE "AIContext" SET state=\'PREPARING\',"leaseOwner"=$3,"leaseUntil"=now()+interval \'3 minutes\',attempts=attempts+1 WHERE id=$1 AND "merchantId"=$2 AND state IN (\'QUEUED\',\'PREPARING\') AND attempts<3 AND ("leaseUntil" IS NULL OR "leaseUntil"<now()) AND "nextAttemptAt"<=now() RETURNING *',
            [id, merchantId, lease],
          )
        ).rows[0],
    );
    if (!row) return;
    try {
      const fresh = await this.db.transaction(
        merchantId,
        null,
        async (tx) =>
          (await tx.query('SELECT ai_context_fresh($1) AS fresh', [id])).rows[0]
            .fresh,
      );
      if (!fresh) throw Error('STALE');
      const base = JSON.parse(
          decryptReceipt(row.baseEncrypted, this.key),
        ) as BaseContext,
        sources = [...base.sources],
        images: { sourceId: string; dataUrl: string }[] = [],
        available: string[] = [],
        omissions = [...base.omissions];
      let chars = sources.reduce((n, s) => n + s.text.length, 0);
      for (const evidence of base.selected) {
        try {
          const current = await this.db.transaction(
            merchantId,
            null,
            async (tx) =>
              (
                await tx.query(
                  'SELECT * FROM "Evidence" WHERE id=$1 AND "caseId"=$2 AND "scanStatus"=\'CLEAN\' AND "uploadState"=\'AVAILABLE\' AND "scannedAt" IS NOT NULL',
                  [evidence.id, row.caseId],
                )
              ).rows[0],
          );
          if (
            !current ||
            current.sha256 !== evidence.hash ||
            current.cleanObjectKey !== evidence.key
          )
            throw Error('EVIDENCE_CHANGED');
          const bytes = await this.storage.get(
            this.storage.env.S3_CLEAN_BUCKET,
            evidence.key,
          );
          if (sha(bytes) !== evidence.hash) throw Error('EVIDENCE_INTEGRITY');
          const extraction = await extractEvidence(bytes, evidence.mime);
          omissions.push(...extraction.omissions);
          const redactedPages = extraction.pages.map((p) => ({
            ...p,
            text: redact(p.text),
          }));
          const extracted = await this.db.transaction(
            merchantId,
            null,
            async (tx) => {
              const r = await tx.query(
                'INSERT INTO "EvidenceExtraction"("merchantId","caseId","evidenceId","sourceHash","extractorVersion",status,"metadataJson","textEncrypted") VALUES($1,$2,$3,$4,$5,\'SUCCEEDED\',$6,$7) ON CONFLICT("merchantId","evidenceId","sourceHash","extractorVersion",status) DO NOTHING RETURNING id',
                [
                  merchantId,
                  row.caseId,
                  evidence.id,
                  evidence.hash,
                  EXTRACTOR_VERSION,
                  JSON.stringify({
                    pages: redactedPages.map((p) => p.page),
                    imagePages: extraction.images.map((p) => p.page),
                    omissions: extraction.omissions,
                  }),
                  encryptReceipt(JSON.stringify(redactedPages), this.key),
                ],
              );
              return (
                r.rows[0] ??
                (
                  await tx.query(
                    'SELECT id FROM "EvidenceExtraction" WHERE "evidenceId"=$1 AND "sourceHash"=$2 AND "extractorVersion"=$3 AND status=\'SUCCEEDED\'',
                    [evidence.id, evidence.hash, EXTRACTOR_VERSION],
                  )
                ).rows[0]
              );
            },
          );
          let ordinal = 0;
          for (const page of redactedPages) {
            if (chars + page.text.length > 100000) {
              omissions.push('TEXT_TRUNCATED');
              break;
            }
            chars += page.text.length;
            const source: AISource = {
              key: 'S' + String(sources.length + 1).padStart(3, '0'),
              kind: 'DOCUMENT_OBSERVATION',
              text: page.text,
              reference: { extractionId: extracted.id },
              page: page.page,
              hash: hashPayload(page.text),
            };
            sources.push(source);
            await this.db.transaction(merchantId, null, (tx) =>
              tx.query(
                'INSERT INTO "EvidenceChunk"("merchantId","evidenceId","extractionId",ordinal,page,"charStart","charEnd","textHash","sanitizedText") VALUES($1,$2,$3,$4,$5,0,$6,$7,$8) ON CONFLICT DO NOTHING',
                [
                  merchantId,
                  evidence.id,
                  extracted.id,
                  ordinal++,
                  page.page,
                  page.text.length,
                  source.hash,
                  '',
                ],
              ),
            );
          }
          for (const image of extraction.images) {
            if (images.length >= 4) {
              omissions.push('IMAGE_LIMIT');
              break;
            }
            const source: AISource = {
              key: 'S' + String(sources.length + 1).padStart(3, '0'),
              kind: 'DOCUMENT_OBSERVATION',
              text: 'Image observation only; not verified transaction evidence.',
              reference: { extractionId: extracted.id },
              page: image.page,
              hash: hashPayload(image.dataUrl),
            };
            sources.push(source);
            images.push({ sourceId: source.key, dataUrl: image.dataUrl });
          }
          available.push(
            evidence.mime.startsWith('image/')
              ? 'IMAGE'
              : evidence.mime === 'application/pdf'
                ? 'PDF'
                : 'TEXT',
          );
        } catch {
          omissions.push('EVIDENCE_EXTRACTION_UNAVAILABLE');
          await this.db.transaction(merchantId, null, (tx) =>
            tx.query(
              'INSERT INTO "EvidenceExtraction"("merchantId","caseId","evidenceId","sourceHash","extractorVersion",status,"metadataJson","textEncrypted") VALUES($1,$2,$3,$4,$5,\'FAILED\',$6,\'\') ON CONFLICT DO NOTHING',
              [
                merchantId,
                row.caseId,
                evidence.id,
                evidence.hash,
                EXTRACTOR_VERSION,
                JSON.stringify({ errorCode: 'EXTRACTION_UNAVAILABLE' }),
              ],
            ),
          );
        }
      }
      if (chars > 100000) {
        omissions.push('CONTEXT_TRUNCATED');
        let remaining = 100000;
        for (const s of sources) {
          s.text = s.text.slice(0, Math.max(0, remaining));
          remaining -= s.text.length;
          s.hash = hashPayload(s.text);
        }
      }
      const policy = await this.db.transaction(
        merchantId,
        null,
        async (tx) =>
          (
            await tx.query(
              'SELECT "modelId" FROM "AISharingPolicy" WHERE id=$1',
              [row.sharingPolicyId],
            )
          ).rows[0],
      );
      const request = preparedRequest(
        base,
        sources,
        images,
        available,
        omissions,
        policy.modelId,
      );
      if (Buffer.byteLength(JSON.stringify(request)) > 12000000)
        throw Error('CONTEXT_TOO_LARGE');
      const consentHash = hashPayload({
        manifest: row.manifest,
        sharingPolicyId: row.sharingPolicyId,
        request,
        extractor: EXTRACTOR_VERSION,
      });
      await this.db.transaction(merchantId, null, async (tx) => {
        const current = (
          await tx.query('SELECT ai_context_fresh($1) AS fresh', [id])
        ).rows[0].fresh;
        await tx.query(
          'UPDATE "AIContext" SET state=$3,"requestEncrypted"=$4,"catalogEncrypted"=$5,"consentHash"=$6,"leaseUntil"=NULL WHERE id=$1 AND "leaseOwner"=$2',
          [
            id,
            lease,
            current ? 'READY' : 'STALE',
            encryptReceipt(JSON.stringify(request), this.key),
            encryptReceipt(JSON.stringify(sources), this.key),
            consentHash,
          ],
        );
      });
    } catch (e) {
      const code =
        e instanceof Error && e.message === 'STALE'
          ? 'STALE'
          : 'PREPARATION_FAILED';
      await this.db.transaction(merchantId, null, (tx) =>
        tx.query(
          'UPDATE "AIContext" SET state=$3,"errorCode"=$4,"leaseUntil"=NULL,"nextAttemptAt"=now()+interval \'30 seconds\' WHERE id=$1 AND "leaseOwner"=$2',
          [
            id,
            lease,
            code === 'STALE'
              ? 'STALE'
              : row.attempts >= 3
                ? 'FAILED'
                : 'QUEUED',
            code,
          ],
        ),
      );
    }
  }
}
