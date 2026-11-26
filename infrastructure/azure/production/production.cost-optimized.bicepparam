using './main.bicep'

// Option A: Lowest-cost production configuration supporting Private Link networking (East US 2).
// PostgreSQL Burstable + Redis Balanced_B0 Non-HA — no database HA standby or Redis SLA.
// Authored for sizing review only; zero resources provisioned.

param location = 'eastus2'
param namePrefix = 'irie'
param environmentName = 'prod'
param resourceGroupName = 'rg-iriefishmongers-prod'
param deployApplications = false

param logRetentionInDays = 30
param logDailyQuotaGb = '1.0'
param budgetAmount = 120
param budgetContactEmails = []

param allowedVaultOperatorCidrs = ['63.245.90.66/32']

param postgresSkuName = 'Standard_B1ms'
param postgresSkuTier = 'Burstable'
param postgresStorageGb = 32
param postgresBackupRetentionDays = 14
param postgresGeoRedundantBackup = 'Disabled'
param postgresHighAvailabilityMode = 'Disabled'
param postgresAdminLogin = 'irieadmin'
param postgresAdminPassword = readEnvironmentVariable('PG_ADMIN_PASSWORD', '')
param databaseName = 'iriefishmongers'

param redisSkuName = 'Balanced_B0'
param redisHighAvailability = 'Disabled'

param zoneRedundantEnvironment = false

param registryUsername = 'bernie-Xtrinet1'
param adminAllowedIpCidrs = ['63.245.90.66/32']

param backendMinReplicas = 1
param backendMaxReplicas = 2
param webMinReplicas = 1
param webMaxReplicas = 2
param adminMinReplicas = 0
param adminMaxReplicas = 1

param backendBaseUrl = 'https://api.iriefishmongers.com'
param corsOrigin = 'https://iriefishmongers.com,https://www.iriefishmongers.com,https://admin.iriefishmongers.com'
param wipayApiUrl = 'https://jm.wipayfinancial.com/plugins/payments'
param wipayFeeStructure = 'customer_pay'
param sendgridFromEmail = 'notifications@iriefishmongers.com'
param emailEnabled = 'true'
param refreshCookieSameSite = 'strict'
param enableScheduler = 'true'
