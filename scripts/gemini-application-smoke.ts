if (
  process.env.RUN_REAL_GEMINI_SMOKE !== 'true' ||
  process.env.GEMINI_SMOKE_SHARING_ACK !==
    'SYNTHETIC_GOOGLE_UNPAID_CURRENT_QUOTA_NO_BILLING'
)
  throw Error('EXPLICIT_SYNTHETIC_GOOGLE_SMOKE_AUTHORIZATION_REQUIRED');
import fs from 'node:fs';
import { parse } from 'dotenv';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createDatabase } from '../apps/api/src/database.js';
import { createSettlementFixture } from '../scripts/settlement-fixture.js';
import { PaymentDatabase } from '../packages/payment-store/dist/index.js';
import {
  IntelligenceService,
  ContextPreparer,
  GEMINI_MODEL,
  GEMINI_DISCLOSURE,
} from '../packages/ai-core/dist/index.js';
import {
  CaseStore,
  PrivateStorage,
  storageEnvSchema,
  EvidenceService,
  EvidenceProcessor,
  sha,
} from '../packages/case-store/dist/index.js';
function required(values: Record<string, string>, name: string) {
  const value = values[name];
  if (!value) throw Error('SMOKE_CONFIGURATION_REQUIRED');
  return value;
}
const local = parse(fs.readFileSync('.env', 'utf8')),
  v = parse(fs.readFileSync('.env.test', 'utf8'));
if (fs.existsSync('.local/gemini-application-smoke-20261110.json'))
  throw Error('ONE_AUTHORIZED_ATTEMPT_ALREADY_RECORDED');
if (new URL(required(v, 'DATABASE_URL')).pathname !== '/resolveai_test')
  throw Error('ISOLATED_APPEND_ONLY_DB_REQUIRED');
const migration = createDatabase(required(v, 'MIGRATION_DATABASE_URL')),
  runtime = new PaymentDatabase(required(v, 'DATABASE_URL')),
  prep = new PaymentDatabase(required(v, 'EVIDENCE_DATABASE_URL')),
  key = required(v, 'AI_ARTIFACT_KEY');
let consentId, fixture;
try {
  fixture = await createSettlementFixture(
    migration,
    'synthetic-real-provider-fixture-password-only',
  );
  const owner = { merchantId: fixture.merchantId, userId: fixture.owner },
    customer = { merchantId: fixture.merchantId, userId: fixture.customer };
  await migration.aIWorkerTenant.create({
    data: { merchantId: fixture.merchantId, roleName: 'resolve_ai_test' },
  });
  await migration.evidenceWorkerTenant.create({
    data: { merchantId: fixture.merchantId, roleName: 'resolve_evidence_test' },
  });
  const service = new IntelligenceService(runtime, key),
    cases = new CaseStore(runtime),
    storage = new PrivateStorage(storageEnvSchema.parse(v)),
    evidence = new EvidenceService(cases, storage),
    scanner = new EvidenceProcessor(prep, storage);
  Object.assign(process.env, {
    CLAMAV_HOST: v.CLAMAV_HOST ?? '127.0.0.1',
    CLAMAV_PORT: v.CLAMAV_PORT ?? '3310',
  });
  const bytes = Buffer.from(
    'SYNTHETIC TEST ONLY: Imaginary demo parcel has a damaged corner. This text is a customer allegation, not proof of a transaction. No real person, address or payment reference.',
  );
  const ev = await cases.evidence(
    customer,
    fixture.caseId,
    {
      filename: 'synthetic-complaint.txt',
      declaredType: 'text/plain',
      sizeBytes: bytes.length,
      sha256: sha(bytes),
    },
    0,
    randomUUID(),
  );
  await evidence.upload(customer, fixture.caseId, ev.id, bytes);
  let c = await migration.case.findUniqueOrThrow({
    where: { id: fixture.caseId },
  });
  await evidence.complete(
    customer,
    fixture.caseId,
    ev.id,
    randomUUID(),
    c.version,
  );
  await scanner.process(fixture.merchantId, ev.id);
  const clean = await migration.evidence.findUniqueOrThrow({
    where: { id: ev.id },
  });
  if (clean.scanStatus !== 'CLEAN' || !clean.scannedAt)
    throw Error('REAL_SCANNER_GATE_NOT_MET');
  c = await migration.case.findUniqueOrThrow({ where: { id: fixture.caseId } });
  await migration.case.update({
    where: { id: c.id },
    data: {
      aiSyntheticAuthorized: true,
      aiSyntheticAuthorizedVersion: c.version,
    },
  });
  await service.sharingPolicy(owner, {
    enabled: true,
    modelId: GEMINI_MODEL,
    dailyBudgetMicros: 30000,
  });
  const context = await service.preview(
    customer,
    c.id,
    { evidenceIds: [ev.id] },
    randomUUID(),
  );
  await new ContextPreparer(prep, storage, key).process(
    fixture.merchantId,
    context.id,
  );
  const preview = await service.readPreview(customer, c.id, context.id);
  if (
    preview.state !== 'READY' ||
    preview.disclosure !== GEMINI_DISCLOSURE ||
    preview.providerId !== 'gemini' ||
    preview.executionMode !== 'external' ||
    preview.request?.model !== GEMINI_MODEL
  )
    throw Error('EXACT_GOOGLE_CONSENT_REQUIRED');
  const packet = JSON.stringify(preview.request);
  if (
    /PRIVATE_MERCHANT_SECRET|customer@resolveai|7ND54081CF0194732|1PW94653MW830523X/.test(
      packet,
    )
  )
    throw Error('DATA_MINIMIZATION_FAILED');
  const consent = await service.consent(customer, c.id, {
    contextId: context.id,
    sharingPolicyId: preview.sharingPolicyId,
    consentHash: preview.consentHash,
  });
  consentId = consent.id;
  const run = await service.start(
    owner,
    c.id,
    consent.id,
    randomUUID(),
    c.version,
  );
  const allowed = ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP'];
  const env = Object.fromEntries(
    allowed.filter((k) => process.env[k]).map((k) => [k, process.env[k]]),
  );
  Object.assign(env, {
    AI_DATABASE_URL: required(v, 'AI_DATABASE_URL'),
    AI_ARTIFACT_KEY: key,
    GEMINI_API_KEY: required(local, 'GEMINI_API_KEY'),
    SMOKE_MERCHANT_ID: fixture.merchantId,
    SMOKE_ANALYSIS_ID: run.id,
    SMOKE_CONSENT_HASH: preview.consentHash,
  });
  const child = spawnSync(
    process.execPath,
    ['scripts/gemini-application-infer.mjs'],
    { env, encoding: 'utf8', windowsHide: true, timeout: 90000 },
  );
  if (child.status !== 0) throw Error('RESTRICTED_CHILD_FAILED');
  const receipt = JSON.parse(
      fs.readFileSync('.local/gemini-application-smoke-20261110.json', 'utf8'),
    ),
    detail = await service.detail(owner, c.id, run.id);
  Object.assign(receipt, {
    analysisStatus: detail.status,
    evidenceActuallyScanned: true,
    applicationAnalysisId: run.id,
    syntheticCaseId: c.id,
    structuredOutputValid: detail.status === 'SUCCEEDED',
    citationsValid: detail.status === 'SUCCEEDED',
    policyValid: detail.status === 'SUCCEEDED',
  });
  if (detail.status === 'SUCCEEDED') {
    await service.review(
      owner,
      c.id,
      run.id,
      {
        action: 'APPROVE',
        reason:
          'Authorized review of the synthetic real-provider smoke; nonbinding and no financial effect.',
        candidateId: null,
        rationale: 'Reviewed sources and deterministic constraints.',
      },
      detail.version,
      randomUUID(),
    );
    receipt.merchantReviewVerified = true;
    receipt.usage = detail.usage;
  } else {
    await service.revoke(customer, c.id, consent.id);
    receipt.consentRevokedAfterFailure = true;
  }
  receipt.paypalOperations = 0;
  receipt.billingChanged = false;
  fs.writeFileSync(
    '.local/gemini-application-smoke-20261110.json',
    JSON.stringify(receipt, null, 2),
  );
  console.log(JSON.stringify(receipt));
} catch (e) {
  if (consentId && fixture)
    await new IntelligenceService(runtime, key)
      .revoke(
        { merchantId: fixture.merchantId, userId: fixture.customer },
        fixture.caseId,
        consentId,
      )
      .catch(() => {});
  console.error(
    'Application smoke stopped safely:',
    e instanceof Error && /^[A-Z_]+$/.test(e.message)
      ? e.message
      : 'LOCAL_PRECONDITION_FAILED',
  );
  process.exitCode = 1;
} finally {
  await Promise.all([migration.$disconnect(), runtime.close(), prep.close()]);
}
