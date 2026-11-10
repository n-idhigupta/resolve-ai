-- Row locking requires UPDATE privileges, but Phase 2 exposes no workflow mutations.
GRANT UPDATE(version) ON "Case" TO resolve_runtime,resolve_test;
GRANT UPDATE("rowVersion") ON "Proposal" TO resolve_runtime,resolve_test;
CREATE POLICY approver_case_lock ON "Case" FOR UPDATE TO resolve_runtime,resolve_test
USING("merchantId"=NULLIF(current_setting('app.merchant_id',true),'')::uuid AND EXISTS(SELECT 1 FROM public."Membership" m WHERE m."merchantId"="Case"."merchantId" AND m."userId"=NULLIF(current_setting('app.user_id',true),'')::uuid AND m.active AND m.role IN ('OWNER','APPROVER')))
WITH CHECK("merchantId"=NULLIF(current_setting('app.merchant_id',true),'')::uuid);
CREATE POLICY approver_proposal_lock ON "Proposal" FOR UPDATE TO resolve_runtime,resolve_test
USING("merchantId"=NULLIF(current_setting('app.merchant_id',true),'')::uuid AND EXISTS(SELECT 1 FROM public."Membership" m WHERE m."merchantId"="Proposal"."merchantId" AND m."userId"=NULLIF(current_setting('app.user_id',true),'')::uuid AND m.active AND m.role IN ('OWNER','APPROVER')))
WITH CHECK("merchantId"=NULLIF(current_setting('app.merchant_id',true),'')::uuid);
-- Fixed, boolean-only lookup for validating a different original merchant approver.
CREATE FUNCTION public.is_active_approver(p_merchant uuid,p_user uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT p_merchant=NULLIF(current_setting('app.merchant_id',true),'')::uuid
 AND EXISTS(SELECT 1 FROM public."Membership" a WHERE a."merchantId"=p_merchant AND a."userId"=NULLIF(current_setting('app.user_id',true),'')::uuid AND a.active AND a.role IN ('OWNER','APPROVER'))
 AND EXISTS(SELECT 1 FROM public."Membership" m WHERE m."merchantId"=p_merchant AND m."userId"=p_user AND m.active AND m.role IN ('OWNER','APPROVER'));
$$;
REVOKE ALL ON FUNCTION public.is_active_approver(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_active_approver(uuid,uuid) TO resolve_runtime,resolve_test;