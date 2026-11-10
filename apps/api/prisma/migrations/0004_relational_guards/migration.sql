-- Check old and new parents, including concurrent publication, before clause mutation.
CREATE OR REPLACE FUNCTION guard_policy_clause() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE published timestamptz;
BEGIN
 IF TG_OP IN ('UPDATE','DELETE') THEN
  SELECT "publishedAt" INTO published FROM public."PolicyVersion" WHERE id=OLD."policyVersionId" AND "merchantId"=OLD."merchantId" FOR SHARE;
  IF published IS NOT NULL THEN RAISE EXCEPTION 'Published clauses are immutable'; END IF;
 END IF;
 IF TG_OP IN ('INSERT','UPDATE') THEN
  SELECT "publishedAt" INTO published FROM public."PolicyVersion" WHERE id=NEW."policyVersionId" AND "merchantId"=NEW."merchantId" FOR SHARE;
  IF published IS NOT NULL THEN RAISE EXCEPTION 'Published clauses are immutable'; END IF;
  RETURN NEW;
 END IF;
 RETURN OLD;
END $$;
ALTER TABLE "Proposal" ADD CONSTRAINT "supersedes_same_case" FOREIGN KEY ("merchantId","supersedesId","caseId") REFERENCES "Proposal" ("merchantId",id,"caseId");
ALTER TABLE "ExternalRefund" ADD CONSTRAINT "external_capture_account" FOREIGN KEY ("merchantId","captureId","accountId") REFERENCES "Capture" ("merchantId",id,"accountId");
CREATE UNIQUE INDEX "checkout_provider_identity" ON "CheckoutOperation" ("accountId","providerOrderId",kind) WHERE "providerOrderId" IS NOT NULL;
CREATE UNIQUE INDEX "capture_provider_order" ON "Capture" ("accountId","providerOrderId");