using './main.bicep'

// Option B: High-Availability production configuration with Private Link networking (East US 2).
// PostgreSQL General Purpose D2ds_v5 (ZoneRedundant HA + Geo-Redundant backup, 99.99% SLA)
// + Azure Managed Redis Balanced_B3 HA (2-node AZ replication + persistence, 99.9% SLA)
// + Zone-redundant Container Apps environment. Authored for sizing review only.

param location = 'eastus2'
param namePrefix = 'irie'
param environmentName = 'prod'
param resourceGroupName = 'rg-iriefishmongers-prod'
param deployApplications = false

param logRetentionInDays = 90
param logDailyQuotaGb = '2.0'
param budgetAmount = 500
param budgetContactEmails = []

param allowedVaultOperatorCidrs = ['63.245.90.66/32']

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
param adminAllowedIpCidrs = ['63.245.90.66/32']

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
