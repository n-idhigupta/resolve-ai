import { mkdirSync, writeFileSync } from 'node:fs';
const enums = {
  Role: ['OWNER', 'APPROVER', 'AGENT'],
  UserStatus: ['ACTIVE', 'DISABLED'],
  MerchantStatus: ['ACTIVE', 'SUSPENDED'],
  OrderStatus: ['UNPAID', 'PENDING', 'PAID', 'CANCELLED'],
  OperationKind: ['CREATE', 'CAPTURE'],
  OperationState: [
    'READY',
    'IN_FLIGHT',
    'PENDING',
    'UNKNOWN',
    'COMPLETED',
    'FAILED',
  ],
  CaseStatus: [
    'OPEN',
    'INVESTIGATING',
    'NEGOTIATING',
    'RESOLUTION_PENDING',
    'RESOLVED',
    'ESCALATED',
    'CLOSED_WITHOUT_AGREEMENT',
  ],
  ComplaintReason: [
    'ITEM_NOT_RECEIVED',
    'NOT_AS_DESCRIBED',
    'DAMAGED',
    'DUPLICATE_CHARGE',
    'OTHER',
  ],
  EvidenceState: ['QUARANTINED', 'CLEAN', 'REJECTED', 'FAILED'],
  ExtractionState: ['PENDING', 'SUCCEEDED', 'FAILED'],
  AnalysisState: [
    'QUEUED',
    'RUNNING',
    'SUCCEEDED',
    'NEEDS_REVIEW',
    'FAILED',
    'STALE',
  ],
  ProposalKind: [
    'FULL_REFUND',
    'PARTIAL_REFUND',
    'REPLACEMENT',
    'REQUEST_EVIDENCE',
    'ESCALATION',
  ],
  ProposalState: [
    'DRAFT',
    'OFFERED',
    'AGREED',
    'EXECUTING',
    'FULFILLED',
    'REJECTED',
    'EXPIRED',
    'SUPERSEDED',
  ],
  ActorRole: ['CUSTOMER', 'MERCHANT'],
  Decision: ['ACCEPT', 'REJECT'],
  VerificationState: ['UNVERIFIED', 'VERIFIED', 'REJECTED'],
  ProcessingState: ['PENDING', 'PROCESSED', 'FAILED'],
  ReconciliationState: ['CURRENT', 'FROZEN'],
};
// u UUID, t text, b bigint, i integer, d timestamp, j JSON, f boolean.
// ? nullable; =literal default. Generated files are checked in; regenerate explicitly.
const specs = {
  Merchant: 'name:t status:MerchantStatus=ACTIVE defaultCurrency:t=USD',
  User: 'normalizedEmail:t passwordHash:t status:UserStatus=ACTIVE',
  Session:
    'userId:u tokenHash:t authenticatedAt:d expiresAt:d lastSeenAt:d revokedAt:d?',
  Membership: 'userId:u role:Role active:f=true',
  PaymentAccount:
    'environment:t providerMerchantId:t credentialSecretRef:t webhookId:t? accountKey:t',
  PolicyVersion: 'sequence:i contentHash:t effectiveFrom:d publishedAt:d?',
  PolicyClause: 'policyVersionId:u clauseKey:t text:t rulesJson:j',
  Order:
    'customerUserId:u purchasePolicyVersionId:u merchantReference:t amountMinor:b currency:t status:OrderStatus=UNPAID version:i=0 updatedAt:d=now',
  CustomerOrder: 'orderId:u userId:u',
  OrderItem:
    'orderId:u description:t quantity:i unitMinor:b taxMinor:b=0 shippingMinor:b=0 currency:t',
  CheckoutOperation:
    'orderId:u accountId:u kind:OperationKind requestId:u requestHash:t providerOrderId:t? state:OperationState=READY attemptCount:i=0 leaseOwner:t? leaseUntil:d? nextAttemptAt:d? completedAt:d? lastErrorCode:t? version:i=0',
  Capture:
    'orderId:u accountId:u providerCaptureId:t providerOrderId:t grossMinor:b currency:t providerStatus:t completedAt:d reservedMinor:b=0 refundedMinor:b=0 externalRefundedMinor:b=0 reconciliationStatus:ReconciliationState=CURRENT discrepancyJson:j? version:i=0',
  Case: 'orderId:u openedBy:u policyVersionId:u reason:ComplaintReason description:t status:CaseStatus=OPEN currentProposalId:u? dataRevision:i=0 version:i=0 updatedAt:d=now resolvedAt:d?',
  Evidence:
    'caseId:u uploaderUserId:u objectKey:t objectVersion:t? filename:t detectedType:t? sizeBytes:b sha256:t scanStatus:EvidenceState=QUARANTINED extractionStatus:ExtractionState=PENDING',
  EvidenceChunk:
    'evidenceId:u ordinal:i page:i? charStart:i charEnd:i textHash:t sanitizedText:t',
  Analysis:
    'caseId:u snapshotHash:t snapshotJson:j modelId:t promptVersion:t schemaVersion:t policyEngineVersion:t status:AnalysisState=QUEUED reviewReasons:j latencyMs:i? tokenUsage:j?',
  Finding: 'analysisId:u kind:t statement:t certaintyBand:t reviewStatus:t',
  FindingReference:
    'findingId:u evidenceChunkId:u? orderId:u? captureId:u? policyClauseId:u? recordField:t? start:i? end:i? quoteHash:t?',
  Proposal:
    'caseId:u orderId:u analysisId:u? policyVersionId:u sequence:i supersedesId:u? kind:ProposalKind amountMinor:b? currency:t? termsJson:j contentHash:t expiresAt:d status:ProposalState=DRAFT rowVersion:i=0 completedAt:d?',
  Approval:
    'proposalId:u actorUserId:u actorRole:ActorRole decision:Decision contentHash:t policyVersionId:u decidedAt:d authenticationContext:j',
  RefundOperation:
    'captureId:u proposalId:u orderId:u accountId:u amountMinor:b currency:t providerRequestId:u requestHash:t providerRefundId:t? state:OperationState=READY attemptCount:i=0 leaseOwner:t? leaseUntil:d? nextAttemptAt:d? lastErrorCode:t? version:i=0 completedAt:d? updatedAt:d=now',
  PaymentAttempt:
    'refundOperationId:u? checkoutOperationId:u? attemptNo:i requestHash:t startedAt:d finishedAt:d? transportOutcome:t? providerDebugId:t?',
  ExternalRefund:
    'captureId:u accountId:u providerRefundId:t amountMinor:b currency:t state:OperationState completedAt:d?',
  FormalDispute:
    'caseId:u? accountId:u providerDisputeId:t state:t lastSyncedAt:d?',
  WebhookInbox:
    'accountId:u providerEventId:t verificationStatus:VerificationState=UNVERIFIED processingStatus:ProcessingState=PENDING attempts:i=0 receivedAt:d=now',
  WebhookReceipt:
    'inboxId:u originalPayloadEncryptedRef:t payloadHash:t redactedHeaders:j verificationStatus:VerificationState=UNVERIFIED receivedAt:d=now',
  AuditEvent:
    'aggregateType:t aggregateId:u actorType:t actorId:u? action:t visibility:t correlationId:t redactedMetadata:j occurredAt:d=now',
  OutboxEvent:
    'aggregateType:t aggregateId:u eventType:t schemaVersion:i payloadIds:j dedupeKey:t availableAt:d=now leaseUntil:d? deliveredAt:d? attempts:i=0',
  IdempotencyRecord:
    'actorId:u routeScope:t key:t requestHash:t operationId:u? resultRef:j? expiresAt:d',
};
const globals = new Set(['Merchant', 'User', 'Session']);
const fields = {};
for (const [name, spec] of Object.entries(specs))
  fields[name] = [
    'id:u=uuid',
    ...(!globals.has(name) ? ['merchantId:u'] : []),
    'createdAt:d=now',
    ...spec.split(' '),
  ].map((s) => {
    const [name, descriptor] = s.split(':');
    const [nullableType, def] = descriptor.split('=');
    return {
      name,
      type: nullableType.replace('?', ''),
      optional: nullableType.includes('?'),
      def,
    };
  });
const unique = {
  User: [['normalizedEmail']],
  Session: [['tokenHash']],
  Membership: [['merchantId', 'userId']],
  PaymentAccount: [['environment', 'providerMerchantId'], ['accountKey']],
  PolicyVersion: [['merchantId', 'sequence']],
  PolicyClause: [['merchantId', 'policyVersionId', 'clauseKey']],
  Order: [['merchantId', 'merchantReference']],
  CustomerOrder: [['merchantId', 'orderId', 'userId']],
  Capture: [
    ['accountId', 'providerCaptureId'],
    ['merchantId', 'orderId'],
    ['merchantId', 'id', 'orderId'],
    ['merchantId', 'id', 'accountId'],
  ],
  Case: [['merchantId', 'id', 'orderId']],
  Evidence: [['objectKey']],
  EvidenceChunk: [['merchantId', 'evidenceId', 'ordinal']],
  Proposal: [
    ['merchantId', 'caseId', 'sequence'],
    ['merchantId', 'id', 'caseId'],
    ['merchantId', 'id', 'orderId'],
  ],
  RefundOperation: [
    ['merchantId', 'proposalId'],
    ['accountId', 'providerRequestId'],
    ['accountId', 'providerRefundId'],
  ],
  CheckoutOperation: [['accountId', 'requestId']],
  ExternalRefund: [['accountId', 'providerRefundId']],
  FormalDispute: [['accountId', 'providerDisputeId']],
  WebhookInbox: [['accountId', 'providerEventId']],
  OutboxEvent: [['merchantId', 'dedupeKey']],
  IdempotencyRecord: [['merchantId', 'actorId', 'routeScope', 'key']],
};
const links = [];
const link = (child, col, parent) =>
  links.push({ child, cols: [col], parent, refs: ['id'] });
const tenantLink = (child, col, parent) =>
  links.push({
    child,
    cols: ['merchantId', col],
    parent,
    refs: ['merchantId', 'id'],
  });
for (const name of Object.keys(specs))
  if (!globals.has(name)) link(name, 'merchantId', 'Merchant');
for (const [child, col] of [
  ['Session', 'userId'],
  ['Membership', 'userId'],
  ['Order', 'customerUserId'],
  ['CustomerOrder', 'userId'],
  ['Case', 'openedBy'],
  ['Evidence', 'uploaderUserId'],
  ['Approval', 'actorUserId'],
  ['IdempotencyRecord', 'actorId'],
])
  link(child, col, 'User');
const ts = [
  ['PolicyClause', 'policyVersionId', 'PolicyVersion'],
  ['Order', 'purchasePolicyVersionId', 'PolicyVersion'],
  ['CustomerOrder', 'orderId', 'Order'],
  ['OrderItem', 'orderId', 'Order'],
  ['CheckoutOperation', 'orderId', 'Order'],
  ['CheckoutOperation', 'accountId', 'PaymentAccount'],
  ['Capture', 'orderId', 'Order'],
  ['Capture', 'accountId', 'PaymentAccount'],
  ['Case', 'orderId', 'Order'],
  ['Case', 'policyVersionId', 'PolicyVersion'],
  ['Evidence', 'caseId', 'Case'],
  ['EvidenceChunk', 'evidenceId', 'Evidence'],
  ['Analysis', 'caseId', 'Case'],
  ['Finding', 'analysisId', 'Analysis'],
  ['FindingReference', 'findingId', 'Finding'],
  ['FindingReference', 'evidenceChunkId', 'EvidenceChunk'],
  ['FindingReference', 'orderId', 'Order'],
  ['FindingReference', 'captureId', 'Capture'],
  ['FindingReference', 'policyClauseId', 'PolicyClause'],
  ['Proposal', 'analysisId', 'Analysis'],
  ['Proposal', 'policyVersionId', 'PolicyVersion'],
  ['Proposal', 'supersedesId', 'Proposal'],
  ['Approval', 'proposalId', 'Proposal'],
  ['Approval', 'policyVersionId', 'PolicyVersion'],
  ['RefundOperation', 'accountId', 'PaymentAccount'],
  ['PaymentAttempt', 'refundOperationId', 'RefundOperation'],
  ['PaymentAttempt', 'checkoutOperationId', 'CheckoutOperation'],
  ['ExternalRefund', 'captureId', 'Capture'],
  ['ExternalRefund', 'accountId', 'PaymentAccount'],
  ['FormalDispute', 'caseId', 'Case'],
  ['FormalDispute', 'accountId', 'PaymentAccount'],
  ['WebhookInbox', 'accountId', 'PaymentAccount'],
  ['WebhookReceipt', 'inboxId', 'WebhookInbox'],
];
for (const x of ts) tenantLink(...x);
links.push(
  {
    child: 'Proposal',
    cols: ['merchantId', 'caseId', 'orderId'],
    parent: 'Case',
    refs: ['merchantId', 'id', 'orderId'],
  },
  {
    child: 'Case',
    cols: ['merchantId', 'currentProposalId', 'id'],
    parent: 'Proposal',
    refs: ['merchantId', 'id', 'caseId'],
  },
  {
    child: 'RefundOperation',
    cols: ['merchantId', 'captureId', 'orderId'],
    parent: 'Capture',
    refs: ['merchantId', 'id', 'orderId'],
  },
  {
    child: 'RefundOperation',
    cols: ['merchantId', 'captureId', 'accountId'],
    parent: 'Capture',
    refs: ['merchantId', 'id', 'accountId'],
  },
  {
    child: 'RefundOperation',
    cols: ['merchantId', 'proposalId', 'orderId'],
    parent: 'Proposal',
    refs: ['merchantId', 'id', 'orderId'],
  },
);
const q = (s) => '"' + s + '"';
const list = (a) => a.map(q).join(',');
let prisma =
  'generator client {\n provider = "prisma-client"\n output = "../src/generated/prisma"\n}\ndatasource db {\n provider = "postgresql"\n}\n';
let sql =
  '-- Generated relational foundation. Supplemental guards live in migration 0002.\n';
for (const [name, values] of Object.entries(enums)) {
  prisma += `enum ${name} {\n${values.map((v) => ' ' + v).join('\n')}\n}\n`;
  sql += `CREATE TYPE ${q(name)} AS ENUM (${values.map((v) => "'" + v + "'").join(',')});\n`;
}
const ptypes = {
  u: 'String',
  t: 'String',
  b: 'BigInt',
  i: 'Int',
  d: 'DateTime',
  j: 'Json',
  f: 'Boolean',
};
const sqltypes = {
  u: 'UUID',
  t: 'TEXT',
  b: 'BIGINT',
  i: 'INTEGER',
  d: 'TIMESTAMPTZ(3)',
  j: 'JSONB',
  f: 'BOOLEAN',
};
for (const [name, fs] of Object.entries(fields)) {
  prisma += `model ${name} {\n`;
  const cols = [];
  for (const f of fs) {
    let d = '';
    if (f.def) {
      d =
        f.def === 'uuid'
          ? 'uuid()'
          : f.def === 'now'
            ? 'now()'
            : ['t'].includes(f.type)
              ? JSON.stringify(f.def)
              : f.def;
    }
    prisma += ` ${f.name} ${ptypes[f.type] ?? f.type}${f.optional ? '?' : ''}${f.name === 'id' ? ' @id' : ''}${d ? ' @default(' + d + ')' : ''}${f.type === 'u' ? ' @db.Uuid' : f.type === 'd' ? ' @db.Timestamptz(3)' : ''}\n`;
    const def =
      f.def === 'uuid'
        ? 'gen_random_uuid()'
        : f.def === 'now'
          ? 'CURRENT_TIMESTAMP'
          : f.def !== undefined
            ? f.type === 't' || enums[f.type]
              ? "'" + f.def + "'"
              : f.def
            : null;
    cols.push(
      `${q(f.name)} ${sqltypes[f.type] ?? q(f.type)}${f.optional ? '' : ' NOT NULL'}${f.name === 'id' ? ' PRIMARY KEY' : ''}${def ? ' DEFAULT ' + def : ''}`,
    );
  }
  const us = [
    ...(!globals.has(name) ? [['merchantId', 'id']] : []),
    ...(unique[name] ?? []),
  ];
  for (const u of us) prisma += ` @@unique([${u.join(',')}])\n`;
  prisma += '}\n';
  sql += `CREATE TABLE ${q(name)} (${cols.join(',\n')});\n`;
  for (let i = 0; i < us.length; i++)
    sql += `CREATE UNIQUE INDEX ${q(name + '_unique_' + i)} ON ${q(name)} (${list(us[i])});\n`;
}
// Scalar Prisma fields intentionally map to SQL-owned FKs; repositories use explicit scoped queries.
for (let i = 0; i < links.length; i++) {
  const l = links[i];
  sql += `ALTER TABLE ${q(l.child)} ADD CONSTRAINT ${q('fk_' + l.child + '_' + i)} FOREIGN KEY (${list(l.cols)}) REFERENCES ${q(l.parent)} (${list(l.refs)}) ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY IMMEDIATE;\nCREATE INDEX ${q('idx_fk_' + i)} ON ${q(l.child)} (${list(l.cols)});\n`;
}
mkdirSync('apps/api/prisma/migrations/0001_foundation', { recursive: true });
writeFileSync('apps/api/prisma/schema.prisma', prisma);
writeFileSync('apps/api/prisma/migrations/0001_foundation/migration.sql', sql);
writeFileSync(
  'apps/api/prisma/migrations/migration_lock.toml',
  'provider = "postgresql"\n',
);
console.log(
  `Generated ${Object.keys(specs).length} tables and ${links.length} relational constraints.`,
);
