// Phase 17F (Tier-3) — application deployment onto the existing Tier-1 staging
// foundation. RESOURCE-GROUP scoped: the resource group and the Container Apps
// environment already exist (Tier-1), so this deploys with
// `az deployment group create -g rg-iriefishmongers-staging`.
//
// Two-pass, secret-ordering-safe design (see README):
//   Pass 1 (deployApplications=false): create Key Vault + identity + RBAC +
//           PostgreSQL + Redis. NO app changes. Operator then sets the secret
//           VALUES into Key Vault out of band (never in Git).
//   Pass 2 (deployApplications=true): update the three existing Container Apps
//           to the real images/ports/env/secrets/registry and create the
//           migrator Job.
//
// Tier-1 files are untouched. The three apps are updated in place (same names),
// so their assigned FQDNs are retained.

targetScope = 'resourceGroup'

@description('Azure region.')
param location string = resourceGroup().location

@description('Name prefix.')
param namePrefix string = 'irie'

@description('Environment label.')
param environmentName string = 'staging'

@description('Existing Tier-1 Container Apps environment name.')
param containerEnvName string = 'cae-irie-staging'

@description('When false (Pass 1): only Key Vault/identity/PostgreSQL/Redis. When true (Pass 2): also update the apps and create the migrator Job. Keep false until the Key Vault secret values have been set out of band.')
param deployApplications bool = false

// ---- images (pinned by digest; supplied at deploy, never mutable tags) ----
@description('Backend image ref pinned by digest.')
param backendImage string
@description('Web image ref pinned by digest.')
param webImage string
@description('Admin image ref pinned by digest.')
param adminImage string
@description('Migrator image ref pinned by digest.')
param migratorImage string

// ---- application ports ----
param backendPort int = 3001
param webPort int = 3000
param adminPort int = 3002

// ---- authoritative Tier-1 Container App FQDNs (explicit; never derived) ----
@description('Backend Container App FQDN (authoritative Tier-1 hostname).')
param backendFqdn string
@description('Web Container App FQDN (authoritative Tier-1 hostname).')
param webFqdn string
@description('Admin Container App FQDN (authoritative Tier-1 hostname).')
param adminFqdn string
@description('Refresh-cookie SameSite for cross-site staging FQDNs.')
@allowed([ 'strict', 'lax', 'none' ])
param refreshCookieSameSite string = 'none'
param jwtAccessExpiresIn string = '15m'
param jwtRefreshExpiresIn string = '7d'
param wipayApiUrl string = 'https://tx.wipayfinancial.com/plugins/payments'
param sendgridFromEmail string = 'notifications@iriefishmongers.com'
@allowed([ 'true', 'false' ])
param enableScheduler string = 'true'
// Transactional email master switch. 'false' (staging/UAT with no approved
// email-provider credentials) makes the sendgrid-api-key Key Vault secret
// OPTIONAL - it is neither referenced nor required - and sets EMAIL_ENABLED on
// the backend so the app boots and no-ops email gracefully. Keep 'true' for any
// environment that has a real provider key in Key Vault.
@allowed([ 'true', 'false' ])
param emailEnabled string = 'true'

// ---- replicas ----
@description('Backend min replicas. 1 keeps health green and lets the @Cron scheduler fire.')
param backendMinReplicas int = 1
param backendMaxReplicas int = 2
param frontendMinReplicas int = 0
param frontendMaxReplicas int = 1

// ---- data plane ----
param postgresAdminLogin string = 'irieadmin'
@secure()
param postgresAdminPassword string
param databaseName string = 'iriefishmongers'

// ---- GHCR ----
param registryServer string = 'ghcr.io'
@description('GHCR username (non-secret). The read:packages token is the ghcr-pat Key Vault secret.')
param registryUsername string

var tags = {
  project: 'iriefishmongers'
  environment: environmentName
  tier: 'staging-tier3'
  phase: '17F'
  managedBy: 'bicep'
}

// Built explicitly from each authoritative FQDN. CORS is the exact two-origin
// comma-delimited list the backend expects; APP_BASE_URL is the backend's own
// URL. Neither web nor admin is derived from the backend hostname.
var appBaseUrl = 'https://${backendFqdn}'
var corsOrigin = 'https://${webFqdn},https://${adminFqdn}'

// Canonical Key Vault secret names (VALUES set out of band; never in Git).
var ghcrPatSecretName = 'ghcr-pat'
var databaseUrlSecretName = 'database-url'
var emailOn = emailEnabled == 'true'
// sendgrid-api-key is included ONLY when email is enabled. When disabled it is
// neither referenced by the app nor required to exist in Key Vault - no empty
// or fake secret is created. Order is otherwise preserved.
var backendKeyVaultSecretNames = concat(
  [
    databaseUrlSecretName
    'redis-url'
    'jwt-access-secret'
    'jwt-refresh-secret'
    'wipay-account-number'
    'wipay-api-key'
  ],
  emailOn ? [ 'sendgrid-api-key' ] : [],
  [
    'firebase-project-id'
    'firebase-client-email'
    'firebase-private-key'
    ghcrPatSecretName
  ]
)
var frontendKeyVaultSecretNames = [
  ghcrPatSecretName
]

resource containerEnv 'Microsoft.App/managedEnvironments@2024-03-01' existing = {
  name: containerEnvName
}

module security 'modules/security.bicep' = {
  name: 'tier3-security'
  params: {
    location: location
    namePrefix: namePrefix
    environmentName: environmentName
    tags: tags
  }
}

module data 'modules/data.bicep' = {
  name: 'tier3-data'
  params: {
    location: location
    namePrefix: namePrefix
    environmentName: environmentName
    tags: tags
    postgresAdminLogin: postgresAdminLogin
    postgresAdminPassword: postgresAdminPassword
    databaseName: databaseName
  }
}

// ---- Pass 2 only: apps + migrator job ----
module backendApp 'modules/containerApp.bicep' = if (deployApplications) {
  name: 'tier3-app-backend'
  params: {
    name: 'ca-${namePrefix}-backend'
    location: location
    tags: tags
    environmentId: containerEnv.id
    image: backendImage
    targetPort: backendPort
    identityId: security.outputs.identityId
    keyVaultUri: security.outputs.keyVaultUri
    registryServer: registryServer
    registryUsername: registryUsername
    registryPasswordSecretName: ghcrPatSecretName
    keyVaultSecretNames: backendKeyVaultSecretNames
    plainEnv: [
      { name: 'NODE_ENV', value: 'production' }
      { name: 'PORT', value: string(backendPort) }
      { name: 'API_PREFIX', value: 'api/v1' }
      { name: 'CORS_ORIGIN', value: corsOrigin }
      { name: 'APP_BASE_URL', value: appBaseUrl }
      { name: 'JWT_ACCESS_EXPIRES_IN', value: jwtAccessExpiresIn }
      { name: 'JWT_REFRESH_EXPIRES_IN', value: jwtRefreshExpiresIn }
      { name: 'WIPAY_API_URL', value: wipayApiUrl }
      { name: 'SENDGRID_FROM_EMAIL', value: sendgridFromEmail }
      { name: 'EMAIL_ENABLED', value: emailEnabled }
      { name: 'REFRESH_COOKIE_SAMESITE', value: refreshCookieSameSite }
      { name: 'ENABLE_SCHEDULER', value: enableScheduler }
    ]
    // SENDGRID_API_KEY is bound ONLY when email is enabled; when disabled the
    // backend never references the sendgrid-api-key secret. Every other secret
    // (DATABASE_URL, REDIS_URL, JWT, WiPay, Firebase, ghcr-pat) is unchanged.
    secretEnv: concat(
      [
        { name: 'DATABASE_URL', secretRef: databaseUrlSecretName }
        { name: 'REDIS_URL', secretRef: 'redis-url' }
        { name: 'JWT_ACCESS_SECRET', secretRef: 'jwt-access-secret' }
        { name: 'JWT_REFRESH_SECRET', secretRef: 'jwt-refresh-secret' }
        { name: 'WIPAY_ACCOUNT_NUMBER', secretRef: 'wipay-account-number' }
        { name: 'WIPAY_API_KEY', secretRef: 'wipay-api-key' }
      ],
      emailOn ? [ { name: 'SENDGRID_API_KEY', secretRef: 'sendgrid-api-key' } ] : [],
      [
        { name: 'FIREBASE_PROJECT_ID', secretRef: 'firebase-project-id' }
        { name: 'FIREBASE_CLIENT_EMAIL', secretRef: 'firebase-client-email' }
        { name: 'FIREBASE_PRIVATE_KEY', secretRef: 'firebase-private-key' }
      ]
    )
    probePath: '/api/v1/health'
    minReplicas: backendMinReplicas
    maxReplicas: backendMaxReplicas
  }
}

module webApp 'modules/containerApp.bicep' = if (deployApplications) {
  name: 'tier3-app-web'
  params: {
    name: 'ca-${namePrefix}-web'
    location: location
    tags: tags
    environmentId: containerEnv.id
    image: webImage
    targetPort: webPort
    identityId: security.outputs.identityId
    keyVaultUri: security.outputs.keyVaultUri
    registryServer: registryServer
    registryUsername: registryUsername
    registryPasswordSecretName: ghcrPatSecretName
    keyVaultSecretNames: frontendKeyVaultSecretNames
    plainEnv: [
      { name: 'NODE_ENV', value: 'production' }
      { name: 'PORT', value: string(webPort) }
      { name: 'HOSTNAME', value: '0.0.0.0' }
    ]
    secretEnv: []
    probePath: '/'
    minReplicas: frontendMinReplicas
    maxReplicas: frontendMaxReplicas
  }
}

module adminApp 'modules/containerApp.bicep' = if (deployApplications) {
  name: 'tier3-app-admin'
  params: {
    name: 'ca-${namePrefix}-admin'
    location: location
    tags: tags
    environmentId: containerEnv.id
    image: adminImage
    targetPort: adminPort
    identityId: security.outputs.identityId
    keyVaultUri: security.outputs.keyVaultUri
    registryServer: registryServer
    registryUsername: registryUsername
    registryPasswordSecretName: ghcrPatSecretName
    keyVaultSecretNames: frontendKeyVaultSecretNames
    plainEnv: [
      { name: 'NODE_ENV', value: 'production' }
      { name: 'PORT', value: string(adminPort) }
      { name: 'HOSTNAME', value: '0.0.0.0' }
    ]
    secretEnv: []
    probePath: '/login'
    minReplicas: frontendMinReplicas
    maxReplicas: frontendMaxReplicas
  }
}

module migratorJob 'modules/migratorJob.bicep' = if (deployApplications) {
  name: 'tier3-migrator-job'
  params: {
    name: 'ca-${namePrefix}-db-migrate'
    location: location
    tags: tags
    environmentId: containerEnv.id
    image: migratorImage
    identityId: security.outputs.identityId
    keyVaultUri: security.outputs.keyVaultUri
    registryServer: registryServer
    registryUsername: registryUsername
    registryPasswordSecretName: ghcrPatSecretName
    databaseUrlSecretName: databaseUrlSecretName
  }
}

// ---- outputs to help compose the out-of-band Key Vault secrets ----
output keyVaultName string = security.outputs.keyVaultName
output keyVaultUri string = security.outputs.keyVaultUri
output runtimeIdentityId string = security.outputs.identityId
output postgresFqdn string = data.outputs.postgresFqdn
output postgresAdminLogin string = data.outputs.postgresAdminLogin
output databaseName string = data.outputs.databaseName
output redisHostName string = data.outputs.redisHostName
output redisPort int = data.outputs.redisPort
output requiredKeyVaultSecretNames array = backendKeyVaultSecretNames
