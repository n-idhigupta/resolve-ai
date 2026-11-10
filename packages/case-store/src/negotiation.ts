import type { QueryResultRow } from 'pg';
import {
  negotiationInputSchema,
  negotiationActionSchema,
  activeCaseStates,
  policyRulesSchema,
} from '@resolveai/shared';
import { validateNegotiation } from '@resolveai/policy-engine';
import { hashPayload, type Tx } from '@resolveai/payment-store';
import {
  CaseStore,
  member,
  event,
  replay,
  remember,
  fail,
  json,
  type Actor,
} from './cases.js';
// No provider or AI client is reachable from this module. All offers are human-authored.
export class NegotiationStore {
  constructor(readonly cases: CaseStore) {}
  async context(tx: Tx, c: QueryResultRow) {
    const capture = (
      await tx.query(
        'SELECT id,"grossMinor","refundedMinor","externalRefundedMinor","reservedMinor",currency,"providerStatus","reconciliationStatus","verifiedAt",version FROM "Capture" WHERE "orderId"=$1',
        [c.orderId],
      )
    ).rows[0];
    if (!capture) fail('VERIFIED_PAYMENT_REQUIRED', 422);
    const verified =
      !!capture.verifiedAt &&
      capture.providerStatus === 'COMPLETED' &&
      capture.reconciliationStatus === 'CURRENT' &&
      capture.currency === 'USD';
    const evidence = (
      await tx.query(
        'SELECT id,"scanStatus","uploadState","actualHash","detectedType" FROM "Evidence" WHERE "caseId"=$1 ORDER BY id',
        [c.id],
      )
    ).rows;
    const comments = (
      await tx.query(
        'SELECT id,body FROM "CaseComment" WHERE "caseId"=$1 AND visibility=\'CUSTOMER\' ORDER BY id',
        [c.id],
      )
    ).rows;
    const hash = hashPayload(
      json({
        status: c.status,
        revision: c.dataRevision,
        policy: c.policySnapshot,
        policyId: c.policyVersionId,
        capture,
        evidence,
        comments,
      }),
    );
    const types = evidence
      .filter((e) => e.scanStatus === 'CLEAN' && e.uploadState === 'AVAILABLE')
      .map((e) =>
        e.detectedType?.startsWith('image/')
          ? 'IMAGE'
          : e.detectedType === 'application/pdf'
            ? 'PDF'
            : 'TEXT',
      );
    const clauses = (
      await tx.query(
        'SELECT "rulesJson" FROM "PolicyClause" WHERE "policyVersionId"=$1',
        [c.policyVersionId],
      )
    ).rows
      .map((r) => policyRulesSchema.parse(r.rulesJson))
      .filter((r) => (r.applicableReasons as string[]).includes(c.reason));
    const replacementAllowed =
      clauses.length > 0 && clauses.every((r) => r.replacementAllowed);
    return { hash, capture, types, verified, replacementAllowed };
  }
  dto(p: QueryResultRow, c: QueryResultRow, hash: string, merchant: boolean) {
    return {
      id: p.id,
      caseId: p.caseId,
      sequence: p.sequence,
      rowVersion: p.rowVersion,
      kind: p.kind,
      amountMinor: p.amountMinor?.toString() ?? null,
      currency: p.currency,
      terms: p.termsJson,
      contentHash: p.contentHash,
      expiresAt: p.expiresAt,
      createdAt: p.createdAt,
      createdBy: p.createdBy,
      authorRole: p.authorRole,
      supersedesId: p.supersedesId,
      status: p.status,
      effectiveStatus:
        ['DRAFT', 'OFFERED'].includes(p.status) &&
        new Date(p.expiresAt).getTime() <= Date.now()
          ? 'EXPIRED'
          : p.status,
      stale:
        ['DRAFT', 'OFFERED', 'AGREED'].includes(p.status) &&
        (p.status !== 'AGREED' ||
          (activeCaseStates as readonly string[]).includes(c.status)) &&
        (p.contextHash !== hash ||
          !(activeCaseStates as readonly string[]).includes(c.status)),
      caseVersion: c.version,
      nonbinding: true,
      acceptanceAvailable:
        p.status === 'OFFERED' &&
        ['FULL_REFUND', 'PARTIAL_REFUND', 'REPLACEMENT'].includes(p.kind) &&
        p.contextHash === hash &&
        new Date(p.expiresAt).getTime() > Date.now(),
      ...(merchant ? { policyChecks: p.policyChecks } : {}),
    };
  }
  async list(a: Actor, id: string, limit = 25, cursor?: number) {
    return this.cases.tx(a, async (tx) => {
      const c = (
        await tx.query('SELECT * FROM "Case" WHERE id=$1 FOR SHARE', [id])
      ).rows[0];
      if (!c) fail('NOT_FOUND', 404);
      const merchant = !!(await member(tx, a)),
        context = await this.context(tx, c);
      const rows = (
        await tx.query(
          'SELECT * FROM "Proposal" WHERE "caseId"=$1 AND ($2::int IS NULL OR sequence<$2) ORDER BY sequence DESC LIMIT $3',
          [id, cursor ?? null, limit + 1],
        )
      ).rows;
      return {
        items: rows
          .slice(0, limit)
          .map((p) => this.dto(p, c, context.hash, merchant)),
        nextCursor: rows.length > limit ? rows[limit - 1].sequence : null,
        caseVersion: c.version,
      };
    });
  }
  async create(
    a: Actor,
    id: string,
    input: unknown,
    version: number,
    key: string,
    parent?: string,
  ) {
    const body = negotiationInputSchema.parse(input);
    return this.cases.tx(a, async (tx) => {
      const c = await this.cases.locked(tx, a, id),
        role = await member(tx, a),
        scope = 'negotiation-create:' + id;
      if (parent ? !!role : !role) fail('FORBIDDEN', 403);
      if (
        (
          await tx.query(
            "SELECT id FROM \"Settlement\" WHERE \"caseId\"=$1 AND state NOT IN ('CANCELLED','FAILED','COMPLETED')",
            [id],
          )
        ).rows[0]
      )
        fail('SETTLEMENT_PENDING');
      const prior = await replay(tx, a, scope, key, {
        body,
        parent: parent ?? null,
      });
      if (prior) return prior;
      if (c.version !== version) fail('STALE_VERSION');
      if (!(activeCaseStates as readonly string[]).includes(c.status))
        fail('CASE_CLOSED');
      let previous;
      if (parent) {
        previous = (
          await tx.query(
            'SELECT * FROM "Proposal" WHERE id=$1 AND "caseId"=$2',
            [parent, id],
          )
        ).rows[0];
        if (!previous) fail('NOT_FOUND', 404);
        if (
          c.currentProposalId !== parent ||
          previous.status !== 'OFFERED' ||
          new Date(previous.expiresAt).getTime() <= Date.now()
        )
          fail('OFFER_NOT_CURRENT');
      }
      const context = await this.context(tx, c);
      if (!context.verified) fail('VERIFIED_PAYMENT_REQUIRED', 422);
      if (body.kind === 'REPLACEMENT' && !context.replacementAllowed)
        fail('POLICY_REPLACEMENT_NOT_PERMITTED', 422);
      if (previous && previous.contextHash !== context.hash)
        fail('OFFER_STALE');
      let checks;
      try {
        checks = validateNegotiation(
          body,
          c.policySnapshot,
          {
            gross: BigInt(context.capture.grossMinor),
            completed: BigInt(context.capture.refundedMinor),
            external: BigInt(context.capture.externalRefundedMinor),
            reserved: BigInt(context.capture.reservedMinor),
          },
          context.types,
        );
      } catch (e) {
        fail(e instanceof Error ? e.message : 'POLICY_INVALID', 422);
      }
      // A separate draft does not withdraw an existing offer until an approver publishes it.
      if (parent)
        await tx.query(
          'UPDATE "Proposal" SET status=\'SUPERSEDED\',"rowVersion"="rowVersion"+1 WHERE id=$1',
          [parent],
        );
      const sequence = (
        await tx.query('SELECT negotiation_next_sequence($1) n', [id])
      ).rows[0].n;
      const content = {
        caseId: id,
        orderId: c.orderId,
        policyVersionId: c.policyVersionId,
        sequence,
        body,
        contextHash: context.hash,
        authorRole: role ? 'MERCHANT' : 'CUSTOMER',
        createdBy: a.userId,
        supersedesId: parent ?? null,
      };
      const p = (
        await tx.query(
          'INSERT INTO "Proposal"("merchantId","caseId","orderId","policyVersionId",sequence,"supersedesId",kind,"amountMinor",currency,"termsJson","contentHash","expiresAt","createdBy","authorRole","contextHash","policyChecks") VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *',
          [
            a.merchantId,
            id,
            c.orderId,
            c.policyVersionId,
            sequence,
            parent ?? null,
            body.kind,
            'amountMinor' in body ? body.amountMinor : null,
            'currency' in body ? body.currency : null,
            JSON.stringify(body),
            hashPayload(content),
            body.expiresAt,
            a.userId,
            role ? 'MERCHANT' : 'CUSTOMER',
            context.hash,
            JSON.stringify(checks),
          ],
        )
      ).rows[0];
      await tx.query(
        'UPDATE "Case" SET version=version+1,"updatedAt"=now(),"currentProposalId"=CASE WHEN $2::boolean THEN $3::uuid ELSE "currentProposalId" END WHERE id=$1',
        [id, !!parent, p.id],
      );
      await event(
        tx,
        a,
        id,
        parent ? 'COUNTEROFFER_CREATED' : 'PROPOSAL_DRAFTED',
        c.status,
        c.status,
        {
          proposalId: p.id,
          sequence,
          contentHash: p.contentHash,
          nonbinding: true,
        },
        role ? 'INTERNAL' : 'CUSTOMER',
      );
      const result = this.dto(
        p,
        { ...c, version: c.version + 1 },
        context.hash,
        !!role,
      );
      await remember(
        tx,
        a,
        scope,
        key,
        { body, parent: parent ?? null },
        result,
      );
      return result;
    });
  }
  async action(
    a: Actor,
    id: string,
    proposalId: string,
    input: unknown,
    version: number,
    key: string,
  ) {
    const body = negotiationActionSchema.parse(input);
    return this.cases.tx(a, async (tx) => {
      const c = await this.cases.locked(tx, a, id),
        role = await member(tx, a),
        scope = 'negotiation-action:' + proposalId;
      const p = (
        await tx.query('SELECT * FROM "Proposal" WHERE id=$1 AND "caseId"=$2', [
          proposalId,
          id,
        ])
      ).rows[0];
      if (!p) fail('NOT_FOUND', 404);
      const old = await replay(tx, a, scope, key, body);
      if (old) return old;
      if (c.version !== version) fail('STALE_VERSION');
      if (p.contentHash !== body.contentHash) fail('CONTENT_HASH_MISMATCH');
      const context = await this.context(tx, c),
        expired = new Date(p.expiresAt).getTime() <= Date.now();
      if (!['DRAFT', 'OFFERED'].includes(p.status)) fail('OFFER_TERMINAL');
      let status: string;
      if (body.action === 'EXPIRE') {
        if (!expired) fail('OFFER_NOT_EXPIRED');
        status = 'EXPIRED';
      } else {
        if (!(activeCaseStates as readonly string[]).includes(c.status))
          fail('CASE_CLOSED');
        if (expired) fail('OFFER_EXPIRED');
        if (body.action === 'PUBLISH') {
          if (!context.verified) fail('VERIFIED_PAYMENT_REQUIRED', 422);
          if (p.kind === 'REPLACEMENT' && !context.replacementAllowed)
            fail('POLICY_REPLACEMENT_NOT_PERMITTED', 422);
          if (!role || !['OWNER', 'APPROVER'].includes(role))
            fail('FORBIDDEN', 403);
          if (p.status !== 'DRAFT' || p.authorRole !== 'MERCHANT')
            fail('MERCHANT_DRAFT_REQUIRED');
          if (p.contextHash !== context.hash) fail('OFFER_STALE');
          try {
            validateNegotiation(
              negotiationInputSchema.parse(p.termsJson),
              c.policySnapshot,
              {
                gross: BigInt(context.capture.grossMinor),
                completed: BigInt(context.capture.refundedMinor),
                external: BigInt(context.capture.externalRefundedMinor),
                reserved: BigInt(context.capture.reservedMinor),
              },
              context.types,
            );
          } catch (e) {
            fail(e instanceof Error ? e.message : 'POLICY_INVALID', 422);
          }
          await tx.query(
            'UPDATE "Proposal" SET status=\'SUPERSEDED\',"rowVersion"="rowVersion"+1 WHERE "caseId"=$1 AND id<>$2 AND (status=\'OFFERED\' OR (status=\'DRAFT\' AND "authorRole"=\'CUSTOMER\'))',
            [id, proposalId],
          );
          await tx.query(
            'INSERT INTO "ProposalPublication"("merchantId","caseId","proposalId","publishedBy") VALUES($1,$2,$3,$4)',
            [a.merchantId, id, p.id, a.userId],
          );
          status = 'OFFERED';
        } else if (body.action === 'WITHDRAW') {
          if (role ? p.authorRole !== 'MERCHANT' : p.createdBy !== a.userId)
            fail('FORBIDDEN', 403);
          status = 'WITHDRAWN';
        } else {
          if (
            role
              ? p.authorRole !== 'CUSTOMER'
              : p.status !== 'OFFERED' || c.currentProposalId !== p.id
          )
            fail('ACTION_NOT_ALLOWED');
          status = 'REJECTED';
        }
      }
      const updated = (
        await tx.query(
          'UPDATE "Proposal" SET status=$2::"ProposalState","rowVersion"="rowVersion"+1 WHERE id=$1 RETURNING *',
          [p.id, status],
        )
      ).rows[0];
      await tx.query(
        'UPDATE "Case" SET version=version+1,"updatedAt"=now(),"currentProposalId"=CASE WHEN $2=\'OFFERED\' THEN $3::uuid WHEN "currentProposalId"=$3 THEN NULL ELSE "currentProposalId" END WHERE id=$1',
        [id, status, p.id],
      );
      await event(
        tx,
        a,
        id,
        'PROPOSAL_' + status,
        c.status,
        c.status,
        {
          proposalId: p.id,
          contentHash: p.contentHash,
          reason: body.reason,
          previousProposalStatus: p.status,
          newProposalStatus: status,
          nonbinding: true,
        },
        p.authorRole === 'MERCHANT' &&
          p.status === 'DRAFT' &&
          status !== 'OFFERED'
          ? 'INTERNAL'
          : 'CUSTOMER',
      );
      const result = this.dto(
        updated,
        { ...c, version: c.version + 1 },
        context.hash,
        !!role,
      );
      await remember(tx, a, scope, key, body, result);
      return result;
    });
  }
}
