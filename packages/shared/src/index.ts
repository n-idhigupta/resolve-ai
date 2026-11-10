import { z } from 'zod';
export const MAX_MINOR = 999999999999n;
export const currencySchema = z.literal('USD');
export type Currency = z.infer<typeof currencySchema>;
export const minorSchema = z
  .string()
  .regex(/^(0|[1-9][0-9]*)$/)
  .refine((v) => BigInt(v) <= MAX_MINOR, 'Amount exceeds limit');
export const moneySchema = z.strictObject({
  minor: minorSchema,
  currency: currencySchema,
});
export type Money = z.infer<typeof moneySchema>;
export const roleSchema = z.enum(['OWNER', 'APPROVER', 'AGENT']);
export type Role = z.infer<typeof roleSchema>;
export type Permission =
  'orders:read' | 'cases:investigate' | 'refunds:approve' | 'policies:manage';
export const permissions: Record<Role, readonly Permission[]> = {
  OWNER: [
    'orders:read',
    'cases:investigate',
    'refunds:approve',
    'policies:manage',
  ],
  APPROVER: ['orders:read', 'cases:investigate', 'refunds:approve'],
  AGENT: ['orders:read', 'cases:investigate'],
};
export function hasPermission(role: Role, permission: Permission) {
  return permissions[role].includes(permission);
}
export const errorCodes = [
  'VALIDATION_ERROR',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'INSUFFICIENT_FUNDS',
  'INTERNAL_ERROR',
  'RATE_LIMITED',
] as const;
export type ErrorCode = (typeof errorCodes)[number];
export type ApiResponse<T> = { data: T; requestId: string };
export type ApiProblem = {
  type: string;
  title: string;
  status: number;
  code: string;
  detail: string;
  requestId: string;
};
export const idSchema = z.uuid();
export function parseMoney(value: unknown): {
  minor: bigint;
  currency: Currency;
} {
  const m = moneySchema.parse(value);
  return { ...m, minor: BigInt(m.minor) };
}
export function serializeMoney(minor: bigint, currency: Currency): Money {
  return moneySchema.parse({ minor: minor.toString(), currency });
}
export function decimalToMinor(
  value: string,
  currency: Currency = 'USD',
): bigint {
  currencySchema.parse(currency);
  if (!/^(0|[1-9][0-9]*)(\.[0-9]{1,2})?$/.test(value))
    throw Error('Invalid decimal money');
  const [whole, fraction = ''] = value.split('.');
  const minor = BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, '0'));
  return parseMoney({ minor: minor.toString(), currency }).minor;
}
export function minorToDecimal(minor: bigint, currency: Currency = 'USD') {
  parseMoney({ minor: minor.toString(), currency });
  return `${minor / 100n}.${(minor % 100n).toString().padStart(2, '0')}`;
}
export const pingJobSchema = z.strictObject({
  schemaVersion: z.literal(1),
  requestId: z.uuid(),
  message: z.string().min(1).max(120),
});
export type PingJob = z.infer<typeof pingJobSchema>;
export const caseStatusSchema = z.enum([
  'OPEN',
  'INVESTIGATING',
  'NEGOTIATING',
  'RESOLUTION_PENDING',
  'RESOLVED',
  'ESCALATED',
  'CLOSED_WITHOUT_AGREEMENT',
]);
export const refundStatusSchema = z.enum([
  'READY',
  'IN_FLIGHT',
  'PENDING',
  'UNKNOWN',
  'COMPLETED',
  'FAILED',
]);

export const paymentStateSchema = z.enum([
  'NOT_STARTED',
  'PENDING',
  'CREATED',
  'AWAITING_BUYER_APPROVAL',
  'APPROVED',
  'CAPTURE_PENDING',
  'CAPTURED',
  'FAILED',
  'CANCELLED',
  'RECONCILIATION_REQUIRED',
]);
export type PaymentState = z.infer<typeof paymentStateSchema>;
/** Structural transition guard only; provider verification remains mandatory for settlement. */
export function canTransitionPayment(from: PaymentState, to: PaymentState) {
  if (from === to) return true;
  if (['CAPTURED', 'FAILED', 'CANCELLED'].includes(from)) return false;
  if (to === 'RECONCILIATION_REQUIRED' || to === 'FAILED' || to === 'CANCELLED')
    return true;
  if (from === 'RECONCILIATION_REQUIRED') return to !== 'NOT_STARTED';
  const progress: PaymentState[] = [
    'NOT_STARTED',
    'PENDING',
    'CREATED',
    'AWAITING_BUYER_APPROVAL',
    'APPROVED',
    'CAPTURE_PENDING',
    'CAPTURED',
  ];
  return progress.indexOf(to) > progress.indexOf(from);
}

export * from './cases.js';

export * from './ai.js';

export * from './negotiation.js';

export * from './analytics.js';
