import { z } from 'zod';
export const aiKinds = [
  'REQUEST_MORE_INFORMATION',
  'NO_FINANCIAL_REMEDY',
  'REPLACEMENT',
  'PARTIAL_REFUND',
  'FULL_REFUND',
  'ESCALATE_TO_HUMAN',
] as const;
const sourceIds = z
  .array(z.string().regex(/^S[0-9]{3,5}$/))
  .min(1)
  .max(5);
export const aiOutputSchema = z.strictObject({
  schemaVersion: z.literal('1'),
  summary: z.strictObject({ text: z.string().min(1).max(1000), sourceIds }),
  findings: z
    .array(
      z.strictObject({
        id: z.string().regex(/^F[0-9]{1,3}$/),
        kind: z.enum(['ALLEGATION', 'EVIDENCE_OBSERVATION', 'UNCERTAINTY']),
        statement: z.string().min(1).max(1000),
        sourceIds,
        quote: z.string().max(1000).nullable(),
        start: z.number().int().nonnegative().nullable(),
        end: z.number().int().nonnegative().nullable(),
        page: z.number().int().positive().nullable(),
      }),
    )
    .max(30),
  contradictions: z
    .array(
      z.strictObject({
        findingIds: z
          .array(z.string().regex(/^F[0-9]{1,3}$/))
          .min(2)
          .max(5),
        explanation: z.string().min(1).max(1000),
      }),
    )
    .max(10),
  missingInformation: z
    .array(
      z.strictObject({
        question: z.string().min(1).max(500),
        reason: z.string().min(1).max(500),
        blocking: z.boolean(),
        relatedSourceIds: z.array(z.string().regex(/^S[0-9]{3,5}$/)).max(5),
      }),
    )
    .max(10),
  policySourceIds: z.array(z.string().regex(/^S[0-9]{3,5}$/)).max(20),
  riskFlags: z
    .array(
      z.enum([
        'INSUFFICIENT_EVIDENCE',
        'CONTRADICTION',
        'POLICY_AMBIGUOUS',
        'SAFETY',
        'OTHER',
      ]),
    )
    .max(10),
  recommendation: z.strictObject({
    candidateId: z.string().regex(/^C[0-9]{1,3}$/),
    rationale: z.string().min(1).max(2000),
    findingIds: z.array(z.string().regex(/^F[0-9]{1,3}$/)).max(30),
    sourceIds,
  }),
});
export type AIOutput = z.infer<typeof aiOutputSchema>;
export const aiReviewSchema = z.strictObject({
  action: z.enum(['APPROVE', 'REJECT', 'REVISE']),
  reason: z.string().trim().min(5).max(2000),
  candidateId: z
    .string()
    .regex(/^C[0-9]{1,3}$/)
    .nullable(),
  rationale: z.string().trim().min(1).max(2000),
});
export const aiSharingSchema = z.strictObject({
  enabled: z.boolean(),
  modelId: z.enum([
    'gpt-5.4-mini-2026-03-17',
    'gemini-2.5-flash',
    'gemini-3.5-flash-lite',
  ]),
  dailyBudgetMicros: z.number().int().min(10000).max(5000000).default(5000000),
});
export const aiSelectionSchema = z
  .strictObject({ evidenceIds: z.array(z.uuid()).max(10) })
  .refine(
    (v) => new Set(v.evidenceIds).size === v.evidenceIds.length,
    'Duplicate evidence',
  );
