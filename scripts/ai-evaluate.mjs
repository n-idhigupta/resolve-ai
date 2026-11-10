import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import {
  INSTRUCTIONS,
  PROMPT_VERSION,
  requestEnvelope,
  validateCitations,
} from '../packages/ai-core/dist/index.js';
import {
  recommendationCandidates,
  chooseRecommendation,
} from '../packages/policy-engine/dist/index.js';
const fixtures = JSON.parse(
  readFileSync('tests/evaluation/cases.json', 'utf8'),
);
const freezeFile = 'tests/evaluation/prompt-freeze.json';
const hash = createHash('sha256')
  .update(
    JSON.stringify({
      instructions: INSTRUCTIONS,
      schema: requestEnvelope({}, []).text,
      prompt: PROMPT_VERSION,
    }),
  )
  .digest('hex');
if (process.argv.includes('--freeze-development')) {
  if (process.argv.includes('--heldout'))
    throw Error('Cannot freeze using heldout');
  try {
    const previous = JSON.parse(readFileSync(freezeFile, 'utf8'));
    if (previous.hash !== hash) throw Error('EXISTING_FREEZE_IMMUTABLE');
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  writeFileSync(
    freezeFile,
    JSON.stringify(
      {
        promptVersion: PROMPT_VERSION,
        hash,
        developmentIds: fixtures
          .filter((c) => c.split === 'development')
          .map((c) => c.id),
        rule: 'Freeze before held-out execution. Changes require a new independently authored holdout.',
      },
      null,
      2,
    ) + '\n',
  );
  console.log('Development prompt/schema fingerprint frozen. No model call.');
  process.exit(0);
}
const heldout = process.argv.includes('--heldout');
if (heldout && process.env.AI_EVAL_HELDOUT_ACK !== 'FROZEN_PROMPT_NO_TUNING')
  throw Error('Explicit held-out acknowledgment required');
const frozen = JSON.parse(readFileSync(freezeFile, 'utf8'));
if (frozen.hash !== hash) throw Error('PROMPT_CHANGED_AFTER_FREEZE');
const selected = fixtures.filter(
  (c) => c.split === (heldout ? 'heldout' : 'development'),
);
if (
  fixtures.length !== 40 ||
  new Set(fixtures.map((c) => c.id)).size !== 40 ||
  selected.length !== 20
)
  throw Error('Invalid split');
let assertions = 0;
for (const c of selected) {
  const { candidates, remainingMinor } = recommendationCandidates({
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
  });
  for (const candidate of candidates) {
    assertions++;
    if (
      candidate.amountMinor !== null &&
      (BigInt(candidate.amountMinor) > BigInt(remainingMinor) ||
        (c.capMinor !== null &&
          BigInt(candidate.amountMinor) > BigInt(c.capMinor)))
    )
      throw Error('Financial guard failed');
  }
  if (c.legacy || c.missingEvidence || !c.current) {
    assertions++;
    if (candidates.some((x) => x.amountMinor !== null))
      throw Error('Unsafe remedy');
  }
  assertions++;
  try {
    chooseRecommendation(candidates, 'MODEL_INVENTED_AMOUNT', false);
    throw Error('accepted');
  } catch (e) {
    if (e.message === 'accepted') throw e;
  }
  for (const candidate of candidates.filter(
    (x) => !['REQUEST_MORE_INFORMATION', 'ESCALATE_TO_HUMAN'].includes(x.kind),
  )) {
    assertions++;
    try {
      chooseRecommendation(candidates, candidate.id, true);
      throw Error('accepted');
    } catch (e) {
      if (e.message === 'accepted') throw e;
    }
  }
  assertions++;
  try {
    validateCitations({ invented: true }, [], candidates);
    throw Error('accepted');
  } catch (e) {
    if (e.message === 'accepted') throw e;
  }
}
console.log(
  JSON.stringify({
    split: heldout ? 'heldout' : 'development',
    cases: selected.length,
    deterministicAssertions: assertions,
    passed: true,
    promptHash: hash,
    modelCalls: 0,
    modelQualityMetrics: 'NOT_MEASURED',
    note: 'Safety guard checks are not model accuracy. Held-out data was not used to alter prompts.',
  }),
);
