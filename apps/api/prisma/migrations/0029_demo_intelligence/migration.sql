BEGIN;
CREATE TABLE "DemoTenant"("merchantId" uuid PRIMARY KEY REFERENCES "Merchant"(id),"createdAt" timestamptz NOT NULL DEFAULT now());
ALTER TABLE "DemoTenant" ENABLE ROW LEVEL SECURITY;ALTER TABLE "DemoTenant" FORCE ROW LEVEL SECURITY;
CREATE POLICY migration_access ON "DemoTenant" TO resolve_migrator USING(true) WITH CHECK(true);
CREATE POLICY tenant_read ON "DemoTenant" FOR SELECT TO resolve_runtime,resolve_test USING("merchantId"=NULLIF(current_setting('app.merchant_id',true),'')::uuid AND (case_member("merchantId") OR EXISTS(SELECT 1 FROM "CustomerOrder" c WHERE c."merchantId"="DemoTenant"."merchantId" AND c."userId"=NULLIF(current_setting('app.user_id',true),'')::uuid)));
CREATE POLICY worker_read ON "DemoTenant" FOR SELECT TO resolve_ai,resolve_ai_test,resolve_evidence,resolve_evidence_test USING(EXISTS(SELECT 1 FROM "AIWorkerTenant" a WHERE a."merchantId"="DemoTenant"."merchantId" AND a."roleName"=current_user) OR EXISTS(SELECT 1 FROM "EvidenceWorkerTenant" a WHERE a."merchantId"="DemoTenant"."merchantId" AND a."roleName"=current_user));
-- Each worker may reference only its existing assignment table in RLS, avoiding new cross-role grants.
DROP POLICY worker_read ON "DemoTenant";
CREATE POLICY ai_read ON "DemoTenant" FOR SELECT TO resolve_ai,resolve_ai_test USING(EXISTS(SELECT 1 FROM "AIWorkerTenant" a WHERE a."merchantId"="DemoTenant"."merchantId" AND a."roleName"=current_user));
CREATE POLICY evidence_read ON "DemoTenant" FOR SELECT TO resolve_evidence,resolve_evidence_test USING(EXISTS(SELECT 1 FROM "EvidenceWorkerTenant" a WHERE a."merchantId"="DemoTenant"."merchantId" AND a."roleName"=current_user));
GRANT SELECT ON "DemoTenant" TO resolve_runtime,resolve_test,resolve_ai,resolve_ai_test,resolve_evidence,resolve_evidence_test;
ALTER TABLE "AISharingPolicy" ADD COLUMN "executionMode" text NOT NULL DEFAULT 'external' CHECK("executionMode" IN ('external','mock'));
CREATE FUNCTION guard_mock_sharing() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF NEW."executionMode"='mock' AND (NEW."providerId"<>'openai' OR NOT EXISTS(SELECT 1 FROM "DemoTenant" d WHERE d."merchantId"=NEW."merchantId")) THEN RAISE EXCEPTION 'Mock sharing requires an authorized demo tenant';END IF;RETURN NEW;END$$;
CREATE TRIGGER mock_sharing_guard BEFORE INSERT ON "AISharingPolicy" FOR EACH ROW EXECUTE FUNCTION guard_mock_sharing();
COMMIT;
