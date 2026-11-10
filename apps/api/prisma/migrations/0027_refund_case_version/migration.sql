BEGIN;
-- UPDATE version=version+1 needs SELECT on version in addition to UPDATE.
-- Keep complaint descriptions and private proposal terms inaccessible to payments workers.
GRANT SELECT(version) ON "Case" TO resolve_payments,resolve_payments_test;
COMMIT;
