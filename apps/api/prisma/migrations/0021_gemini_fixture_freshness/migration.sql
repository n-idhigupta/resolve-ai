ALTER TABLE "Case" ADD COLUMN "aiSyntheticAuthorizedVersion" integer;
UPDATE "Case" SET "aiSyntheticAuthorizedVersion"=version WHERE "aiSyntheticAuthorized";
CREATE OR REPLACE FUNCTION guard_ai_synthetic() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 IF ((TG_OP='INSERT' AND (NEW."aiSyntheticAuthorized" OR NEW."aiSyntheticAuthorizedVersion" IS NOT NULL)) OR (TG_OP='UPDATE' AND (NEW."aiSyntheticAuthorized",NEW."aiSyntheticAuthorizedVersion") IS DISTINCT FROM (OLD."aiSyntheticAuthorized",OLD."aiSyntheticAuthorizedVersion"))) AND session_user<>'resolve_migrator' THEN RAISE EXCEPTION 'Synthetic fixture provenance requires migration authority';END IF;
 IF session_user='resolve_migrator' AND NEW."aiSyntheticAuthorized" AND NEW."aiSyntheticAuthorizedVersion" IS NULL THEN NEW."aiSyntheticAuthorizedVersion":=NEW.version;END IF;
 RETURN NEW;END$$;
CREATE OR REPLACE FUNCTION ai_context_fresh(p_context uuid) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$DECLARE c public."AIContext";u uuid:=NULLIF(current_setting('app.user_id',true),'')::uuid;m uuid:=NULLIF(current_setting('app.merchant_id',true),'')::uuid;BEGIN
 SELECT * INTO c FROM public."AIContext" WHERE id=p_context AND "merchantId"=m;
 IF c.id IS NULL THEN RETURN false;END IF;
 IF NOT(EXISTS(SELECT 1 FROM public."AIWorkerTenant" WHERE "merchantId"=m AND "roleName"=session_user) OR EXISTS(SELECT 1 FROM public."EvidenceWorkerTenant" WHERE "merchantId"=m AND "roleName"=session_user) OR EXISTS(SELECT 1 FROM public."Case" ca WHERE ca.id=c."caseId" AND (ca."openedBy"=u OR EXISTS(SELECT 1 FROM public."Membership" WHERE "merchantId"=m AND "userId"=u AND active)))) THEN RETURN false;END IF;
 PERFORM p.id FROM public."Capture" p JOIN public."Case" ca ON ca."orderId"=p."orderId" AND ca."merchantId"=p."merchantId" WHERE ca.id=c."caseId" FOR SHARE OF p;
 PERFORM id FROM public."Case" WHERE id=c."caseId" FOR UPDATE;
 PERFORM id FROM public."Evidence" WHERE "caseId"=c."caseId" ORDER BY id FOR SHARE;
 IF EXISTS(SELECT 1 FROM public."AISharingPolicy" p WHERE p.id=c."sharingPolicyId" AND p."providerId"='gemini') AND NOT EXISTS(SELECT 1 FROM public."Case" ca WHERE ca.id=c."caseId" AND ca."aiSyntheticAuthorized" AND ca."aiSyntheticAuthorizedVersion"=ca.version) THEN RETURN false;END IF;
 RETURN c."manifest"=public.ai_manifest_raw(c."caseId") AND c."expiresAt">now() AND c.state IN ('QUEUED','PREPARING','READY') AND c."sharingPolicyId"=(SELECT id FROM public."AISharingPolicy" WHERE "merchantId"=m ORDER BY sequence DESC LIMIT 1) AND EXISTS(SELECT 1 FROM public."AISharingPolicy" WHERE id=c."sharingPolicyId" AND enabled);
END$$;
