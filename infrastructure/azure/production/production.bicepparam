using './main.bicep'

// Authoritative production parameter entrypoint for iriefishmongers.com.
// Select Option A (production.cost-optimized.bicepparam) or Option B (production.ha.bicepparam)
// values after reviewing the East US 2 cost/availability comparison in
// docs/azure/production-release-readiness.md.
//
// Pass 2 supplies digest-pinned images via CLI overrides or deploy-production.yml.
// Keep PG_ADMIN_PASSWORD out-of-band (never commit secrets).

param location = 'eastus2'
param namePrefix = 'irie'
param environmentName = 'prod'
param resourceGroupName = 'rg-iriefishmongers-prod'
param deployApplications = false

param logRetentionInDays = 90
param logDailyQuotaGb = '2.0'
param budgetAmount = 500
param budgetContactEmails = []

// Preserve existing restricted admin-access model and tighten Key Vault management access.
param allowedVaultOperatorCidrs = ['63.245.90.66/32']
param adminAllowedIpCidrs = ['63.245.90.66/32']

// Defaulted to HA-backed production baseline (Option B). Switch to Option A values if approved.
param postgresSkuName = 'Standard_D2ds_v5'
param postgresSkuTier = 'GeneralPurpose'
param postgresStorageGb = 32
param postgresBackupRetentionDays = 35
param postgresGeoRedundantBackup = 'Enabled'
param postgresHighAvailabilityMode = 'ZoneRedundant'
param postgresAdminLogin = 'irieadmin'
param postgresAdminPassword = readEnvironmentVariable('PG_ADMIN_PASSWORD', '')
param databaseName = 'iriefishmongers'

param redisSkuName = 'Balanced_B3'
param redisHighAvailability = 'Enabled'

param zoneRedundantEnvironment = true

param registryUsername = 'bernie-Xtrinet1'

param backendMinReplicas = 2
param backendMaxReplicas = 4
param webMinReplicas = 1
param webMaxReplicas = 4
param adminMinReplicas = 0
param adminMaxReplicas = 2

param backendBaseUrl = 'https://api.iriefishmongers.com'
param corsOrigin = 'https://iriefishmongers.com,https://www.iriefishmongers.com,https://admin.iriefishmongers.com'
param wipayApiUrl = 'https://jm.wipayfinancial.com/plugins/payments'
param wipayFeeStructure = 'customer_pay'
param sendgridFromEmail = 'notifications@iriefishmongers.com'
param emailEnabled = 'true'
param refreshCookieSameSite = 'strict'
param enableScheduler = 'true'
