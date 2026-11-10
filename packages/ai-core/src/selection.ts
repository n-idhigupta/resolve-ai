import { z } from 'zod';
export const LEGACY_GEMINI_MODEL = 'gemini-2.5-flash';
export const GEMINI_MODEL = 'gemini-3.5-flash-lite';
export const OPENAI_MODEL = 'gpt-5.4-mini-2026-03-17';
export type ProviderId = 'openai' | 'gemini';
export function providerForModel(model: string): ProviderId {
  if (model === OPENAI_MODEL) return 'openai';
  if (model === GEMINI_MODEL || model === LEGACY_GEMINI_MODEL) return 'gemini';
  throw Error('UNSUPPORTED_AI_MODEL');
}
export function readProviderSelection(
  env: Record<string, string | undefined> = process.env,
) {
  const provider = z
    .enum(['openai', 'gemini'])
    .parse(env.AI_PROVIDER ?? 'openai');
  const model =
    env.AI_MODEL || (provider === 'gemini' ? GEMINI_MODEL : OPENAI_MODEL);
  if (providerForModel(model) !== provider)
    throw Error('AI_PROVIDER_MODEL_MISMATCH');
  return { provider, model };
}
export function estimateProviderMicros(
  input: number,
  output: number,
  model = OPENAI_MODEL,
) {
  if (
    !Number.isSafeInteger(input) ||
    !Number.isSafeInteger(output) ||
    input < 0 ||
    output < 0
  )
    throw Error('INVALID_USAGE');
  return providerForModel(model) === 'gemini'
    ? Number((BigInt(input) * 3n + 9n) / 10n + (BigInt(output) * 5n + 1n) / 2n)
    : Number((BigInt(input) * 3n + 3n) / 4n + (BigInt(output) * 9n + 1n) / 2n);
}
export function priceVersion(model: string) {
  return providerForModel(model) === 'gemini'
    ? model === GEMINI_MODEL
      ? 'gemini35flashlite-standard-upper-bound-2026-11-10'
      : 'gemini25flash-standard-upper-bound-2026-11-10'
    : 'openai-mini-standard-2026-11-10';
}
export function assertGeminiModelWindow(
  now = Date.now(),
  model = LEGACY_GEMINI_MODEL,
) {
  if (
    model === LEGACY_GEMINI_MODEL &&
    now >= Date.parse('2026-12-01T00:00:00Z')
  )
    throw Error('GEMINI_MODEL_REVALIDATION_REQUIRED');
}
export const GEMINI_DISCLOSURE =
  'Google Gemini Developer API (unpaid-services terms) will receive the exact synthetic-only generation request shown here and the displayed token-count request. Do not send real customer, personal, sensitive or confidential information; consent does not override this restriction. Outside the EEA, Switzerland and UK, Google may use unpaid inputs and outputs to improve products and machine-learning technologies; human reviewers may read them. Regional and active-billing exceptions may apply. Google documents 55-day abuse-monitoring retention; this is not a guaranteed deletion deadline for all unpaid-service/model-improvement data. ResolveAI makes no zero-retention promise. Results are merchant-only and nonbinding. Revocation blocks future authorized dispatch, but already transmitted data cannot be recalled. No payment action is authorized.';

export function acceptedReturnedModels(model: string) {
  if (providerForModel(model) === 'openai') return [model];
  return model === GEMINI_MODEL
    ? [model, model + '-07-2026']
    : [model, model + '-001'];
}
