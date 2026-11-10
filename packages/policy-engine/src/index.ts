import {
  MAX_MINOR,
  hasPermission,
  type Role,
  type Permission,
} from '@resolveai/shared';
export function refundableRemaining(input: {
  gross: bigint;
  completed: bigint;
  external: bigint;
  reserved: bigint;
}): bigint {
  const { gross, completed, external, reserved } = input;
  if (
    Object.values(input).some((v) => v < 0n || v > MAX_MINOR) ||
    completed + external + reserved > gross
  )
    throw Error('Invalid capture balance');
  return gross - completed - external - reserved;
}
export function partialCeiling(remaining: bigint, bps: number): bigint {
  if (
    remaining < 0n ||
    remaining > MAX_MINOR ||
    !Number.isInteger(bps) ||
    bps < 0 ||
    bps > 10000
  )
    throw Error('Invalid partial ceiling');
  return (remaining * BigInt(bps)) / 10000n;
}
export function authorize(role: Role, permission: Permission): boolean {
  return hasPermission(role, permission);
}
export function canReserve(remaining: bigint, amount: bigint) {
  return amount > 0n && amount <= MAX_MINOR && amount <= remaining;
}

export * from './complaints.js';

export * from './recommendations.js';

export * from './negotiation.js';
