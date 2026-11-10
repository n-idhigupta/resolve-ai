import fs from 'node:fs';
import {
  createGeminiProvider,
  AnalysisEngine,
  AIProviderError,
  GEMINI_MODEL,
} from '../packages/ai-core/dist/index.js';
import { PaymentDatabase } from '../packages/payment-store/dist/index.js';
for (const k of Object.keys(process.env))
  if (
    /^(PAYPAL_|S3_|DATABASE_URL$|MIGRATION_DATABASE_URL$|WORKER_DATABASE_URL$|EVIDENCE_DATABASE_URL$|OPENAI_)/.test(
      k,
    )
  )
    throw Error('FORBIDDEN_INFERENCE_CREDENTIAL');
const file = '.local/gemini-application-smoke-20261110.json';
const fd = fs.openSync(file, 'wx');
fs.closeSync(fd);
const receipt = {
  synthetic: true,
  model: GEMINI_MODEL,
  billing: 'operator-confirmed Free tier, no linked billing',
  quota: { rpm: 15, tpm: 250000, rpd: 500 },
  generationAttempts: 0,
  countAttempts: 0,
  maximumInputTokens: 16000,
  maximumOutputTokens: 4000,
  maximumEstimatedMicros: 14800,
  reservationMicros: 30000,
  consentHash: process.env.SMOKE_CONSENT_HASH,
  startedAt: new Date().toISOString(),
};
const save = () => fs.writeFileSync(file, JSON.stringify(receipt, null, 2));
save();
const db = new PaymentDatabase(process.env.AI_DATABASE_URL);
try {
  const role = (
    await db.rows(
      'SELECT current_user AS name,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user',
    )
  ).at(0);
  if (
    !['resolve_ai_test', 'resolve_ai'].includes(role?.name) ||
    role.rolsuper ||
    role.rolbypassrls
  )
    throw Error('RESTRICTED_AI_ROLE_REQUIRED');
  const metadata = await fetch(
    'https://generativelanguage.googleapis.com/v1beta/models/' + GEMINI_MODEL,
    {
      headers: { 'x-goog-api-key': process.env.GEMINI_API_KEY },
      signal: AbortSignal.timeout(15000),
      redirect: 'error',
    },
  );
  if (!metadata.ok)
    throw new AIProviderError(
      'MODEL_METADATA_HTTP_' + metadata.status,
      false,
      false,
    );
  const model = await metadata.json();
  if (
    model.name !== 'models/' + GEMINI_MODEL ||
    !model.supportedGenerationMethods?.includes('generateContent') ||
    model.inputTokenLimit < 16000 ||
    model.outputTokenLimit < 4000
  )
    throw new AIProviderError('MODEL_NOT_COMPATIBLE', false, false);
  receipt.advertisedVersion = model.version;
  receipt.metadataVerified = true;
  save();
  const transport = async (url, options) => {
    const u = new URL(String(url));
    if (
      u.origin !== 'https://generativelanguage.googleapis.com' ||
      options?.method !== 'POST'
    )
      throw new AIProviderError('SMOKE_ENDPOINT_REJECTED', false, false);
    if (u.pathname === '/v1beta/models/' + GEMINI_MODEL + ':countTokens') {
      if (receipt.countAttempts++)
        throw new AIProviderError('SMOKE_COUNT_LIMIT', false, false);
    } else if (
      u.pathname ===
      '/v1beta/models/' + GEMINI_MODEL + ':generateContent'
    ) {
      if (receipt.generationAttempts++)
        throw new AIProviderError('SMOKE_GENERATION_LIMIT', false, false);
      const body = JSON.parse(String(options.body));
      if (
        body.generationConfig?.maxOutputTokens !== 4000 ||
        JSON.stringify(body).length > 100000
      )
        throw new AIProviderError('SMOKE_BUDGET_REJECTED', false, false);
    } else throw new AIProviderError('SMOKE_ENDPOINT_REJECTED', false, false);
    save();
    return fetch(url, {
      ...options,
      redirect: 'error',
      signal: AbortSignal.timeout(45000),
    });
  };
  const actual = createGeminiProvider(
    process.env.GEMINI_API_KEY,
    undefined,
    Date.now,
    transport,
  );
  const guarded = {
    id: 'gemini',
    countInputTokens: async (i) => {
      try {
        const n = await actual.countInputTokens(i);
        receipt.preflightTokens = n;
        save();
        return n;
      } catch (e) {
        receipt.errorCode = e.code;
        receipt.diagnostics = e.diagnostics;
        save();
        throw e;
      }
    },
    analyze: async (i) => {
      try {
        const result = await actual.analyze(i);
        receipt.returnedModel = result.model;
        receipt.inputTokens = result.inputTokens;
        receipt.outputTokens = result.outputTokens;
        receipt.requestId = result.requestId;
        receipt.latencyMs = result.latencyMs;
        save();
        return result;
      } catch (e) {
        receipt.errorCode = e.code;
        receipt.diagnostics = e.diagnostics;
        save();
        throw e;
      }
    },
  };
  await new AnalysisEngine(db, guarded, process.env.AI_ARTIFACT_KEY).run(
    process.env.SMOKE_MERCHANT_ID,
    process.env.SMOKE_ANALYSIS_ID,
  );
  receipt.engineStatus = (
    await db.transaction(process.env.SMOKE_MERCHANT_ID, null, (tx) =>
      tx.query('SELECT status,"lastErrorCode" FROM "Analysis" WHERE id=$1', [
        process.env.SMOKE_ANALYSIS_ID,
      ]),
    )
  ).rows[0];
} catch (e) {
  receipt.errorCode =
    e instanceof AIProviderError ? e.code : 'LOCAL_SMOKE_FAILED';
  receipt.diagnostics = e.diagnostics ?? null;
} finally {
  receipt.finishedAt = new Date().toISOString();
  save();
  await db.close();
}
console.log(JSON.stringify(receipt));
