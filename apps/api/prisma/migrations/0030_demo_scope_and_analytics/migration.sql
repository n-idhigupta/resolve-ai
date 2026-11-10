BEGIN;
CREATE FUNCTION mock_context_allowed(p_id uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT EXISTS(SELECT 1 FROM "AIContext" ctx JOIN "AISharingPolicy" p ON p.id=ctx."sharingPolicyId" JOIN "DemoTenant" d ON d."merchantId"=ctx."merchantId" JOIN "Case" c ON c.id=ctx."caseId" JOIN "Capture" cap ON cap."orderId"=c."orderId" AND cap."merchantId"=c."merchantId" WHERE ctx.id=p_id AND ctx."merchantId"=NULLIF(current_setting('app.merchant_id',true),'')::uuid AND p."executionMode"='mock' AND left(cap."providerCaptureId",10)='SYNTHETIC_' AND cap."verifiedAt" IS NOT NULL AND ((c."openedBy"=NULLIF(current_setting('app.user_id',true),'')::uuid) OR EXISTS(SELECT 1 FROM "Membership" m WHERE m."merchantId"=c."merchantId" AND m."userId"=NULLIF(current_setting('app.user_id',true),'')::uuid AND m.active) OR EXISTS(SELECT 1 FROM "AIWorkerTenant" a WHERE a."merchantId"=ctx."merchantId" AND a."roleName"=session_user) OR EXISTS(SELECT 1 FROM "EvidenceWorkerTenant" a WHERE a."merchantId"=ctx."merchantId" AND a."roleName"=session_user)));
$$;
REVOKE ALL ON FUNCTION mock_context_allowed(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mock_context_allowed(uuid) TO resolve_runtime,resolve_test,resolve_ai,resolve_ai_test,resolve_evidence,resolve_evidence_test;
CREATE INDEX analytics_cases_period ON "Case"("merchantId","createdAt");
CREATE INDEX analytics_analysis_period ON "Analysis"("merchantId","createdAt");
CREATE INDEX analytics_refunds_completed ON "RefundOperation"("merchantId","completedAt");
CREATE INDEX analytics_settlement_period ON "Settlement"("merchantId","acceptedAt");
COMMIT;
