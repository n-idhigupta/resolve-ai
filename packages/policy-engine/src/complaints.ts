import { activeCaseStates, policyRulesSchema } from '@resolveai/shared';
export function complaintPolicy(
  clauses: unknown[],
  reason: string,
  completedAt: Date,
  now: Date,
  amount: bigint,
) {
  if (!clauses.length)
    return {
      eligible: true,
      legacy: true,
      reviewReasons: ['LEGACY_PURCHASE_POLICY_MANUAL_REVIEW'],
      blockingReasons: [] as string[],
      requiredEvidenceTypes: [] as string[],
      engineVersion: 'complaints-v1',
    };
  const rules = clauses
    .map((c) => policyRulesSchema.parse(c))
    .filter((c) => (c.applicableReasons as string[]).includes(reason));
  const blockingReasons: string[] = [],
    reviewReasons: string[] = [];
  if (!rules.length) blockingReasons.push('CATEGORY_NOT_ELIGIBLE');
  if (
    rules.some(
      (r) =>
        r.complaintWindowDays !== null &&
        now.getTime() >
          completedAt.getTime() + r.complaintWindowDays * 86400000,
    )
  )
    blockingReasons.push('SUBMISSION_WINDOW_EXPIRED');
  if (
    rules.some(
      (r) =>
        r.mandatoryHumanReview ||
        (r.manualReviewThresholdMinor !== null &&
          amount >= BigInt(r.manualReviewThresholdMinor)),
    )
  )
    reviewReasons.push('MANUAL_REVIEW_REQUIRED');
  const remedies = rules.length
    ? rules[0]!.allowedRemedies.filter((remedy) =>
        rules.every((r) => r.allowedRemedies.includes(remedy)),
      )
    : [];
  if (!remedies.length && rules.length)
    reviewReasons.push('CONFLICTING_REMEDIES_MANUAL_REVIEW');
  const caps = rules.flatMap((r) =>
    r.maxRefundMinor === null ? [] : [BigInt(r.maxRefundMinor)],
  );
  const bps = rules.flatMap((r) =>
    r.maxPartialRefundBps === null ? [] : [r.maxPartialRefundBps],
  );
  return {
    potentialRefundCapMinor: caps.length
      ? caps.reduce((a, b) => (a < b ? a : b)).toString()
      : null,
    maxPartialRefundBps: bps.length ? Math.min(...bps) : null,
    allowedRemedies: remedies,
    eligible: !blockingReasons.length,
    legacy: false,
    blockingReasons,
    reviewReasons,
    requiredEvidenceTypes: [
      ...new Set(rules.flatMap((r) => r.requiredEvidenceTypes)),
    ],
    engineVersion: 'complaints-v1',
  };
}
export function caseTransition(
  state: string,
  action: string,
  merchant: boolean,
  message: string,
) {
  if (!(activeCaseStates as readonly string[]).includes(state))
    throw Error('CASE_CLOSED');
  if (action !== 'BEGIN_REVIEW' && !message.trim())
    throw Error('MESSAGE_REQUIRED');
  if (merchant && action === 'BEGIN_REVIEW' && state === 'OPEN')
    return 'INVESTIGATING';
  if (
    merchant &&
    action === 'REQUEST_INFORMATION' &&
    state !== 'AWAITING_CUSTOMER'
  )
    return 'AWAITING_CUSTOMER';
  if (!merchant && action === 'RESPOND' && state === 'AWAITING_CUSTOMER')
    return 'INVESTIGATING';
  if (
    (merchant && action === 'CLOSE_WITHOUT_AGREEMENT') ||
    (!merchant && action === 'WITHDRAW')
  )
    return 'CLOSED_WITHOUT_AGREEMENT';
  throw Error('ACTION_NOT_ALLOWED');
}
export function repeatComplaintAllowed(
  count: number,
  lastClosed: Date | null,
  now: Date,
) {
  return (
    count < 3 &&
    (!lastClosed || now.getTime() - lastClosed.getTime() >= 86400000)
  );
}
