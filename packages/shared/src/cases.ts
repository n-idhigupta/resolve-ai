import { z } from 'zod';
export const complaintReasonSchema = z.enum([
  'ITEM_NOT_RECEIVED',
  'NOT_AS_DESCRIBED',
  'DAMAGED',
  'DUPLICATE_CHARGE',
  'INCORRECT_AMOUNT',
  'OTHER',
]);
export const caseInputSchema = z.strictObject({
  orderId: z.uuid(),
  reason: complaintReasonSchema,
  title: z.string().trim().min(5).max(160),
  description: z.string().trim().min(20).max(5000),
  requestedOutcome: z.enum([
    'FULL_REFUND',
    'PARTIAL_REFUND',
    'REPLACEMENT',
    'HELP',
  ]),
  desiredResolution: z.string().trim().max(2000).default(''),
});
export const policyRulesSchema = z.strictObject({
  schemaVersion: z.literal(1),
  applicableReasons: z.array(complaintReasonSchema).min(1),
  allowedRemedies: z
    .array(z.enum(['FULL_REFUND', 'PARTIAL_REFUND', 'REPLACEMENT', 'HELP']))
    .min(1),
  complaintWindowDays: z.number().int().min(1).max(365).nullable(),
  requiredEvidenceTypes: z.array(z.enum(['IMAGE', 'PDF', 'TEXT'])),
  maxPartialRefundBps: z.number().int().min(0).max(10000).nullable(),
  maxRefundMinor: z
    .string()
    .regex(/^(0|[1-9][0-9]{0,11})$/)
    .nullable(),
  manualReviewThresholdMinor: z
    .string()
    .regex(/^(0|[1-9][0-9]{0,11})$/)
    .nullable(),
  mandatoryHumanReview: z.boolean(),
  replacementAllowed: z.boolean(),
});
export const policyDocumentSchema = z
  .strictObject({
    name: z.string().trim().min(3).max(100),
    clauses: z
      .array(
        z.strictObject({
          clauseKey: z.string().regex(/^[a-zA-Z0-9_-]{1,60}$/),
          text: z.string().trim().min(5).max(2000),
          rules: policyRulesSchema,
        }),
      )
      .min(1)
      .max(20),
  })
  .refine(
    (d) => new Set(d.clauses.map((c) => c.clauseKey)).size === d.clauses.length,
    'Duplicate clause keys',
  );
export const evidenceInputSchema = z.strictObject({
  filename: z
    .string()
    .min(1)
    .max(160)
    .refine(
      (s) =>
        !Array.from(s).some((c) => c.charCodeAt(0) < 32 || '\\/:'.includes(c)),
      'Unsafe filename',
    ),
  declaredType: z.enum([
    'image/jpeg',
    'image/png',
    'application/pdf',
    'text/plain',
  ]),
  sizeBytes: z.number().int().min(1).max(10485760),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
export const caseActionSchema = z.strictObject({
  action: z.enum([
    'BEGIN_REVIEW',
    'REQUEST_INFORMATION',
    'RESPOND',
    'CLOSE_WITHOUT_AGREEMENT',
    'WITHDRAW',
  ]),
  message: z.string().trim().max(2000).default(''),
});
export const activeCaseStates = [
  'OPEN',
  'INVESTIGATING',
  'AWAITING_CUSTOMER',
] as const;
