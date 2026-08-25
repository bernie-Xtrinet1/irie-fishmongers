using './main.bicep'

// Phase 17F Tier-3 — NON-SECRET parameters only.
// The ONLY externalized value is the PostgreSQL admin password (a secret), read
// from a deploy-time env var. Everything here is authoritative and non-secret:
// the four immutable Gate B2 image digests and the three Tier-1 FQDNs are
// pinned literally for a fully deterministic staging deployment.

// Immutable Gate B2 image identities, pinned by DIGEST (never mutable tags).
param backendImage = 'ghcr.io/bernie-xtrinet1/irie-fishmongers/backend@sha256:f604046b207c1273f3018d78604cdb9c5ecf3cbcab33ca6e37306f5835297c07'
param migratorImage = 'ghcr.io/bernie-xtrinet1/irie-fishmongers/migrator@sha256:b75d8112edf3894d28fb801f2c6b22a7ccb8072bfab68679b13447b685dd9a4e'
param webImage = 'ghcr.io/bernie-xtrinet1/irie-fishmongers/web@sha256:ee3ae24758c213cdc71f1385924e4f568d6ce60c895f510647e36b51ef38b08f'
param adminImage = 'ghcr.io/bernie-xtrinet1/irie-fishmongers/admin@sha256:f4aeb0a7d031b19f068dc2755feb3a293d6e76bb786e8b4ab39530601be74f2e'

// Pass gate: false = Pass 1 (data plane + Key Vault + identity); true = Pass 2
// (apps + migrator Job), only after the Key Vault secret values are set.
param deployApplications = false

// Application ports (must match the images).
param backendPort = 3001
param webPort = 3000
param adminPort = 3002

// Authoritative Tier-1 Container App FQDNs (explicit; no derivation).
// APP_BASE_URL and the two-origin CORS_ORIGIN are built from these in main.bicep.
param backendFqdn = 'ca-irie-backend.agreeablerock-458effa7.eastus2.azurecontainerapps.io'
param webFqdn = 'ca-irie-web.agreeablerock-458effa7.eastus2.azurecontainerapps.io'
param adminFqdn = 'ca-irie-admin.agreeablerock-458effa7.eastus2.azurecontainerapps.io'

// Cross-site browser topology (ADR-004): the frontends and API are on different
// registrable domains, so the refresh cookie MUST be SameSite=none (Secure is
// forced by the backend). This is the required compatibility setting, not a
// security preference.
param refreshCookieSameSite = 'none'

// Backend runs continuously (health always green + @Cron scheduler active).
param enableScheduler = 'true'

// Transactional email is DISABLED for staging/UAT: no approved email-provider
// credentials are currently available (SendGrid account not active). This makes
// the sendgrid-api-key Key Vault secret OPTIONAL - it is neither referenced nor
// required - and the backend boots and no-ops email gracefully. No empty or
// fake secret is created. Flip to 'true' once a real provider key is in place.
param emailEnabled = 'false'
param backendMinReplicas = 1
param backendMaxReplicas = 2
param frontendMinReplicas = 0
param frontendMaxReplicas = 1

// Payments — WiPay Jamaica SANDBOX base URL (host `jmsb`, not the live `tx`
// host). The adapter treats this as a base and appends /request, /{ref},
// /{ref}/refund. The matching WiPay sandbox account number + API key are PUBLIC
// sandbox values - NOT production merchant credentials - and are populated ONLY
// via Key Vault (never in Git), under the app's established secret contract.
// SEPARATE UNRESOLVED FUNCTIONAL-TESTING RISK (NOT fixed by this URL change):
// wipay.adapter.ts's request body/auth shape may not match WiPay's actual
// hosted-checkout API; a sandbox transaction test is required before relying on
// WiPay end-to-end.
param wipayApiUrl = 'https://jmsb.wipayfinancial.com/plugins/payments'

// Data plane (non-secret bits). The admin PASSWORD is the only externalized
// secret: supply it at deploy time, e.g. export PG_ADMIN_PASSWORD=...
param postgresAdminLogin = 'irieadmin'
param postgresAdminPassword = readEnvironmentVariable('PG_ADMIN_PASSWORD', '')
param databaseName = 'iriefishmongers'

// GHCR (non-secret username; the read:packages token is the ghcr-pat KV secret).
param registryServer = 'ghcr.io'
param registryUsername = 'bernie-Xtrinet1'
