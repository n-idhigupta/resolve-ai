ALTER TABLE "CheckoutOperation" ADD COLUMN "postAttempts" integer NOT NULL DEFAULT 0 CHECK ("postAttempts">=0);
-- Rejected deliveries cannot consume every slot and permanently poison an event ID.
CREATE OR REPLACE FUNCTION public.ingest_paypal_receipt(p_account text,p_event text,p_hash text,p_encrypted text,p_headers jsonb) RETURNS TABLE("merchantId" uuid,"receiptId" uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE a record; inbox uuid; receipt uuid;
BEGIN
 IF length(p_account)>100 OR length(p_event)>128 OR length(p_hash)<>64 OR octet_length(p_encrypted)>400000 OR octet_length(p_headers::text)>12000 THEN RAISE EXCEPTION 'Invalid receipt'; END IF;
 SELECT * INTO a FROM public."PaymentAccount" WHERE "accountKey"=p_account AND enabled AND environment='sandbox';IF NOT FOUND THEN RETURN;END IF;
 INSERT INTO public."WebhookInbox"("merchantId","accountId","providerEventId") VALUES(a."merchantId",a.id,p_event) ON CONFLICT("accountId","providerEventId") DO NOTHING;
 SELECT id INTO inbox FROM public."WebhookInbox" WHERE "accountId"=a.id AND "providerEventId"=p_event FOR UPDATE;
 SELECT id INTO receipt FROM public."WebhookReceipt" WHERE "inboxId"=inbox AND "receiptHash"=p_hash;
 IF receipt IS NOT NULL THEN RETURN QUERY SELECT a."merchantId",receipt;RETURN;END IF;
 IF (SELECT count(*) FROM public."WebhookReceipt" WHERE "inboxId"=inbox AND "verificationStatus"<>'REJECTED')>19 THEN RAISE EXCEPTION 'Receipt limit exceeded';END IF;
 INSERT INTO public."WebhookReceipt"("merchantId","inboxId","originalPayloadEncryptedRef","payloadHash","receiptHash","redactedHeaders") VALUES(a."merchantId",inbox,p_encrypted,p_hash,p_hash,p_headers) RETURNING id INTO receipt;
 INSERT INTO public."OutboxEvent"("merchantId","aggregateType","aggregateId","eventType","schemaVersion","payloadIds","dedupeKey") VALUES(a."merchantId",'WebhookReceipt',receipt,'payment.webhook',1,jsonb_build_object('receiptId',receipt),'receipt-'||receipt);
 RETURN QUERY SELECT a."merchantId",receipt;
END $$;