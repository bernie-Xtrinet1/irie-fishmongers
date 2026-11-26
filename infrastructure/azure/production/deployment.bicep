// Resource-group scoped orchestrator for dedicated production (iriefishmongers.com).
//
// Two-pass gate via `deployApplications`:
//   Pass 1 (false): VNet, Private DNS zones, Log Analytics, App Insights, Monthly Budget,
//                   Key Vault (RBAC + Purge Protection), Runtime Managed Identity,
//                   PostgreSQL 16 (public access Disabled + Private Endpoint),
//                   Azure Managed Redis (public access Disabled + Private Endpoint),
//                   VNet-integrated Container Apps environment + placeholder FQDNs.
//   Pass 2 (true):  Digest-pinned backend/web/admin apps + `ca-irie-db-migrate-prod` Job.

targetScope = 'resourceGroup'

@description('Azure region.')
param location string = resourceGroup().location

@description('Name prefix.')
param namePrefix string = 'irie'

@description('Environment label.')
param environmentName string = 'prod'

@description('Pass gate: false = foundation + private data services; true = digest-pinned apps + migrator Job.')
param deployApplications bool = false

@description('Log retention in days.')
@minValue(30)
@maxValue(730)
param logRetentionInDays int = 90

@description('Log Analytics daily cap in GB.')
param logDailyQuotaGb string = '2.0'

@description('Monthly cost budget alert threshold in USD.')
@minValue(1)
param budgetAmount int

@description('Optional budget alert email recipients.')
param budgetContactEmails array = []

@description('Budget start date (YYYY-MM-01).')
param budgetStartDate string = utcNow('yyyy-MM-01')

@description('Optional operator IPv4 CIDRs for Key Vault firewall restrictions.')
param allowedVaultOperatorCidrs array = []

@description('PostgreSQL SKU name.')
param postgresSkuName string

@description('PostgreSQL compute tier.')
@allowed([ 'Burstable', 'GeneralPurpose', 'MemoryOptimized' ])
param postgresSkuTier string

@description('PostgreSQL storage size in GB.')
@minValue(32)
param postgresStorageGb int = 32

@description('PostgreSQL PITR backup retention days (7-35).')
@minValue(7)
@maxValue(35)
param postgresBackupRetentionDays int = 14

@description('PostgreSQL geo-redundant backup setting.')
@allowed([ 'Disabled', 'Enabled' ])
param postgresGeoRedundantBackup string

@description('PostgreSQL high availability mode.')
@allowed([ 'Disabled', 'ZoneRedundant', 'SameZone' ])
param postgresHighAvailabilityMode string

@description('PostgreSQL administrator login.')
param postgresAdminLogin string

@secure()
param postgresAdminPassword string

@description('Application database name.')
param databaseName string = 'iriefishmongers'

@description('Azure Managed Redis Balanced SKU.')
param redisSkuName string

@description('Azure Managed Redis high availability.')
@allowed([ 'Enabled', 'Disabled' ])
param redisHighAvailability string

@description('Zone redundancy for VNet-integrated Container Apps environment.')
param zoneRedundantEnvironment bool

@description('GHCR registry server.')
param registryServer string = 'ghcr.io'

@description('GHCR username.')
param registryUsername string

@description('Digest-pinned backend image ref (used when deployApplications=true).')
param backendImage string = ''

@description('Digest-pinned web image ref (used when deployApplications=true).')
param webImage string = ''

@description('Digest-pinned admin image ref (used when deployApplications=true).')
param adminImage string = ''

@description('Digest-pinned migrator image ref (used when deployApplications=true).')
param migratorImage string = ''

@description('Approved operator CIDRs allowed to reach admin portal.')
@minLength(1)
param adminAllowedIpCidrs array

param backendMinReplicas int
param backendMaxReplicas int
param webMinReplicas int
param webMaxReplicas int
param adminMinReplicas int = 0
param adminMaxReplicas int = 1

@description('Public backend URL (e.g. https://api.iriefishmongers.com).')
param backendBaseUrl string = 'https://api.iriefishmongers.com'

@description('Strict comma-separated CORS allowlist of production frontend origins.')
param corsOrigin string = 'https://iriefishmongers.com,https://www.iriefishmongers.com,https://admin.iriefishmongers.com'

param jwtAccessExpiresIn string = '15m'
param jwtRefreshExpiresIn string = '7d'
param wipayApiUrl string = 'https://jm.wipayfinancial.com/plugins/payments'

@allowed([ 'customer_pay', 'merchant_absorb', 'split' ])
param wipayFeeStructure string = 'customer_pay'

param sendgridFromEmail string = 'notifications@iriefishmongers.com'

@allowed([ 'true', 'false' ])
param emailEnabled string = 'true'

@allowed([ 'strict', 'lax', 'none' ])
param refreshCookieSameSite string = 'strict'

@allowed([ 'true', 'false' ])
param enableScheduler string = 'true'

var tags = {
  project: 'iriefishmongers'
  environment: environmentName
  tier: 'production'
  managedBy: 'bicep'
}

module network 'modules/network.bicep' = {
  name: 'prod-network'
  params: {
    location: location
    namePrefix: namePrefix
    environmentName: environmentName
    tags: tags
  }
}

module monitoring 'modules/monitoring.bicep' = {
  name: 'prod-monitoring'
  params: {
    location: location
    namePrefix: namePrefix
    environmentName: environmentName
    tags: tags
    logRetentionInDays: logRetentionInDays
    logDailyQuotaGb: logDailyQuotaGb
    budgetAmount: budgetAmount
    budgetContactEmails: budgetContactEmails
    budgetStartDate: budgetStartDate
  }
}

module security 'modules/security.bicep' = {
  name: 'prod-security'
  params: {
    location: location
    namePrefix: namePrefix
    environmentName: environmentName
    tags: tags
    allowedVaultOperatorCidrs: allowedVaultOperatorCidrs
  }
}

module data 'modules/data.bicep' = {
  name: 'prod-data'
  params: {
    location: location
    namePrefix: namePrefix
    environmentName: environmentName
    tags: tags
    privateEndpointSubnetId: network.outputs.privateEndpointSubnetId
    postgresPrivateDnsZoneId: network.outputs.postgresPrivateDnsZoneId
    redisPrivateDnsZoneId: network.outputs.redisPrivateDnsZoneId
    postgresSkuName: postgresSkuName
    postgresSkuTier: postgresSkuTier
    postgresStorageGb: postgresStorageGb
    postgresBackupRetentionDays: postgresBackupRetentionDays
    postgresGeoRedundantBackup: postgresGeoRedundantBackup
    postgresHighAvailabilityMode: postgresHighAvailabilityMode
    postgresAdminLogin: postgresAdminLogin
    postgresAdminPassword: postgresAdminPassword
    databaseName: databaseName
    redisSkuName: redisSkuName
    redisHighAvailability: redisHighAvailability
  }
}

module containerApps 'modules/containerApps.bicep' = {
  name: 'prod-apps'
  params: {
    location: location
    namePrefix: namePrefix
    environmentName: environmentName
    tags: tags
    logAnalyticsName: monitoring.outputs.logAnalyticsName
    acaSubnetId: network.outputs.acaSubnetId
    zoneRedundantEnvironment: zoneRedundantEnvironment
    deployApplications: deployApplications
    identityId: security.outputs.identityId
    keyVaultUri: security.outputs.keyVaultUri
    registryServer: registryServer
    registryUsername: registryUsername
    backendImage: backendImage
    webImage: webImage
    adminImage: adminImage
    migratorImage: migratorImage
    adminAllowedIpCidrs: adminAllowedIpCidrs
    backendMinReplicas: backendMinReplicas
    backendMaxReplicas: backendMaxReplicas
    webMinReplicas: webMinReplicas
    webMaxReplicas: webMaxReplicas
    adminMinReplicas: adminMinReplicas
    adminMaxReplicas: adminMaxReplicas
    backendBaseUrl: backendBaseUrl
    corsOrigin: corsOrigin
    jwtAccessExpiresIn: jwtAccessExpiresIn
    jwtRefreshExpiresIn: jwtRefreshExpiresIn
    wipayApiUrl: wipayApiUrl
    wipayFeeStructure: wipayFeeStructure
    sendgridFromEmail: sendgridFromEmail
    emailEnabled: emailEnabled
    refreshCookieSameSite: refreshCookieSameSite
    enableScheduler: enableScheduler
  }
}

output keyVaultName string = security.outputs.keyVaultName
output keyVaultUri string = security.outputs.keyVaultUri
output runtimeIdentityId string = security.outputs.identityId
output postgresFqdn string = data.outputs.postgresFqdn
output postgresAdminLogin string = data.outputs.postgresAdminLogin
output databaseName string = data.outputs.databaseName
output redisHostName string = data.outputs.redisHostName
output redisPort int = data.outputs.redisPort
output backendFqdn string = containerApps.outputs.backendFqdn
output webFqdn string = containerApps.outputs.webFqdn
output adminFqdn string = containerApps.outputs.adminFqdn
output environmentStaticIp string = containerApps.outputs.environmentStaticIp
output customDomainVerificationId string = containerApps.outputs.customDomainVerificationId
output requiredKeyVaultSecretNames array = containerApps.outputs.requiredKeyVaultSecretNames
output appInsightsId string = monitoring.outputs.appInsightsId
