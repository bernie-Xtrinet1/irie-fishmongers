-- Migration #72: Seed the OPERATIONS_STAFF role row in "roles" in its own
-- transaction after 20261125000000 commits the RoleName enum value (avoids PG 55P04).

INSERT INTO "roles" ("id", "name", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, 'OPERATIONS_STAFF'::"RoleName", NOW(), NOW()
WHERE NOT EXISTS (
  SELECT 1 FROM "roles" WHERE "name"::text = 'OPERATIONS_STAFF'
);
