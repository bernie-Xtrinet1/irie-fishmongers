-- Historical manifests may reference the same canonical physical hold.
-- Restoring global uniqueness requires proving duplicate references absent;
-- never rewrite immutable historical resources to make that rollback possible.
DROP INDEX "checkout_reservation_resources_holdInstanceId_key";
