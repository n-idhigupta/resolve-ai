import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import {
  createOpenAIProvider,
  MODEL,
  validateCitations,
  AIProviderError,
  conservativeTextTokens,
  estimatedMicros,
} from '../packages/ai-core/dist/index.js';
const packet = JSON.parse(readFileSync('.local/ai-smoke-request.json', 'utf8'));
const hash = createHash('sha256').update(JSON.stringify(packet)).digest('hex');
if (
  hash !== process.env.AI_SMOKE_CONSENT_HASH ||
  packet.request.model !== MODEL
)
  throw Error('SMOKE_CONSENT_MISMATCH');
const provider = createOpenAIProvider(process.env.OPENAI_API_KEY);
let tokens;
try {
  tokens = await provider.countInputTokens(packet.request);
} catch (e) {
  if (
    e instanceof AIProviderError &&
    ['PROVIDER_HTTP_404', 'PROVIDER_HTTP_405', 'PROVIDER_HTTP_501'].includes(
      e.code,
    )
  )
    tokens = conservativeTextTokens(packet.request);
  else throw e;
}
if (
  tokens > 16000 ||
  estimatedMicros(tokens, 4000) > Number(process.env.AI_SMOKE_LIMIT_MICROS)
)
  throw Error('SMOKE_BUDGET_EXCEEDED');
const result = await provider.analyze(packet.request),
  context = JSON.parse(packet.request.input[0].content[0].text);
if (
  result.model !== MODEL ||
  result.inputTokens > 16000 ||
  result.outputTokens > 4000 ||
  estimatedMicros(result.inputTokens, result.outputTokens) >
    Number(process.env.AI_SMOKE_LIMIT_MICROS)
)
  throw Error('SMOKE_RESULT_MODEL_OR_BUDGET_MISMATCH');
const sources = context.sources.map((s) => ({
  ...s,
  reference: { caseSourceId: packet.manifest.caseId },
  hash: packet.manifest.sourceHashes[0],
}));
validateCitations(result.output, sources, context.constraints.candidates);
const receipt = {
  verifiedAt: new Date().toISOString(),
  consentHash: hash,
  caseId: packet.manifest.caseId,
  model: result.model,
  requestId: result.requestId,
  inputTokens: result.inputTokens,
  outputTokens: result.outputTokens,
  estimatedMicros: estimatedMicros(result.inputTokens, result.outputTokens),
  latencyMs: result.latencyMs,
  structuredOutputValid: true,
  citationsValid: true,
  paymentsAccessible: false,
};
writeFileSync('.local/ai-smoke-receipt.json', JSON.stringify(receipt, null, 2));
console.log(JSON.stringify(receipt));
