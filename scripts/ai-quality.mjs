import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import {
  requestEnvelope,
  INSTRUCTIONS,
  PROMPT_VERSION,
  MODEL,
  validateCitations,
  estimatedMicros,
} from '../packages/ai-core/dist/index.js';
import { recommendationCandidates } from '../packages/policy-engine/dist/index.js';
const file = process.argv[2];
if (!file)
  throw Error(
    'Supply a synthetic-only provider-results JSON file; this scorer makes no provider calls.',
  );
const records = JSON.parse(readFileSync(file, 'utf8')),
  cases = JSON.parse(readFileSync('tests/evaluation/cases.json', 'utf8'));
const frozen = JSON.parse(
  readFileSync('tests/evaluation/prompt-freeze.json', 'utf8'),
);
const hash = createHash('sha256')
  .update(
    JSON.stringify({
      instructions: INSTRUCTIONS,
      schema: requestEnvelope({}, []).text,
      prompt: PROMPT_VERSION,
    }),
  )
  .digest('hex');
if (hash !== frozen.hash) throw Error('PROMPT_CHANGED_AFTER_FREEZE');
const heldout = process.argv.includes('--heldout');
if (heldout && process.env.AI_EVAL_HELDOUT_ACK !== 'FROZEN_PROMPT_NO_TUNING')
  throw Error('Explicit holdout acknowledgment required');
const selected = cases.filter(
  (c) => c.split === (heldout ? 'heldout' : 'development'),
);
if (records.length !== 20 || new Set(records.map((r) => r.caseId)).size !== 20)
  throw Error('Exactly 20 independent outputs required');
let valid = 0,
  escalation = 0,
  reviewed = 0,
  claims = 0,
  unsupported = 0,
  tokens = 0,
  cost = 0;
const latencies = [];
for (const r of records) {
  const c = selected.find((c) => c.id === r.caseId);
  if (
    !c ||
    r.promptHash !== hash ||
    r.model !== MODEL ||
    r.providerKind !== 'real'
  )
    throw Error('Invalid evaluation provenance');
  if (
    !Number.isSafeInteger(r.inputTokens) ||
    !Number.isSafeInteger(r.outputTokens) ||
    r.inputTokens < 0 ||
    r.inputTokens > 16000 ||
    r.outputTokens < 0 ||
    r.outputTokens > 4000 ||
    !Number.isFinite(r.latencyMs) ||
    r.latencyMs < 0
  )
    throw Error('Invalid usage');
  const input = {
    legacy: c.legacy,
    eligible: true,
    allowedRemedies: ['HELP', 'REPLACEMENT', 'PARTIAL_REFUND', 'FULL_REFUND'],
    maxPartialRefundBps: 10000,
    potentialRefundCapMinor: c.capMinor,
    requiredEvidenceTypes: c.missingEvidence ? ['TEXT'] : [],
    availableEvidenceTypes: [],
    omissions: false,
    current: c.current,
    gross: BigInt(c.grossMinor),
    refunded: 0n,
    external: 0n,
    reserved: BigInt(c.reservedMinor),
  };
  const sources = [
    {
      key: 'S001',
      kind: 'ALLEGATION',
      text: c.allegation,
      reference: { caseSourceId: c.id },
      page: null,
      hash: createHash('sha256').update(c.allegation).digest('hex'),
    },
    {
      key: 'S002',
      kind: 'TRUSTED_RECORD',
      text: 'Verified capture: USD ' + c.grossMinor + ' minor units.',
      reference: { recordField: 'verifiedPayment' },
      page: null,
      hash: 'synthetic-payment',
    },
  ];
  try {
    const result = validateCitations(
      r.output,
      sources,
      recommendationCandidates(input).candidates,
    );
    valid++;
    if (c.qualityExpectedRemedies.includes(result.candidate.kind)) escalation++;
  } catch {
    /* Invalid results count as failures, not exclusions. */
  }
  if (
    r.humanReview &&
    new Set(r.humanReview.reviewerAliases).size >= 2 &&
    Number.isSafeInteger(r.humanReview.totalClaims) &&
    Number.isSafeInteger(r.humanReview.unsupportedClaims) &&
    r.humanReview.unsupportedClaims >= 0 &&
    r.humanReview.totalClaims >= r.humanReview.unsupportedClaims
  ) {
    reviewed++;
    claims += r.humanReview.totalClaims;
    unsupported += r.humanReview.unsupportedClaims;
  }
  tokens += r.inputTokens + r.outputTokens;
  cost += estimatedMicros(r.inputTokens, r.outputTokens);
  latencies.push(r.latencyMs);
}
latencies.sort((a, b) => a - b);
console.log(
  JSON.stringify({
    split: heldout ? 'heldout' : 'development',
    cases: 20,
    validatedStructuredCitedPolicyCompliant: valid,
    expectedRemedyMatches: escalation,
    humanReviewedCases: reviewed,
    supportedClaimPrecision:
      reviewed === 20 && claims ? (claims - unsupported) / claims : null,
    latencyP50Ms: latencies[9],
    latencyP95Ms: latencies[18],
    tokens,
    estimatedMicros: cost,
    productionAccuracyClaim: false,
  }),
);
