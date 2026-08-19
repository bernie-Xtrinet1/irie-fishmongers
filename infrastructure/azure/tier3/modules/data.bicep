// Phase 17F (Tier-3) — data plane: PostgreSQL Flexible Server + Azure Managed Redis.
//
// Neither service's credential/connection string is emitted here. The operator
// composes DATABASE_URL (sslmode=require) and REDIS_URL (rediss://<host>:10000)
// out of band and stores them as Key Vault secrets. This module only outputs
// non-secret host/FQDN metadata to help build those strings.

@description('Azure region.')
param location string

@description('Name prefix.')
param namePrefix string

@description('Environment label.')
param environmentName string

@description('Tags.')
param tags object

@description('PostgreSQL administrator login (non-secret username).')
param postgresAdminLogin string

@description('PostgreSQL administrator password. @secure() - supplied at deploy time (env/CLI), never stored in Git or parameter files.')
@secure()
param postgresAdminPassword string

@description('Application database name.')
param databaseName string

var postgresName = 'psql-${namePrefix}-${environmentName}'
var redisName = 'redis-${namePrefix}-${environmentName}'

resource postgres 'Microsoft.DBforPostgreSQL/flexibleServers@2024-08-01' = {
  name: postgresName
  location: location
  tags: tags
  sku: {
    name: 'Standard_B1ms'
    tier: 'Burstable'
  }
  properties: {
    version: '16'
    administratorLogin: postgresAdminLogin
    administratorLoginPassword: postgresAdminPassword
    storage: {
      storageSizeGB: 32
    }
    backup: {
      backupRetentionDays: 7
      geoRedundantBackup: 'Disabled'
    }
    highAvailability: {
      mode: 'Disabled'
    }
    network: {
      publicNetworkAccess: 'Enabled'
    }
  }
}

// UTF-8 database (the reference seed contains an emoji that fails on non-UTF-8).
resource database 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2024-08-01' = {
  parent: postgres
  name: databaseName
  properties: {
    charset: 'UTF8'
    collation: 'en_US.utf8'
  }
}

// SECURITY CONSEQUENCE (explicit): the special 0.0.0.0-0.0.0.0 rule = "Allow
// public access from any Azure service within Azure to this server". This
// admits Azure-origin traffic from ANY Azure subscription/tenant, NOT only
// this subscription - the network boundary is effectively "any Azure IP".
// The real controls are then TLS (sslmode=require) + strong credentials.
// This is an EXPLICIT, STAGING-ONLY, TEMPORARY tradeoff for non-production
// data (it removes the need for VNet/private-endpoint plumbing at staging).
// Production MUST narrow this to a private endpoint / VNet-integrated
// environment (no public access). Do not carry this rule to production.
resource allowAzureServices 'Microsoft.DBforPostgreSQL/flexibleServers/firewallRules@2024-08-01' = {
  parent: postgres
  name: 'AllowAllAzureServices'
  properties: {
    startIpAddress: '0.0.0.0'
    endIpAddress: '0.0.0.0'
  }
}

// Azure Managed Redis (Redis Enterprise-based), Balanced B0, single node / non-HA.
// Stable API version (2025-04-01) - it documents Balanced_B0, TLS, and the
// database properties below; no preview features are required here.
resource redis 'Microsoft.Cache/redisEnterprise@2025-04-01' = {
  name: redisName
  location: location
  tags: tags
  sku: {
    name: 'Balanced_B0'
  }
  properties: {
    highAvailability: 'Disabled'
    minimumTlsVersion: '1.2'
  }
}

// Single default database: TLS-only on port 10000, no eviction (reservation
// keys must live out their TTLs), non-clustered proxy endpoint so multi-key
// Lua EVAL with hash-tagged keys works against one endpoint.
resource redisDatabase 'Microsoft.Cache/redisEnterprise/databases@2025-04-01' = {
  parent: redis
  name: 'default'
  properties: {
    clientProtocol: 'Encrypted'
    port: 10000
    clusteringPolicy: 'EnterpriseCluster'
    evictionPolicy: 'NoEviction'
  }
}

@description('PostgreSQL fully-qualified server name (build DATABASE_URL host from this).')
output postgresFqdn string = postgres.properties.fullyQualifiedDomainName

@description('PostgreSQL administrator login (non-secret).')
output postgresAdminLogin string = postgresAdminLogin

@description('Application database name.')
output databaseName string = databaseName

@description('Redis Enterprise hostname (build rediss://<host>:10000 REDIS_URL from this).')
output redisHostName string = redis.properties.hostName

@description('Redis TLS port.')
output redisPort int = 10000
