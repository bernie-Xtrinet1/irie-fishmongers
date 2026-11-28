# Catalogue Photos Access Delegation Architecture & Provisioning

## Overview

The **Admin → Catalogue Photos → Manage Staff Access** workflow lets an active designated **Primary Administrator** grant or revoke `User.canManageCataloguePhotos` for active `OPERATIONS_STAFF` accounts without direct SQL intervention.

## Authority Verification & Reuse

The platform already backs the **Primary Administrator** designation server-side via `User.canAuthorizeVendorSettlements` (PostgreSQL `users."canAuthorizeVendorSettlements"`, default `false`), checked alongside `User.status = ACTIVE` and `RoleName.ADMINISTRATOR` in:

- `JwtAuthGuard` (`backend/src/common/guards/jwt-auth.guard.ts`)
- `AuthService.toUserResponse` (`backend/src/modules/auth/services/auth.service.ts`)
- `PrimaryAdminVendorSettlementGuard` (`backend/src/modules/vendor-settlements/guards/primary-admin-vendor-settlement.guard.ts`)
- `getAdminRoleLabel` / `canAuthorizeVendorSettlements` (`apps/admin-dashboard/lib/auth/admin-access.ts`)

Rather than duplicating a separate top-level Primary Administrator boolean, Catalogue Photos delegation reuses that authoritative server-side capability via `CataloguePhotoDelegationGuard`:

- Every `GET /api/v1/admin/catalogue-photos/staff-access` and `PATCH /api/v1/admin/catalogue-photos/staff-access` request queries PostgreSQL for the actor's live `status`, `roles`, and `canAuthorizeVendorSettlements` (`resolveCatalogueActor`).
- Ordinary `ADMINISTRATOR` accounts (`canAuthorizeVendorSettlements = false`), `OPERATIONS_STAFF` accounts, and non-`ACTIVE` accounts receive `403 Forbidden`.
- Target updates are restricted to `ACTIVE` `OPERATIONS_STAFF` accounts (without `ADMINISTRATOR`), and self-grant / self-revocation is blocked.

## Provisioning a Designated Primary Administrator

There is no UI or HTTP endpoint that elevates `canAuthorizeVendorSettlements` (`default false`). Provisioning or rotating a designated Primary Administrator requires an approved database administration step:

1. Verify the target account already exists as `ACTIVE` with role `ADMINISTRATOR` in `users` / `user_roles`.
2. Execute a controlled SQL change or migration setting `"canAuthorizeVendorSettlements" = true` for that explicit administrator account (and `"canAuthorizeVendorSettlements" = false` if revoking an outgoing designation).
3. On staging, this designation is provisioned on `bernard.uat@iriefishmongers.test`, while `admin@demo.iriefishmongers.test` remains an ordinary `ADMINISTRATOR` (`canAuthorizeVendorSettlements = false`) and `staff.operations@iriefishmongers.test` holds `OPERATIONS_STAFF`.

## Operational Scope & Immediate Revocation

- Granting `canManageCataloguePhotos = true` permits the Operations Staff member to open `/catalogue-photos`, view private draft previews, upload drafts, edit metadata, and upload replacement draft versions.
- Approving, publishing, rejecting drafts, setting species defaults, retiring/restoring photos, and bulk-switching product listings remain strictly restricted to `ADMINISTRATOR` (`CataloguePhotoAdminGuard`).
- Revoking `canManageCataloguePhotos = false` takes effect immediately on the next protected request (including `/image` draft previews) because `JwtAuthGuard`, `CataloguePhotoViewGuard`, and `CataloguePhotoManageGuard` re-read PostgreSQL on every request.

## Immutable Transactional Audit Trail

Every actual `false -> true` grant or `true -> false` revocation updates `users."canManageCataloguePhotos"` (with `SELECT ... FOR UPDATE` row locking inside the Prisma transaction) and writes an entry to `user_permission_audit_logs` in the same transaction. Append-only PostgreSQL triggers (`guard_user_permission_audit_logs_immutable`) prohibit `UPDATE`, `DELETE`, and `TRUNCATE` on audit records, and repeated identical requests are safe no-ops without duplicate audit entries.
