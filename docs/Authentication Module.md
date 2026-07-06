Authentication Module

Complete when:

[x] Registration works
[x] Login works
[x] Refresh tokens work
[x] RBAC works
[x] Tests pass

Location: backend/src/modules/auth

## Endpoints

POST /api/v1/auth/register
POST /api/v1/auth/login
POST /api/v1/auth/logout
POST /api/v1/auth/refresh
POST /api/v1/auth/forgot-password
POST /api/v1/auth/reset-password
POST /api/v1/auth/verify-email
GET  /api/v1/auth/me (protected, Bearer access token)

## Design notes

- Roles: CUSTOMER, VENDOR, DRIVER, ADMINISTRATOR (seeded via `backend/prisma/seed.ts`).
  Public registration allows self-selecting CUSTOMER, VENDOR, or DRIVER; ADMINISTRATOR
  accounts are not self-registerable.
- Passwords hashed with bcrypt (12 salt rounds). Password policy: 8+ chars, upper,
  lower, number (`IsStrongPassword` validator).
- Access tokens: short-lived JWT (JWT_ACCESS_SECRET/JWT_ACCESS_EXPIRES_IN), verified
  by `JwtAuthGuard` (common/guards). RBAC enforced by `RolesGuard` + `@Roles()`
  decorator, both reusable by future modules.
- Refresh tokens: opaque random tokens, only the SHA-256 hash is persisted
  (`refresh_tokens` table), rotated on every `/auth/refresh` call (old token
  revoked, new one issued). Returned in the response body and also set as an
  httpOnly/secure/SameSite=strict cookie (`refresh_token`, scoped to
  `/api/v1/auth`) for web clients; `/auth/refresh` and `/auth/logout` accept
  either the cookie or the body field.
- Email verification and password reset use single-use, hashed, time-limited
  opaque tokens (24h / 1h respectively). Actually emailing these tokens to the
  user is intentionally out of scope here - that is the Notifications module's
  job (S.md Phase 8). Until Notifications exists, verification/reset tokens are
  generated and validated correctly but are not delivered anywhere.
- Rate limiting: stricter per-route throttles on register/login/forgot-password/
  reset-password beyond the global default, via `AppThrottlerGuard` (skips
  throttling only when NODE_ENV=test, so automated tests aren't rate-limited).
