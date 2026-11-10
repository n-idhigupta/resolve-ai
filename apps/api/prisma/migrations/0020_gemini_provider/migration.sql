ALTER TABLE "AISharingPolicy" ADD COLUMN "providerId" text NOT NULL DEFAULT 'openai';
ALTER TABLE "AISharingPolicy" ADD CONSTRAINT provider_model_pair CHECK(("providerId"='openai' AND "modelId"='gpt-5.4-mini-2026-03-17') OR ("providerId"='gemini' AND "modelId"='gemini-2.5-flash'));
ALTER TABLE "Case" ADD COLUMN "aiSyntheticAuthorized" boolean NOT NULL DEFAULT false;
CREATE FUNCTION guard_ai_synthetic() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 IF ((TG_OP='INSERT' AND NEW."aiSyntheticAuthorized") OR (TG_OP='UPDATE' AND NEW."aiSyntheticAuthorized" IS DISTINCT FROM OLD."aiSyntheticAuthorized")) AND session_user<>'resolve_migrator' THEN RAISE EXCEPTION 'Synthetic fixture provenance requires migration authority';END IF;RETURN NEW;END$$;
CREATE TRIGGER ai_synthetic_provenance BEFORE INSERT OR UPDATE ON "Case" FOR EACH ROW EXECUTE FUNCTION guard_ai_synthetic();