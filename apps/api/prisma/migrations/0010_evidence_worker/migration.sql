GRANT USAGE ON SCHEMA public TO resolve_evidence,resolve_evidence_test;
GRANT SELECT ON "EvidenceWorkerTenant","Evidence","Case","OutboxEvent" TO resolve_evidence,resolve_evidence_test;
GRANT UPDATE ON "Evidence","OutboxEvent" TO resolve_evidence,resolve_evidence_test;
GRANT INSERT ON "CaseTimelineEvent" TO resolve_evidence,resolve_evidence_test;
CREATE POLICY assigned_discovery ON "EvidenceWorkerTenant" FOR SELECT TO resolve_evidence,resolve_evidence_test USING("roleName"=current_user);
DO $$DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['Evidence','Case','OutboxEvent','CaseTimelineEvent'] LOOP
 EXECUTE format('CREATE POLICY evidence_worker ON %I TO resolve_evidence,resolve_evidence_test USING("merchantId"=NULLIF(current_setting(''app.merchant_id'',true),'''')::uuid AND EXISTS(SELECT 1 FROM "EvidenceWorkerTenant" a WHERE a."merchantId"=%I."merchantId" AND a."roleName"=current_user)) WITH CHECK("merchantId"=NULLIF(current_setting(''app.merchant_id'',true),'''')::uuid AND EXISTS(SELECT 1 FROM "EvidenceWorkerTenant" a WHERE a."merchantId"=%I."merchantId" AND a."roleName"=current_user))',t,t,t);
 END LOOP; END$$;
-- Evidence roles have no privileges on Order, Capture, User, Session or RefundOperation.