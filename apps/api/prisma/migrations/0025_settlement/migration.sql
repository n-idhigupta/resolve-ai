BEGIN;
ALTER TABLE "PaymentAccount" ADD COLUMN "refundMode" text NOT NULL DEFAULT 'disabled' CHECK("refundMode" IN ('disabled','mock','paypal'));
ALTER TABLE "RefundOperation" ADD COLUMN "requestPayload" jsonb,ADD COLUMN "firstDispatchAt" timestamptz;
CREATE TABLE "Settlement"(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),"merchantId" uuid NOT NULL,"caseId" uuid NOT NULL,"proposalId" uuid NOT NULL,"contentHash" text NOT NULL,"contextHash" text NOT NULL,"acceptedBy" uuid NOT NULL REFERENCES "User"(id),"acceptedProposalVersion" integer NOT NULL,"acceptedAt" timestamptz NOT NULL DEFAULT now(),"authorizedBy" uuid REFERENCES "User"(id),"authorizedAt" timestamptz,"refundOperationId" uuid,"state" text NOT NULL DEFAULT 'ACCEPTED' CHECK(state IN ('ACCEPTED','AUTHORIZED','COMPLETED','FAILED','REVIEW_REQUIRED','CANCELLED','FULFILLMENT_PENDING')),version integer NOT NULL DEFAULT 0,UNIQUE("merchantId",id),UNIQUE("merchantId","proposalId"),FOREIGN KEY("merchantId","proposalId","caseId") REFERENCES "Proposal"("merchantId",id,"caseId"),FOREIGN KEY("merchantId","refundOperationId") REFERENCES "RefundOperation"("merchantId",id));
ALTER TABLE "Settlement" ENABLE ROW LEVEL SECURITY;ALTER TABLE "Settlement" FORCE ROW LEVEL SECURITY;
CREATE POLICY migration_access ON "Settlement" TO resolve_migrator USING(true) WITH CHECK(true);
CREATE POLICY visible ON "Settlement" FOR SELECT TO resolve_runtime,resolve_test USING("merchantId"=NULLIF(current_setting('app.merchant_id',true),'')::uuid AND case_visible("merchantId","caseId"));
CREATE POLICY accept ON "Settlement" FOR INSERT TO resolve_runtime,resolve_test WITH CHECK("merchantId"=NULLIF(current_setting('app.merchant_id',true),'')::uuid AND "acceptedBy"=NULLIF(current_setting('app.user_id',true),'')::uuid AND EXISTS(SELECT 1 FROM "Case" c WHERE c.id="Settlement"."caseId" AND c."openedBy"="Settlement"."acceptedBy") AND state='ACCEPTED');
CREATE POLICY mutate ON "Settlement" FOR UPDATE TO resolve_runtime,resolve_test USING("merchantId"=NULLIF(current_setting('app.merchant_id',true),'')::uuid AND case_visible("merchantId","caseId")) WITH CHECK("merchantId"=NULLIF(current_setting('app.merchant_id',true),'')::uuid AND case_visible("merchantId","caseId"));
GRANT SELECT,INSERT,UPDATE ON "Settlement" TO resolve_runtime,resolve_test;
GRANT SELECT,INSERT ON "Approval" TO resolve_runtime,resolve_test;
CREATE UNIQUE INDEX settlement_approval_actor ON "Approval"("merchantId","proposalId","actorRole");
CREATE POLICY customer_approval_read ON "Approval" FOR SELECT TO resolve_runtime,resolve_test USING("merchantId"=NULLIF(current_setting('app.merchant_id',true),'')::uuid AND "actorUserId"=NULLIF(current_setting('app.user_id',true),'')::uuid);
CREATE POLICY settlement_approval ON "Approval" FOR INSERT TO resolve_runtime,resolve_test WITH CHECK("merchantId"=NULLIF(current_setting('app.merchant_id',true),'')::uuid AND "actorUserId"=NULLIF(current_setting('app.user_id',true),'')::uuid AND EXISTS(SELECT 1 FROM "Proposal" p JOIN "Case" c ON c.id=p."caseId" WHERE p.id="Approval"."proposalId" AND p."contentHash"="Approval"."contentHash" AND p."policyVersionId"="Approval"."policyVersionId" AND (("actorRole"='CUSTOMER' AND c."openedBy"="Approval"."actorUserId") OR ("actorRole"='MERCHANT' AND EXISTS(SELECT 1 FROM "Membership" m WHERE m."merchantId"=p."merchantId" AND m."userId"="Approval"."actorUserId" AND m.active AND m.role IN ('OWNER','APPROVER'))))));
GRANT UPDATE("currentProposalId",status,version,"updatedAt","resolvedAt") ON "Case" TO resolve_runtime,resolve_test;
GRANT SELECT ON "Settlement","RefundOperation","Case","Proposal" TO resolve_payments,resolve_payments_test;
GRANT UPDATE ON "RefundOperation" TO resolve_payments,resolve_payments_test;
GRANT UPDATE(state,version) ON "Settlement" TO resolve_payments,resolve_payments_test;
GRANT UPDATE("reservedMinor","refundedMinor",version) ON "Capture" TO resolve_payments,resolve_payments_test;
GRANT UPDATE(status,version,"resolvedAt","updatedAt") ON "Case" TO resolve_payments,resolve_payments_test;
GRANT UPDATE(status,"rowVersion","completedAt") ON "Proposal" TO resolve_payments,resolve_payments_test;
GRANT SELECT,INSERT ON "CaseTimelineEvent" TO resolve_payments,resolve_payments_test;
DO $$DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['Settlement','RefundOperation','Case','Proposal','CaseTimelineEvent'] LOOP
 EXECUTE format('CREATE POLICY settlement_worker ON %I TO resolve_payments,resolve_payments_test USING("merchantId"=NULLIF(current_setting(''app.merchant_id'',true),'''')::uuid AND EXISTS(SELECT 1 FROM "PaymentAccount" a WHERE a."merchantId"=%I."merchantId" AND a.enabled AND a."workerRoleName"=current_user)) WITH CHECK("merchantId"=NULLIF(current_setting(''app.merchant_id'',true),'''')::uuid AND EXISTS(SELECT 1 FROM "PaymentAccount" a WHERE a."merchantId"=%I."merchantId" AND a.enabled AND a."workerRoleName"=current_user))',t,t,t);
 END LOOP;END$$;
CREATE FUNCTION settlement_immutable() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Immutable settlement';END IF;
 IF (NEW.id,NEW."merchantId",NEW."caseId",NEW."proposalId",NEW."contentHash",NEW."contextHash",NEW."acceptedBy",NEW."acceptedAt",NEW."acceptedProposalVersion") IS DISTINCT FROM (OLD.id,OLD."merchantId",OLD."caseId",OLD."proposalId",OLD."contentHash",OLD."contextHash",OLD."acceptedBy",OLD."acceptedAt",OLD."acceptedProposalVersion") OR (OLD."authorizedAt" IS NOT NULL AND (NEW."authorizedBy",NEW."authorizedAt",NEW."refundOperationId") IS DISTINCT FROM (OLD."authorizedBy",OLD."authorizedAt",OLD."refundOperationId")) THEN RAISE EXCEPTION 'Immutable settlement consent';END IF;
 RETURN NEW;END$$;
CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON "Settlement" FOR EACH ROW EXECUTE FUNCTION settlement_immutable();
-- Retain the A guard for non-settlement transitions; add narrow exact-consent transitions.
ALTER FUNCTION negotiation_transition_guard() RENAME TO negotiation_a_transition_guard;
DROP TRIGGER negotiation_transition ON "Proposal";
CREATE FUNCTION settlement_proposal_guard() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 IF current_user='resolve_migrator' OR NEW.status IS NOT DISTINCT FROM OLD.status THEN RETURN NEW;END IF;
 IF NEW."rowVersion"<>OLD."rowVersion"+1 THEN RAISE EXCEPTION 'Proposal version required';END IF;
 IF OLD.status='OFFERED' AND NEW.status='AGREED' AND EXISTS(SELECT 1 FROM "Settlement" s WHERE s."proposalId"=OLD.id AND s.state='ACCEPTED' AND s."contentHash"=OLD."contentHash" AND s."acceptedBy"=NULLIF(current_setting('app.user_id',true),'')::uuid) THEN RETURN NEW;END IF;
 IF OLD.status='AGREED' AND NEW.status IN ('EXECUTING','FULFILLED','WITHDRAWN') AND EXISTS(SELECT 1 FROM "Settlement" s WHERE s."proposalId"=OLD.id AND ((NEW.status='EXECUTING' AND s.state='AUTHORIZED') OR (NEW.status='FULFILLED' AND s.state='COMPLETED') OR (NEW.status='WITHDRAWN' AND s.state='CANCELLED'))) THEN RETURN NEW;END IF;
 IF OLD.status='EXECUTING' AND NEW.status='FULFILLED' AND EXISTS(SELECT 1 FROM "Settlement" s WHERE s."proposalId"=OLD.id AND s.state='COMPLETED') THEN RETURN NEW;END IF;
 IF OLD.status IN ('DRAFT','OFFERED') AND NEW.status IN ('REJECTED','WITHDRAWN','EXPIRED','SUPERSEDED','OFFERED') THEN
  IF NEW.status='OFFERED' AND NOT EXISTS(SELECT 1 FROM "Membership" m WHERE m."merchantId"=OLD."merchantId" AND m."userId"=NULLIF(current_setting('app.user_id',true),'')::uuid AND m.active AND m.role IN ('OWNER','APPROVER')) THEN RAISE EXCEPTION 'Approver required';END IF;
  IF NEW.status='OFFERED' AND (OLD.status<>'DRAFT' OR OLD."authorRole"<>'MERCHANT' OR OLD."expiresAt"<=now()) THEN RAISE EXCEPTION 'Invalid publication';END IF;
  IF NEW.status='EXPIRED' AND OLD."expiresAt">now() THEN RAISE EXCEPTION 'Not expired';END IF;
  IF NEW.status='WITHDRAWN' AND NOT((case_member(OLD."merchantId") AND OLD."authorRole"='MERCHANT') OR (NOT case_member(OLD."merchantId") AND OLD."createdBy"=NULLIF(current_setting('app.user_id',true),'')::uuid)) THEN RAISE EXCEPTION 'Not offer author';END IF;
  IF NEW.status='REJECTED' AND ((case_member(OLD."merchantId") AND OLD."authorRole"<>'CUSTOMER') OR (NOT case_member(OLD."merchantId") AND OLD.status<>'OFFERED')) THEN RAISE EXCEPTION 'Invalid rejection';END IF;RETURN NEW;
 END IF;RAISE EXCEPTION 'Invalid settlement transition';END$$;
CREATE TRIGGER negotiation_transition BEFORE UPDATE ON "Proposal" FOR EACH ROW EXECUTE FUNCTION settlement_proposal_guard();
CREATE FUNCTION protect_refund_request() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 IF (NEW."merchantId",NEW."captureId",NEW."proposalId",NEW."orderId",NEW."accountId",NEW."amountMinor",NEW.currency,NEW."providerRequestId",NEW."requestHash",NEW."requestPayload") IS DISTINCT FROM (OLD."merchantId",OLD."captureId",OLD."proposalId",OLD."orderId",OLD."accountId",OLD."amountMinor",OLD.currency,OLD."providerRequestId",OLD."requestHash",OLD."requestPayload") OR (OLD."providerRefundId" IS NOT NULL AND NEW."providerRefundId" IS DISTINCT FROM OLD."providerRefundId") OR (OLD."firstDispatchAt" IS NOT NULL AND NEW."firstDispatchAt" IS DISTINCT FROM OLD."firstDispatchAt") THEN RAISE EXCEPTION 'Immutable refund intent';END IF;RETURN NEW;END$$;
CREATE TRIGGER refund_request BEFORE UPDATE ON "RefundOperation" FOR EACH ROW EXECUTE FUNCTION protect_refund_request();
CREATE FUNCTION refund_authorization_current(p_id uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT EXISTS(SELECT 1 FROM "RefundOperation" r JOIN "PaymentAccount" a ON a.id=r."accountId" JOIN "Settlement" s ON s."refundOperationId"=r.id JOIN "Case" c ON c.id=s."caseId" JOIN "Merchant" m ON m.id=c."merchantId" JOIN "Proposal" p ON p.id=s."proposalId" WHERE r.id=p_id AND r."merchantId"=NULLIF(current_setting('app.merchant_id',true),'')::uuid AND a.enabled AND a."workerRoleName"=session_user AND m.status='ACTIVE' AND s.state IN ('AUTHORIZED','REVIEW_REQUIRED') AND p.status='EXECUTING' AND p."expiresAt">now() AND EXISTS(SELECT 1 FROM "Approval" ca WHERE ca."proposalId"=p.id AND ca."actorRole"='CUSTOMER' AND ca."actorUserId"=c."openedBy" AND ca.decision='ACCEPT' AND ca."contentHash"=p."contentHash") AND EXISTS(SELECT 1 FROM "Approval" ma JOIN "Membership" mm ON mm."userId"=ma."actorUserId" AND mm."merchantId"=r."merchantId" WHERE ma."proposalId"=p.id AND ma."actorRole"='MERCHANT' AND ma.decision='ACCEPT' AND ma."contentHash"=p."contentHash" AND mm.active AND mm.role IN ('OWNER','APPROVER')));
$$;REVOKE ALL ON FUNCTION refund_authorization_current(uuid) FROM PUBLIC;GRANT EXECUTE ON FUNCTION refund_authorization_current(uuid) TO resolve_payments,resolve_payments_test;

COMMIT;
