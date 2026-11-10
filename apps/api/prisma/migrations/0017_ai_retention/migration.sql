-- Only expired encrypted derivatives may be purged; immutable hashes and metadata survive.
DROP TRIGGER immutable ON "EvidenceExtraction";
CREATE FUNCTION guard_ai_extraction() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 IF TG_OP='UPDATE' AND OLD."createdAt"<now()-interval '30 days' AND NEW."textEncrypted"='' AND (to_jsonb(NEW)-'textEncrypted')=(to_jsonb(OLD)-'textEncrypted') THEN RETURN NEW;END IF;
 RAISE EXCEPTION 'Immutable evidence extraction';END$$;
CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON "EvidenceExtraction" FOR EACH ROW EXECUTE FUNCTION guard_ai_extraction();
CREATE OR REPLACE FUNCTION ai_purge_expired() RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$DECLARE m uuid:=NULLIF(current_setting('app.merchant_id',true),'')::uuid;n integer;BEGIN
 IF NOT EXISTS(SELECT 1 FROM public."AIWorkerTenant" WHERE "merchantId"=m AND "roleName"=session_user) THEN RAISE EXCEPTION 'Unauthorized AI cleanup';END IF;
 UPDATE public."AIContext" SET state='EXPIRED',"baseEncrypted"='',"requestEncrypted"=NULL,"catalogEncrypted"=NULL WHERE "merchantId"=m AND "expiresAt"<now() AND state<>'EXPIRED';GET DIAGNOSTICS n=ROW_COUNT;
 UPDATE public."Analysis" SET status='STALE' WHERE "merchantId"=m AND "contextId" IN(SELECT id FROM public."AIContext" WHERE "merchantId"=m AND state='EXPIRED');
 UPDATE public."Analysis" SET "outputEncrypted"=NULL WHERE "merchantId"=m AND "contextId" IN(SELECT id FROM public."AIContext" WHERE "merchantId"=m AND state='EXPIRED');
 UPDATE public."EvidenceExtraction" SET "textEncrypted"='' WHERE "merchantId"=m AND "createdAt"<now()-interval '30 days' AND "textEncrypted"<>'';
 RETURN n;END$$;