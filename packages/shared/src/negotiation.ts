import { z } from 'zod';
const amount = z.string().regex(/^[1-9][0-9]{0,11}$/);
export const negotiationInputSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('FULL_REFUND'),
    amountMinor: amount,
    currency: z.literal('USD'),
    message: z.string().trim().min(5).max(2000),
    expiresAt: z.iso.datetime(),
  }),
  z.strictObject({
    kind: z.literal('PARTIAL_REFUND'),
    amountMinor: amount,
    currency: z.literal('USD'),
    message: z.string().trim().min(5).max(2000),
    expiresAt: z.iso.datetime(),
  }),
  z.strictObject({
    kind: z.literal('REPLACEMENT'),
    message: z.string().trim().min(5).max(2000),
    itemDescription: z.string().trim().min(3).max(500),
    shipBy: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
  }),
  z.strictObject({
    kind: z.literal('REQUEST_EVIDENCE'),
    message: z.string().trim().min(5).max(2000),
    questions: z.array(z.string().trim().min(3).max(500)).min(1).max(10),
    expiresAt: z.iso.datetime(),
  }),
  z.strictObject({
    kind: z.literal('ESCALATION'),
    message: z.string().trim().min(5).max(2000),
    expiresAt: z.iso.datetime(),
  }),
]);
export type NegotiationInput = z.infer<typeof negotiationInputSchema>;
export const negotiationActionSchema = z.strictObject({
  action: z.enum(['PUBLISH', 'REJECT', 'WITHDRAW', 'EXPIRE']),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  reason: z.string().trim().min(3).max(2000),
});

export const settlementDecisionSchema = z.strictObject({
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  proposalVersion: z.number().int().nonnegative(),
  confirm: z.literal(true),
});
export const settlementCancelSchema = z.strictObject({
  reason: z.string().trim().min(5).max(1000),
});
