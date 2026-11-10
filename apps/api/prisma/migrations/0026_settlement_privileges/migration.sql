BEGIN;
REVOKE SELECT ON "Case","Proposal" FROM resolve_payments,resolve_payments_test;
GRANT SELECT(id,"merchantId","orderId",status,"currentProposalId","policyVersionId","openedBy") ON "Case" TO resolve_payments,resolve_payments_test;
GRANT SELECT(id,"merchantId","caseId","orderId",status,"rowVersion","expiresAt","amountMinor",currency,"contentHash","policyVersionId") ON "Proposal" TO resolve_payments,resolve_payments_test;
COMMIT;
