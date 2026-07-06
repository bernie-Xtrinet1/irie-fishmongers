Users
Vendors
Drivers
Products
Inventory
Orders
Payments
Deliveries
Reviews
Notifications

---

# Infrastructure (Phase 2)

- ORM: Prisma, schema at `backend/prisma/schema.prisma`, PostgreSQL datasource via `DATABASE_URL`.
- Cache/queue backend: Redis via `ioredis`, connection URL via `REDIS_URL`, wrapped by `RedisModule`/`RedisService` (`backend/src/common/redis`).
- Environment variables are validated at boot via `class-validator` (`backend/src/config`); the app refuses to start with missing/invalid config.
- `GET /api/v1/health` reports Postgres and Redis connectivity for local/CI/ops checks.
- Local dev (Windows): PostgreSQL runs as the `postgresql-x64-16` service; Redis runs as a Windows service named `IrieRedis` (portable Redis-for-Windows build wrapped with NSSM, since Memurai's MSI installer fails in this environment). Both auto-start on boot.
- Domain entities (Users, Vendors, Products, Orders, etc.) are added to `schema.prisma` module-by-module starting with Authentication (Phase 3), not all at once.

---

# Authentication Tables (Phase 3)

- `users` - id, email (unique), passwordHash, firstName, lastName, phone (optional),
  status (PENDING_VERIFICATION | ACTIVE | SUSPENDED | DEACTIVATED), email
  verification/password reset token hashes + expiries, timestamps.
- `roles` - id, name (CUSTOMER | VENDOR | DRIVER | ADMINISTRATOR, unique), seeded via
  `backend/prisma/seed.ts` (`npm run prisma:seed -w backend`).
- `user_roles` - join table (userId, roleId), unique per pair.
- `refresh_tokens` - id, userId, tokenHash (unique, SHA-256 of the raw token - the
  raw value is never stored), expiresAt, revokedAt, createdAt.

---

# Marketplace Tables (Phase - Marketplace, per .claude/marketplace-build-instructions.md)

- `vendors` - id, userId (unique, one profile per user), businessName,
  status (PENDING | APPROVED | SUSPENDED | REJECTED, default PENDING). This is the
  minimal profile needed for products to have an owner; full vendor management
  (dashboards, reports, storefront settings, documents) is a later phase.
  Expanded in the Vendor Management phase below with description, phone,
  parish, logoUrl, termsAcceptedAt.
- `categories` - id, name (unique), slug (unique). Seeded with Fish, Shellfish,
  Crustaceans, Mollusks via `backend/prisma/seed.ts`.
- `products` - id, vendorId, categoryId (onDelete: Restrict - a category with
  products can't be deleted), name, description, unit (PER_POUND | PER_KILOGRAM |
  PER_PACKAGE | PER_ITEM), price (Decimal(10,2)), currency (default "JMD"),
  quantityAvailable (Int, floor enforced at 0), imageUrl, isActive (soft
  delete/deactivate instead of hard delete).
  - "Availability" (ACTIVE | OUT_OF_STOCK | INACTIVE) shown to API consumers is
    computed from isActive/quantityAvailable, not stored.
  - Only APPROVED vendors may create products; any vendor may edit only their
    own products regardless of status.
  - Stock adjustment (`PATCH /products/:id/stock`) is a plain read-then-write
    with an application-level floor-at-zero check, not yet atomic - acceptable
    while nothing else mutates stock concurrently (no Orders module yet).
    Revisit with an atomic guarded UPDATE once concurrent order placement can
    decrement stock at the same time.
  - Search ranking currently only accounts for availability (in-stock first);
    the vendor rating / distance / freshness factors from business-rules1.md's
    Search Rules require Reviews and Delivery Zones, which don't exist yet.

---

# Vendor Management (Phase 4, per .claude/marketplace-build-instructions.md)

Expands the minimal Marketplace-phase Vendor profile with:

- `description` (optional), `phone` (optional), `logoUrl` (optional).
- `parish` (required, `Parish` enum of Jamaica's 14 parishes per
  docs/reference/jamaica-delivery-zones.md - the authoritative parish/zone
  mapping). Zone grouping itself belongs to the later Delivery Zones phase;
  only the parish taxonomy is needed now.
- `termsAcceptedAt` (required, set at registration) - vendors must pass
  `acceptedTerms: true` to register; this satisfies business-rules1.md's
  "accept platform terms and conditions" requirement.

New endpoints:

- `PATCH /vendors/me` - vendor self-service update of business info (not
  status - that stays admin-only via the existing `PATCH /vendors/:id/status`).
- `GET /vendors` (admin only) - paginated list, optionally filtered by status,
  so admins can actually discover pending vendors to approve.
- `GET /vendors/:id/public` - public storefront view (id, businessName,
  description, parish, logoUrl only - never userId/phone/status/
  termsAcceptedAt). 404s unless the vendor is APPROVED.
- `GET /products/mine` (vendor only) - the vendor's own products including
  inactive ones, unlike the public search which only ever returns active
  listings.

Deliberately out of scope for this phase: identification/compliance document
upload (no S3/file storage pipeline exists yet - that belongs with a future
Food Safety/Compliance phase), and sales reporting (would be meaningless
zeros with no Orders/Payments data yet - belongs with Orders + Reporting).
