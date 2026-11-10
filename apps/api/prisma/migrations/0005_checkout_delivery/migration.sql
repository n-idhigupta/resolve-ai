ALTER TABLE "PaymentAccount" ADD COLUMN enabled boolean NOT NULL DEFAULT false, ADD COLUMN "workerRoleName" text;
ALTER TABLE "Order" ADD COLUMN "paymentState" text NOT NULL DEFAULT 'NOT_STARTED';
ALTER TABLE "Order" ADD CONSTRAINT payment_state_values CHECK ("paymentState" IN ('NOT_STARTED','PENDING','CREATED','AWAITING_BUYER_APPROVAL','APPROVED','CAPTURE_PENDING','CAPTURED','FAILED','CANCELLED','RECONCILIATION_REQUIRED'));
ALTER TABLE "CheckoutOperation" ADD COLUMN "requestedBy" uuid REFERENCES "User"(id), ADD COLUMN "requestPayload" jsonb, ADD COLUMN "providerStatus" text, ADD COLUMN "providerCaptureId" text, ADD COLUMN "approvalUrl" text, ADD COLUMN "firstAttemptAt" timestamptz, ADD COLUMN "retryUntil" timestamptz;
ALTER TABLE "Capture" ADD COLUMN "verifiedAt" timestamptz;
ALTER TABLE "WebhookReceipt" ADD COLUMN "receiptHash" text;
CREATE UNIQUE INDEX webhook_receipt_identity ON "WebhookReceipt"("inboxId","receiptHash") WHERE "receiptHash" IS NOT NULL;
ALTER TABLE "OutboxEvent" ADD COLUMN "leaseOwner" uuid;
DROP INDEX checkout_active_kind;
-- One provider order/capture intent per internal order. Failed/unknown requests never mint replacement IDs.
CREATE UNIQUE INDEX checkout_logical_intent ON "CheckoutOperation"("merchantId","orderId",kind);
CREATE INDEX checkout_reconciliation_due ON "CheckoutOperation"(state,"nextAttemptAt","leaseUntil");
CREATE INDEX worker_account_scope ON "PaymentAccount"("workerRoleName",enabled);
GRANT USAGE ON SCHEMA public TO resolve_payments,resolve_payments_test;
GRANT SELECT ON "PaymentAccount","Order","OrderItem","CheckoutOperation","Capture","PaymentAttempt","OutboxEvent","WebhookInbox","WebhookReceipt" TO resolve_payments,resolve_payments_test;
GRANT INSERT ON "CheckoutOperation","Capture","PaymentAttempt","OutboxEvent","AuditEvent" TO resolve_payments,resolve_payments_test;
GRANT UPDATE("paymentState",status,version,"updatedAt") ON "Order" TO resolve_payments,resolve_payments_test;
GRANT UPDATE ON "CheckoutOperation","PaymentAttempt","OutboxEvent","WebhookInbox","WebhookReceipt" TO resolve_payments,resolve_payments_test;
GRANT UPDATE("providerStatus","reconciliationStatus","discrepancyJson",version,"verifiedAt") ON "Capture" TO resolve_payments,resolve_payments_test;
CREATE POLICY assigned_account_discovery ON "PaymentAccount" FOR SELECT TO resolve_payments,resolve_payments_test USING(enabled AND "workerRoleName"=current_user);
DO $$ DECLARE tab text; BEGIN
 FOREACH tab IN ARRAY ARRAY['Order','OrderItem','CheckoutOperation','Capture','PaymentAttempt','OutboxEvent','WebhookInbox','WebhookReceipt','AuditEvent'] LOOP
 EXECUTE format('CREATE POLICY assigned_worker ON %I TO resolve_payments,resolve_payments_test USING ("merchantId"=NULLIF(current_setting(''app.merchant_id'',true),'''')::uuid AND EXISTS(SELECT 1 FROM public."PaymentAccount" a WHERE a."merchantId"=%I."merchantId" AND a.enabled AND a."workerRoleName"=current_user)) WITH CHECK ("merchantId"=NULLIF(current_setting(''app.merchant_id'',true),'''')::uuid AND EXISTS(SELECT 1 FROM public."PaymentAccount" a WHERE a."merchantId"=%I."merchantId" AND a.enabled AND a."workerRoleName"=current_user))',tab,tab,tab);
 END LOOP;
END $$;
-- Only an order owner may create checkout intents. Actor IDs are set by authenticated API code.
GRANT UPDATE(version) ON "Order" TO resolve_runtime,resolve_test;
CREATE POLICY customer_order_lock ON "Order" FOR UPDATE TO resolve_runtime,resolve_test USING("merchantId"=NULLIF(current_setting('app.merchant_id',true),'')::uuid AND "customerUserId"=NULLIF(current_setting('app.user_id',true),'')::uuid) WITH CHECK("merchantId"=NULLIF(current_setting('app.merchant_id',true),'')::uuid AND "customerUserId"=NULLIF(current_setting('app.user_id',true),'')::uuid);
CREATE POLICY customer_checkout_insert ON "CheckoutOperation" FOR INSERT TO resolve_runtime,resolve_test WITH CHECK("merchantId"=NULLIF(current_setting('app.merchant_id',true),'')::uuid AND "requestedBy"=NULLIF(current_setting('app.user_id',true),'')::uuid AND EXISTS(SELECT 1 FROM public."Order" o WHERE o.id="CheckoutOperation"."orderId" AND o."merchantId"="CheckoutOperation"."merchantId" AND o."customerUserId"=NULLIF(current_setting('app.user_id',true),'')::uuid));
CREATE POLICY customer_account_read ON "PaymentAccount" FOR SELECT TO resolve_runtime,resolve_test USING(enabled AND "merchantId"=NULLIF(current_setting('app.merchant_id',true),'')::uuid AND EXISTS(SELECT 1 FROM public."CustomerOrder" c WHERE c."merchantId"="PaymentAccount"."merchantId" AND c."userId"=NULLIF(current_setting('app.user_id',true),'')::uuid));
CREATE POLICY customer_idempotency ON "IdempotencyRecord" TO resolve_runtime,resolve_test USING("merchantId"=NULLIF(current_setting('app.merchant_id',true),'')::uuid AND "actorId"=NULLIF(current_setting('app.user_id',true),'')::uuid) WITH CHECK("merchantId"=NULLIF(current_setting('app.merchant_id',true),'')::uuid AND "actorId"=NULLIF(current_setting('app.user_id',true),'')::uuid);
CREATE POLICY customer_payment_outbox ON "OutboxEvent" FOR INSERT TO resolve_runtime,resolve_test WITH CHECK("merchantId"=NULLIF(current_setting('app.merchant_id',true),'')::uuid AND "eventType" IN ('payment.create','payment.capture') AND "aggregateType"='CheckoutOperation' AND EXISTS(SELECT 1 FROM public."CheckoutOperation" c WHERE c.id="OutboxEvent"."aggregateId" AND c."merchantId"="OutboxEvent"."merchantId" AND c."requestedBy"=NULLIF(current_setting('app.user_id',true),'')::uuid));
CREATE POLICY customer_payment_audit ON "AuditEvent" FOR INSERT TO resolve_runtime,resolve_test WITH CHECK("merchantId"=NULLIF(current_setting('app.merchant_id',true),'')::uuid AND "actorId"=NULLIF(current_setting('app.user_id',true),'')::uuid AND "aggregateType"='CheckoutOperation' AND EXISTS(SELECT 1 FROM public."CheckoutOperation" c WHERE c.id="AuditEvent"."aggregateId" AND c."merchantId"="AuditEvent"."merchantId" AND c."requestedBy"=NULLIF(current_setting('app.user_id',true),'')::uuid));
-- Immutable outbound payload/key/account prevent retry drift, including after restarts.
CREATE FUNCTION protect_checkout_intent() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF (NEW."merchantId",NEW."orderId",NEW."accountId",NEW.kind,NEW."requestId",NEW."requestHash",NEW."requestPayload",NEW."requestedBy") IS DISTINCT FROM (OLD."merchantId",OLD."orderId",OLD."accountId",OLD.kind,OLD."requestId",OLD."requestHash",OLD."requestPayload",OLD."requestedBy") THEN RAISE EXCEPTION 'Immutable payment intent'; END IF;
 IF OLD."providerOrderId" IS NOT NULL AND NEW."providerOrderId" IS DISTINCT FROM OLD."providerOrderId" THEN RAISE EXCEPTION 'Immutable provider order association'; END IF;
 RETURN NEW; END $$;
CREATE TRIGGER checkout_intent_guard BEFORE UPDATE ON "CheckoutOperation" FOR EACH ROW EXECUTE FUNCTION protect_checkout_intent();
CREATE FUNCTION protect_payable_totals() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE oid uuid; mid uuid; BEGIN
 IF TG_TABLE_NAME='Order' THEN
  IF (NEW."amountMinor",NEW.currency,NEW."customerUserId") IS NOT DISTINCT FROM (OLD."amountMinor",OLD.currency,OLD."customerUserId") THEN RETURN NEW; END IF; oid:=OLD.id;mid:=OLD."merchantId";
 ELSE oid:=CASE WHEN TG_OP='DELETE' THEN OLD."orderId" ELSE NEW."orderId" END;mid:=CASE WHEN TG_OP='DELETE' THEN OLD."merchantId" ELSE NEW."merchantId" END; END IF;
 IF EXISTS(SELECT 1 FROM public."CheckoutOperation" c WHERE c."orderId"=oid AND c."merchantId"=mid) THEN RAISE EXCEPTION 'Checkout totals are frozen'; END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;RETURN NEW; END $$;
CREATE TRIGGER order_total_guard BEFORE UPDATE ON "Order" FOR EACH ROW EXECUTE FUNCTION protect_payable_totals();
CREATE TRIGGER item_total_guard BEFORE INSERT OR UPDATE OR DELETE ON "OrderItem" FOR EACH ROW EXECUTE FUNCTION protect_payable_totals();
-- Public receipt path is a bounded capability, not general tenant-table access.
CREATE FUNCTION public.ingest_paypal_receipt(p_account text,p_event text,p_hash text,p_encrypted text,p_headers jsonb) RETURNS TABLE("merchantId" uuid,"receiptId" uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE a record; inbox uuid; receipt uuid;
BEGIN
 IF length(p_account)>100 OR length(p_event)>128 OR length(p_hash)<>64 OR octet_length(p_encrypted)>400000 OR octet_length(p_headers::text)>12000 THEN RAISE EXCEPTION 'Invalid receipt'; END IF;
 SELECT * INTO a FROM public."PaymentAccount" WHERE "accountKey"=p_account AND enabled AND environment='sandbox';
 IF NOT FOUND THEN RETURN; END IF;
 INSERT INTO public."WebhookInbox"("merchantId","accountId","providerEventId") VALUES(a."merchantId",a.id,p_event) ON CONFLICT("accountId","providerEventId") DO NOTHING;
 SELECT id INTO inbox FROM public."WebhookInbox" WHERE "accountId"=a.id AND "providerEventId"=p_event FOR UPDATE;
 SELECT id INTO receipt FROM public."WebhookReceipt" WHERE "inboxId"=inbox AND "receiptHash"=p_hash;
 IF receipt IS NOT NULL THEN RETURN QUERY SELECT a."merchantId",receipt;RETURN;END IF;
 IF (SELECT count(*) FROM public."WebhookReceipt" WHERE "inboxId"=inbox)>19 THEN RAISE EXCEPTION 'Receipt limit exceeded'; END IF;
 INSERT INTO public."WebhookReceipt"("merchantId","inboxId","originalPayloadEncryptedRef","payloadHash","receiptHash","redactedHeaders") VALUES(a."merchantId",inbox,p_encrypted,p_hash,p_hash,p_headers) RETURNING id INTO receipt;
 INSERT INTO public."OutboxEvent"("merchantId","aggregateType","aggregateId","eventType","schemaVersion","payloadIds","dedupeKey") VALUES(a."merchantId",'WebhookReceipt',receipt,'payment.webhook',1,jsonb_build_object('receiptId',receipt),'receipt-'||receipt);
 RETURN QUERY SELECT a."merchantId",receipt;
END $$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ingest_paypal_receipt(text,text,text,text,jsonb) TO resolve_runtime,resolve_test;