ALTER TABLE "Evidence" ADD COLUMN "promotionKeys" text[] NOT NULL DEFAULT '{}';
CREATE FUNCTION guard_scanned_evidence() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 IF OLD."scanStatus"='CLEAN' AND (NEW."cleanObjectKey",NEW."scannerVersion",NEW."scannedAt",NEW."sizeBytes",NEW."actualSize",NEW."actualHash",NEW."caseId",NEW."merchantId",NEW."uploaderUserId") IS DISTINCT FROM (OLD."cleanObjectKey",OLD."scannerVersion",OLD."scannedAt",OLD."sizeBytes",OLD."actualSize",OLD."actualHash",OLD."caseId",OLD."merchantId",OLD."uploaderUserId") THEN RAISE EXCEPTION 'Scanned evidence immutable'; END IF;
 RETURN NEW;END$$;
CREATE TRIGGER scanned_evidence_guard BEFORE UPDATE ON "Evidence" FOR EACH ROW EXECUTE FUNCTION guard_scanned_evidence();