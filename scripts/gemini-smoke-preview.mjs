import { mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import {
  requestEnvelope,
  geminiWire,
  geminiCountWire,
  GEMINI_MODEL,
  GEMINI_DISCLOSURE,
} from '../packages/ai-core/dist/index.js';
// Local artifact only: no key loading, SDK client construction, network or database access.
if (!process.argv.includes('--preview'))
  throw Error('REAL_GEMINI_VERIFICATION_PENDING_NO_REQUEST_AUTHORIZED');
const context = {
  caseSummary: { reason: 'ITEM_NOT_RECEIVED', requestedOutcome: 'HELP' },
  sources: [
    {
      key: 'S001',
      kind: 'ALLEGATION',
      text: 'Synthetic fixture: the imaginary sample parcel has not arrived.',
      page: null,
    },
  ],
  policy: { legacy: true },
  constraints: {
    candidates: [
      {
        id: 'C0',
        kind: 'REQUEST_MORE_INFORMATION',
        amountMinor: null,
        currency: null,
      },
      {
        id: 'C1',
        kind: 'ESCALATE_TO_HUMAN',
        amountMinor: null,
        currency: null,
      },
    ],
    requiresHumanReview: true,
  },
  omissions: [],
};
const request = requestEnvelope(context, [], GEMINI_MODEL),
  packet = {
    syntheticCaseAlias: 'GEMINI-SYNTHETIC-ONLY',
    provider: 'Google Gemini Developer API',
    model: GEMINI_MODEL,
    disclosure: GEMINI_DISCLOSURE,
    generation: geminiWire(request),
    tokenCounting: geminiCountWire(request),
    maximumReservationMicros: 30000,
    externalRequestsAuthorized: false,
    reviewRequired: [
      'Account and region eligibility',
      'Billing/free-quota status',
      'Actual model availability and deprecation review',
      'Exact provider-specific consent',
      'Separate authorization to make requests',
    ],
  };
mkdirSync('.local', { recursive: true });
writeFileSync(
  '.local/gemini-smoke-preview.json',
  JSON.stringify(packet, null, 2),
);
console.log(
  JSON.stringify({
    previewCreated: true,
    sha256: createHash('sha256').update(JSON.stringify(packet)).digest('hex'),
    externalRequests: 0,
  }),
);
