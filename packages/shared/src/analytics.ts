import { z } from 'zod';
const count = z.number().int().nonnegative().safe(),
  minor = z.string().regex(/^(0|[1-9][0-9]*)$/),
  distribution = z.array(z.strictObject({ status: z.string(), count }));
export const analyticsQuerySchema = z.strictObject({
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
});
export const analyticsSchema = z.strictObject({
  asOf: z.iso.datetime(),
  from: z.iso.datetime(),
  to: z.iso.datetime(),
  complaints: z.strictObject({
    total: count,
    resolved: count,
    closedWithoutAgreement: count,
    resolutionRateBps: count.nullable(),
    status: distribution,
    daily: z.array(z.strictObject({ day: z.string(), count })),
    durationSamples: count,
    averageResolutionHours: z.number().nonnegative().nullable(),
    medianResolutionHours: z.number().nonnegative().nullable(),
    p95ResolutionHours: z.number().nonnegative().nullable(),
    capturedOrders: count,
    capturedOrdersWithComplaint: count,
  }),
  settlements: z.strictObject({
    total: count,
    authorized: count,
    completed: count,
    status: distribution,
    merchantFinancialAuthorizations: count,
  }),
  refunds: z.array(
    z.strictObject({
      currency: z.string().length(3),
      completedMinor: minor,
      mockCompletedMinor: minor,
      recordedProviderCompletedMinor: minor,
      externalCompletedMinor: minor,
      completedCount: count,
      pendingMinor: minor,
      unknownMinor: minor,
      pendingCount: count,
      unknownCount: count,
    }),
  ),
  ai: z.strictObject({
    analyses: count,
    mockAnalyses: count,
    recommendations: count,
    reviewed: count,
    approved: count,
    rejected: count,
    revised: count,
    approvalRateBps: count.nullable(),
    status: distribution,
  }),
  definitions: z.array(z.string()),
});
export type MerchantAnalytics = z.infer<typeof analyticsSchema>;

export function formatMinorTotal(value: string) {
  const parsed = minor.parse(value),
    n = BigInt(parsed);
  return `${n / 100n}.${(n % 100n).toString().padStart(2, '0')}`;
}
