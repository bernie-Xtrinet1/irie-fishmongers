-- Migration #80: Append-only immutable audit log for Primary Administrator delegation
-- of User.canManageCataloguePhotos to active OPERATIONS_STAFF accounts.

CREATE TYPE "UserPermissionAuditAction" AS ENUM (
  'GRANT_CATALOGUE_PHOTO_ACCESS',
  'REVOKE_CATALOGUE_PHOTO_ACCESS'
);

CREATE TABLE "user_permission_audit_logs" (
  "id" TEXT NOT NULL,
  "targetUserId" TEXT NOT NULL,
  "targetEmail" TEXT NOT NULL,
  "actorUserId" TEXT NOT NULL,
  "actorEmail" TEXT NOT NULL,
  "permissionName" TEXT NOT NULL,
  "action" "UserPermissionAuditAction" NOT NULL,
  "previousValue" BOOLEAN NOT NULL,
  "newValue" BOOLEAN NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "user_permission_audit_logs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "user_permission_audit_logs_targetUserId_createdAt_idx"
  ON "user_permission_audit_logs"("targetUserId", "createdAt");
CREATE INDEX "user_permission_audit_logs_actorUserId_createdAt_idx"
  ON "user_permission_audit_logs"("actorUserId", "createdAt");
CREATE INDEX "user_permission_audit_logs_permissionName_createdAt_idx"
  ON "user_permission_audit_logs"("permissionName", "createdAt");

ALTER TABLE "user_permission_audit_logs"
  ADD CONSTRAINT "user_permission_audit_logs_targetUserId_fkey"
  FOREIGN KEY ("targetUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "user_permission_audit_logs"
  ADD CONSTRAINT "user_permission_audit_logs_actorUserId_fkey"
  FOREIGN KEY ("actorUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE OR REPLACE FUNCTION "guard_user_permission_audit_logs_immutable"()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'user_permission_audit_logs is append-only; % is prohibited', TG_OP
    USING ERRCODE = '23514';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "user_permission_audit_logs_immutable_guard"
  BEFORE UPDATE OR DELETE ON "user_permission_audit_logs"
  FOR EACH ROW
  EXECUTE FUNCTION "guard_user_permission_audit_logs_immutable"();

CREATE TRIGGER "zz_user_permission_audit_logs_truncate_guard"
  BEFORE TRUNCATE ON "user_permission_audit_logs"
  FOR EACH STATEMENT
  EXECUTE FUNCTION "guard_user_permission_audit_logs_immutable"();
