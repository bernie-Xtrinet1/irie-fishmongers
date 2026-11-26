// Subscription-scoped entrypoint for dedicated production infrastructure (rg-iriefishmongers-prod).
// Authored for review & Bicep validation only — zero resources provisioned here.

targetScope = 'subscription'

@description('Azure region for dedicated production.')
param location string = 'eastus2'

@description('Name prefix.')
param namePrefix string = 'irie'

@description('Environment label.')
param environmentName string = 'prod'

@description('Production resource group name.')
param resourceGroupName string = 'rg-iriefishmongers-prod'

@description('Pass gate: false = Pass 1 (VNet, KV, private DB/Redis, placeholder FQDNs); true = Pass 2 (digest-pinned apps + migrator).')
param deployApplications bool = false

@minValue(30)
@maxValue(730)
param logRetentionInDays int = 90
param logDailyQuotaGb string = '2.0'

@minValue(1)
param budgetAmount int
param budgetContactEmails array = []
param budgetStartDate string = utcNow('yyyy-MM-01')

param allowedVaultOperatorCidrs array = []

param postgresSkuName string
@allowed([ 'Burstable', 'GeneralPurpose', 'MemoryOptimized' ])
param postgresSkuTier string
@minValue(32)
param postgresStorageGb int = 32
@minValue(7)
@maxValue(35)
param postgresBackupRetentionDays int = 14
@allowed([ 'Disabled', 'Enabled' ])
param postgresGeoRedundantBackup string
@allowed([ 'Disabled', 'ZoneRedundant', 'SameZone' ])
param postgresHighAvailabilityMode string
param postgresAdminLogin string = 'irieadmin'
@secure()
param postgresAdminPassword string
param databaseName string = 'iriefishmongers'

param redisSkuName string
@allowed([ 'Enabled', 'Disabled' ])
param redisHighAvailability string

param zoneRedundantEnvironment bool

param registryServer string = 'ghcr.io'
param registryUsername string = 'bernie-Xtrinet1'
param backendImage string = ''
param webImage string = ''
param adminImage string = ''
param migratorImage string = ''

@minLength(1)
param adminAllowedIpCidrs array

param backendMinReplicas int
param backendMaxReplicas int
param webMinReplicas int
param webMaxReplicas int
param adminMinReplicas int = 0
param adminMaxReplicas int = 1

param backendBaseUrl string = 'https://api.iriefishmongers.com'
param corsOrigin string = 'https://iriefishmongers.com,https://www.iriefishmongers.com,https://admin.iriefishmongers.com'
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

var rgTags = {
  project: 'iriefishmongers'
  environment: environmentName
  tier: 'production'
  managedBy: 'bicep'
}

resource rg 'Microsoft.Resources/resourceGroups@2024-03-01' = {
  name: resourceGroupName
  location: location
  tags: rgTags
}

module prod 'deployment.bicep' = {
  name: 'iriefishmongers-production'
  scope: rg
  params: {
    location: location
    namePrefix: namePrefix
    environmentName: environmentName
    deployApplications: deployApplications
    logRetentionInDays: logRetentionInDays
    logDailyQuotaGb: logDailyQuotaGb
    budgetAmount: budgetAmount
    budgetContactEmails: budgetContactEmails
    budgetStartDate: budgetStartDate
    allowedVaultOperatorCidrs: allowedVaultOperatorCidrs
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
    zoneRedundantEnvironment: zoneRedundantEnvironment
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
    wipayApiUrl: wipayApiUrl
    wipayFeeStructure: wipayFeeStructure
    sendgridFromEmail: sendgridFromEmail
    emailEnabled: emailEnabled
    refreshCookieSameSite: refreshCookieSameSite
    enableScheduler: enableScheduler
  }
}

output resourceGroupName string = rg.name
output keyVaultName string = prod.outputs.keyVaultName
output keyVaultUri string = prod.outputs.keyVaultUri
output runtimeIdentityId string = prod.outputs.runtimeIdentityId
output postgresFqdn string = prod.outputs.postgresFqdn
output postgresAdminLogin string = prod.outputs.postgresAdminLogin
output databaseName string = prod.outputs.databaseName
output redisHostName string = prod.outputs.redisHostName
output redisPort int = prod.outputs.redisPort
output backendFqdn string = prod.outputs.backendFqdn
output webFqdn string = prod.outputs.webFqdn
output adminFqdn string = prod.outputs.adminFqdn
output environmentStaticIp string = prod.outputs.environmentStaticIp
output customDomainVerificationId string = prod.outputs.customDomainVerificationId
output requiredKeyVaultSecretNames array = prod.outputs.requiredKeyVaultSecretNames
