GRANT SELECT ON "Merchant" TO resolve_payments,resolve_payments_test;
CREATE POLICY worker_merchant_read ON "Merchant" FOR SELECT TO resolve_payments,resolve_payments_test USING(id=NULLIF(current_setting('app.merchant_id',true),'')::uuid AND EXISTS(SELECT 1 FROM public."PaymentAccount" a WHERE a."merchantId"="Merchant".id AND a.enabled AND a."workerRoleName"=current_user));
CREATE OR REPLACE FUNCTION protect_payable_totals() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF TG_TABLE_NAME='Order' THEN
  IF (NEW."amountMinor",NEW.currency,NEW."customerUserId") IS DISTINCT FROM (OLD."amountMinor",OLD.currency,OLD."customerUserId") AND EXISTS(SELECT 1 FROM public."CheckoutOperation" c WHERE c."orderId"=OLD.id AND c."merchantId"=OLD."merchantId") THEN RAISE EXCEPTION 'Checkout totals are frozen'; END IF;RETURN NEW;
 END IF;
 IF TG_OP IN ('UPDATE','DELETE') THEN
  IF EXISTS(SELECT 1 FROM public."CheckoutOperation" c WHERE c."orderId"=OLD."orderId" AND c."merchantId"=OLD."merchantId") THEN RAISE EXCEPTION 'Checkout line items are frozen'; END IF;
 END IF;
 IF TG_OP IN ('UPDATE','INSERT') THEN
  IF EXISTS(SELECT 1 FROM public."CheckoutOperation" c WHERE c."orderId"=NEW."orderId" AND c."merchantId"=NEW."merchantId") THEN RAISE EXCEPTION 'Checkout line items are frozen'; END IF;RETURN NEW;
 END IF;RETURN OLD;
END $$;