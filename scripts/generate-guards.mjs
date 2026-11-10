import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
const schema = readFileSync('apps/api/prisma/schema.prisma', 'utf8');
const tables = [...schema.matchAll(/model (\w+) \{/g)].map((x) => x[1]);
let sql = `REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO resolve_runtime,resolve_test;
`;
const check = (table, name, expr) => {
  sql += `ALTER TABLE "${table}" ADD CONSTRAINT "${name}" CHECK (${expr});\n`;
};
for (const [table, block] of [
  ...schema.matchAll(/model (\w+) \{([\s\S]*?)\n\}/g),
].map((x) => [x[1], x[2]])) {
  for (const m of block.matchAll(/^ (\w+) BigInt/gm))
    check(
      table,
      `${table}_${m[1]}_bounds`,
      `"${m[1]}" BETWEEN 0 AND 999999999999`,
    );
  if (/ currency String/.test(block))
    check(table, `${table}_currency`, `"currency" = 'USD'`);
}
check(
  'Capture',
  'capture_balance',
  '"refundedMinor" + "externalRefundedMinor" + "reservedMinor" <= "grossMinor"',
);
check('RefundOperation', 'refund_positive', '"amountMinor" > 0');
check('ExternalRefund', 'external_positive', '"amountMinor" > 0');
check('OrderItem', 'quantity_positive', '"quantity" > 0');
check(
  'EvidenceChunk',
  'chunk_bounds',
  '"charStart" >= 0 AND "charEnd" >= "charStart" AND ("page" IS NULL OR "page">0)',
);
check(
  'Evidence',
  'evidence_limit',
  '"sizeBytes" > 0 AND "sizeBytes" <= 10485760',
);
check(
  'FindingReference',
  'exact_reference',
  'num_nonnulls("evidenceChunkId","orderId","captureId","policyClauseId") = 1',
);
check(
  'PaymentAttempt',
  'one_operation',
  'num_nonnulls("refundOperationId","checkoutOperationId")=1 AND "attemptNo">0',
);
check(
  'Proposal',
  'proposal_money',
  `(("kind" IN ('FULL_REFUND','PARTIAL_REFUND') AND "amountMinor">0 AND "currency" IS NOT NULL) OR ("kind" NOT IN ('FULL_REFUND','PARTIAL_REFUND') AND "amountMinor" IS NULL AND "currency" IS NULL))`,
);
sql += `CREATE UNIQUE INDEX "case_one_active" ON "Case" ("merchantId","orderId") WHERE "status" NOT IN ('RESOLVED','CLOSED_WITHOUT_AGREEMENT');
CREATE UNIQUE INDEX "checkout_active_kind" ON "CheckoutOperation" ("merchantId","orderId","kind") WHERE "state" <> 'FAILED';
CREATE UNIQUE INDEX "attempt_refund_no" ON "PaymentAttempt" ("refundOperationId","attemptNo") WHERE "refundOperationId" IS NOT NULL;
CREATE UNIQUE INDEX "attempt_checkout_no" ON "PaymentAttempt" ("checkoutOperationId","attemptNo") WHERE "checkoutOperationId" IS NOT NULL;
CREATE UNIQUE INDEX "order_owner_identity" ON "Order" ("merchantId",id,"customerUserId");
ALTER TABLE "CustomerOrder" ADD CONSTRAINT "ownership_matches_order" FOREIGN KEY ("merchantId","orderId","userId") REFERENCES "Order" ("merchantId",id,"customerUserId");
CREATE UNIQUE INDEX "capture_currency_identity" ON "Capture" ("merchantId",id,currency);
ALTER TABLE "RefundOperation" ADD CONSTRAINT "refund_capture_currency" FOREIGN KEY ("merchantId","captureId",currency) REFERENCES "Capture" ("merchantId",id,currency);
CREATE INDEX "case_worklist" ON "Case" ("merchantId",status,"createdAt" DESC,id);
CREATE INDEX "order_customer" ON "Order" ("merchantId","customerUserId","createdAt" DESC,id);
CREATE INDEX "membership_discovery" ON "Membership" ("userId",active);
CREATE INDEX "evidence_scan" ON "Evidence" ("merchantId","caseId","scanStatus");
CREATE INDEX "analysis_case" ON "Analysis" ("merchantId","caseId","createdAt" DESC);
CREATE INDEX "audit_timeline" ON "AuditEvent" ("merchantId","aggregateType","aggregateId","occurredAt",id);
CREATE INDEX "refund_due" ON "RefundOperation" (state,"nextAttemptAt");
CREATE INDEX "outbox_due" ON "OutboxEvent" ("availableAt") WHERE "deliveredAt" IS NULL;
CREATE INDEX "inbox_due" ON "WebhookInbox" ("processingStatus","receivedAt");
CREATE FUNCTION reject_mutation() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$ BEGIN RAISE EXCEPTION 'Immutable record'; END $$;
CREATE TRIGGER audit_immutable BEFORE UPDATE OR DELETE ON "AuditEvent" FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER approval_immutable BEFORE UPDATE OR DELETE ON "Approval" FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE FUNCTION guard_immutable_content() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Immutable content'; END IF;
 IF TG_TABLE_NAME='Proposal' AND (to_jsonb(NEW)-ARRAY['status','rowVersion','completedAt']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','rowVersion','completedAt']) THEN RAISE EXCEPTION 'Immutable proposal content'; END IF;
 IF TG_TABLE_NAME='PolicyVersion' AND (to_jsonb(OLD)->>'publishedAt') IS NOT NULL AND to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD) THEN RAISE EXCEPTION 'Published policy is immutable'; END IF;
 IF TG_TABLE_NAME='Analysis' AND (to_jsonb(OLD)->>'status')='SUCCEEDED' AND (to_jsonb(NEW)-'status') IS DISTINCT FROM (to_jsonb(OLD)-'status') THEN RAISE EXCEPTION 'Successful analysis is immutable'; END IF;
 IF TG_TABLE_NAME='Evidence' AND (to_jsonb(OLD)->>'scanStatus')='CLEAN' AND (to_jsonb(NEW)->'objectKey',to_jsonb(NEW)->'objectVersion',to_jsonb(NEW)->'sha256') IS DISTINCT FROM (to_jsonb(OLD)->'objectKey',to_jsonb(OLD)->'objectVersion',to_jsonb(OLD)->'sha256') THEN RAISE EXCEPTION 'Validated evidence is immutable'; END IF;
 RETURN NEW;
END $$;
`;
for (const table of ['Proposal', 'PolicyVersion', 'Analysis', 'Evidence'])
  sql += `CREATE TRIGGER "${table}_content_guard" BEFORE UPDATE OR DELETE ON "${table}" FOR EACH ROW EXECUTE FUNCTION guard_immutable_content();\n`;
sql += `CREATE FUNCTION guard_policy_clause() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE p uuid; m uuid;
BEGIN
 p:=CASE WHEN TG_OP='DELETE' THEN OLD."policyVersionId" ELSE NEW."policyVersionId" END;
 m:=CASE WHEN TG_OP='DELETE' THEN OLD."merchantId" ELSE NEW."merchantId" END;
 PERFORM 1 FROM public."PolicyVersion" WHERE id=p AND "merchantId"=m AND "publishedAt" IS NOT NULL;
 IF FOUND THEN RAISE EXCEPTION 'Published clauses are immutable'; END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END $$;
CREATE TRIGGER policy_clause_guard BEFORE INSERT OR UPDATE OR DELETE ON "PolicyClause" FOR EACH ROW EXECUTE FUNCTION guard_policy_clause();
`;
// Defaults deny absent context; authenticated application remains the trust boundary for actor GUCs.
const user = `NULLIF(current_setting('app.user_id',true),'')::uuid`;
const merchant = `NULLIF(current_setting('app.merchant_id',true),'')::uuid`;
const staff = `EXISTS (SELECT 1 FROM public."Membership" m WHERE m."merchantId"=${merchant} AND m."userId"=${user} AND m.active)`;
const ownOrder = (field) =>
  `EXISTS (SELECT 1 FROM public."CustomerOrder" co WHERE co."merchantId"=${merchant} AND co."orderId"=${field} AND co."userId"=${user})`;
const ownCase = (field) =>
  `EXISTS (SELECT 1 FROM public."Case" c WHERE c."merchantId"=${merchant} AND c.id=${field})`;
const customer = {
  Order: ownOrder('"Order".id'),
  CustomerOrder: `"userId"=${user}`,
  Case: ownOrder('"Case"."orderId"'),
  OrderItem: ownOrder('"OrderItem"."orderId"'),
  Capture: ownOrder('"Capture"."orderId"'),
  CheckoutOperation: ownOrder('"CheckoutOperation"."orderId"'),
  Evidence: ownCase('"Evidence"."caseId"'),
  Analysis: ownCase('"Analysis"."caseId"'),
  Proposal: ownCase('"Proposal"."caseId"'),
  RefundOperation: ownOrder('"RefundOperation"."orderId"'),
  PolicyVersion: `EXISTS (SELECT 1 FROM public."Order" o WHERE o."merchantId"=${merchant} AND o."purchasePolicyVersionId"="PolicyVersion".id)`,
  PolicyClause: `EXISTS (SELECT 1 FROM public."PolicyVersion" p WHERE p.id="PolicyClause"."policyVersionId" AND p."merchantId"=${merchant})`,
  EvidenceChunk: `EXISTS(SELECT 1 FROM public."Evidence" e WHERE e.id="EvidenceChunk"."evidenceId" AND e."merchantId"=${merchant})`,
};
for (const table of tables) {
  if (['User', 'Session'].includes(table)) continue;
  sql += `ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY;\nALTER TABLE "${table}" FORCE ROW LEVEL SECURITY;\nCREATE POLICY migration_access ON "${table}" TO resolve_migrator USING(true) WITH CHECK(true);\n`;
  if (table === 'Membership') {
    sql += `CREATE POLICY own_memberships ON "Membership" FOR SELECT TO resolve_runtime,resolve_test USING("userId"=${user});\n`;
    continue;
  }
  if (table === 'Merchant') {
    sql += `CREATE POLICY merchant_read ON "Merchant" FOR SELECT TO resolve_runtime,resolve_test USING(id=${merchant} AND (${staff} OR EXISTS(SELECT 1 FROM public."CustomerOrder" co WHERE co."merchantId"=${merchant} AND co."userId"=${user})));\n`;
    continue;
  }
  if (table === 'CustomerOrder') {
    sql += `CREATE POLICY own_order_discovery ON "CustomerOrder" FOR SELECT TO resolve_runtime,resolve_test USING("userId"=${user});\n`;
    continue;
  }
  const scope = `"merchantId"=${merchant}`;
  sql += `CREATE POLICY tenant_read ON "${table}" FOR SELECT TO resolve_runtime,resolve_test USING(${scope} AND (${staff}${customer[table] ? ' OR ' + customer[table] : ''}));\n`;
  if (
    ![
      'PolicyVersion',
      'PolicyClause',
      'Approval',
      'PaymentAccount',
      'CustomerOrder',
      'Order',
      'OrderItem',
      'Evidence',
      'EvidenceChunk',
      'Analysis',
      'Finding',
      'FindingReference',
      'Proposal',
      'FormalDispute',
    ].includes(table)
  ) {
    const approver = ['RefundOperation', 'Capture'].includes(table)
      ? ` AND EXISTS(SELECT 1 FROM public."Membership" a WHERE a."merchantId"=${merchant} AND a."userId"=${user} AND a.active AND a.role IN ('OWNER','APPROVER'))`
      : '';
    sql += `CREATE POLICY tenant_write ON "${table}" FOR INSERT TO resolve_runtime,resolve_test WITH CHECK(${scope} AND ${staff}${approver});\n`;
    if (table !== 'AuditEvent')
      sql += `CREATE POLICY tenant_update ON "${table}" FOR UPDATE TO resolve_runtime,resolve_test USING(${scope} AND ${staff}${approver}) WITH CHECK(${scope} AND ${staff}${approver});\n`;
  }
}
sql += `GRANT SELECT ON ALL TABLES IN SCHEMA public TO resolve_runtime,resolve_test;
REVOKE ALL ON "_prisma_migrations" FROM resolve_runtime,resolve_test;
GRANT INSERT,UPDATE ON "Session" TO resolve_runtime,resolve_test;
GRANT INSERT ON "AuditEvent" TO resolve_runtime,resolve_test;
GRANT INSERT,UPDATE ON "RefundOperation","Capture","CheckoutOperation","PaymentAttempt","ExternalRefund","WebhookInbox","WebhookReceipt","OutboxEvent","IdempotencyRecord" TO resolve_runtime,resolve_test;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;
`;
mkdirSync('apps/api/prisma/migrations/0002_security', { recursive: true });
writeFileSync('apps/api/prisma/migrations/0002_security/migration.sql', sql);
console.log('Generated financial guards, grants and RLS policies.');
