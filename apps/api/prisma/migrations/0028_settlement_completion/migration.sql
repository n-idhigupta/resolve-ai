BEGIN;
-- Customers may acknowledge nonfinancial replacement receipt through the existing transaction.
GRANT UPDATE("completedAt") ON "Proposal" TO resolve_runtime,resolve_test;
ALTER TABLE "Settlement" ADD CONSTRAINT authorization_shape CHECK(
 (state IN ('ACCEPTED','CANCELLED') AND "authorizedAt" IS NULL AND "authorizedBy" IS NULL AND "refundOperationId" IS NULL)
 OR (state IN ('AUTHORIZED','REVIEW_REQUIRED','FAILED') AND "authorizedAt" IS NOT NULL AND "authorizedBy" IS NOT NULL AND "refundOperationId" IS NOT NULL)
 OR (state='FULFILLMENT_PENDING' AND "authorizedAt" IS NOT NULL AND "authorizedBy" IS NOT NULL AND "refundOperationId" IS NULL)
 OR (state='COMPLETED' AND "authorizedAt" IS NOT NULL AND "authorizedBy" IS NOT NULL));
CREATE FUNCTION guard_settlement_state() RETURNS trigger LANGUAGE plpgsql AS $$DECLARE u uuid:=NULLIF(current_setting('app.user_id',true),'')::uuid;BEGIN
 IF current_user='resolve_migrator' OR NEW.state=OLD.state THEN RETURN NEW;END IF;
 IF OLD.state IN ('COMPLETED','CANCELLED','FAILED') THEN RAISE EXCEPTION 'Terminal settlement';END IF;
 IF NEW.state='CANCELLED' AND OLD.state='ACCEPTED' AND (OLD."acceptedBy"=u OR case_member(OLD."merchantId")) THEN RETURN NEW;END IF;
 IF OLD.state='ACCEPTED' AND NEW.state IN ('AUTHORIZED','FULFILLMENT_PENDING') THEN
  IF NEW."authorizedBy" IS DISTINCT FROM u OR NOT EXISTS(SELECT 1 FROM "Membership" m WHERE m."merchantId"=OLD."merchantId" AND m."userId"=u AND m.active AND m.role IN ('OWNER','APPROVER')) OR NOT EXISTS(SELECT 1 FROM "Approval" a WHERE a."proposalId"=OLD."proposalId" AND a."actorRole"='MERCHANT' AND a."actorUserId"=u AND a.decision='ACCEPT' AND a."contentHash"=OLD."contentHash") THEN RAISE EXCEPTION 'Merchant financial authorization required';END IF;
  IF NEW.state='AUTHORIZED' AND NOT EXISTS(SELECT 1 FROM "RefundOperation" r JOIN "Proposal" p ON p.id=r."proposalId" WHERE r.id=NEW."refundOperationId" AND p.id=OLD."proposalId" AND r."amountMinor"=p."amountMinor" AND r.currency=p.currency) THEN RAISE EXCEPTION 'Refund intent mismatch';END IF;RETURN NEW;
 END IF;
 IF current_user IN ('resolve_payments','resolve_payments_test') AND OLD.state IN ('AUTHORIZED','REVIEW_REQUIRED') AND EXISTS(SELECT 1 FROM "RefundOperation" r WHERE r.id=OLD."refundOperationId" AND ((NEW.state='COMPLETED' AND r.state='COMPLETED') OR (NEW.state='FAILED' AND r.state='FAILED') OR (NEW.state='REVIEW_REQUIRED' AND r.state='UNKNOWN') OR (NEW.state='AUTHORIZED' AND r.state='PENDING'))) THEN RETURN NEW;END IF;
 IF OLD.state='FULFILLMENT_PENDING' AND NEW.state='COMPLETED' AND OLD."acceptedBy"=u AND EXISTS(SELECT 1 FROM "CaseTimelineEvent" e WHERE e."caseId"=OLD."caseId" AND e.action='REPLACEMENT_SHIPPED' AND e.metadata->>'settlementId'=OLD.id::text) THEN RETURN NEW;END IF;
 RAISE EXCEPTION 'Invalid settlement transition';END$$;
CREATE TRIGGER settlement_state_guard BEFORE UPDATE ON "Settlement" FOR EACH ROW EXECUTE FUNCTION guard_settlement_state();
CREATE FUNCTION guard_proposal_completion_time() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 IF current_user<>'resolve_migrator' AND NEW."completedAt" IS DISTINCT FROM OLD."completedAt" AND NOT(NEW.status='FULFILLED' AND EXISTS(SELECT 1 FROM "Settlement" s WHERE s."proposalId"=OLD.id AND s.state='COMPLETED')) THEN RAISE EXCEPTION 'Completion requires settled terms';END IF;RETURN NEW;END$$;
CREATE TRIGGER proposal_completion_guard BEFORE UPDATE ON "Proposal" FOR EACH ROW EXECUTE FUNCTION guard_proposal_completion_time();
COMMIT;
