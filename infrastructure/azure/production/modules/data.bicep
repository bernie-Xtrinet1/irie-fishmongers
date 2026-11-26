// Production data services (PostgreSQL 16 Flexible Server + Azure Managed Redis)
// connected exclusively over Private Endpoints (`publicNetworkAccess: 'Disabled'`).
// Public firewall rules (0.0.0.0) are intentionally absent.

@description('Azure region.')
param location string

@description('Name prefix.')
param namePrefix string

@description('Environment label.')
param environmentName string

@description('Tags.')
param tags object

@description('Private endpoint subnet resource ID.')
param privateEndpointSubnetId string

@description('Private DNS Zone ID for PostgreSQL (privatelink.postgres.database.azure.com).')
param postgresPrivateDnsZoneId string

@description('Private DNS Zone ID for Azure Managed Redis (privatelink.redis.azure.net).')
param redisPrivateDnsZoneId string

@description('PostgreSQL Flexible Server SKU name (e.g. Standard_B1ms or Standard_D2ds_v5).')
param postgresSkuName string

@description('PostgreSQL compute tier.')
@allowed([ 'Burstable', 'GeneralPurpose', 'MemoryOptimized' ])
param postgresSkuTier string

@description('PostgreSQL storage in GB.')
@minValue(32)
param postgresStorageGb int

@description('PostgreSQL automated PITR backup retention days (7-35).')
@minValue(7)
@maxValue(35)
param postgresBackupRetentionDays int

@description('Geo-redundant backup setting (Enabled or Disabled).')
@allowed([ 'Disabled', 'Enabled' ])
param postgresGeoRedundantBackup string

@description('PostgreSQL high availability mode (Disabled on Burstable; ZoneRedundant or SameZone on GeneralPurpose/MemoryOptimized).')
@allowed([ 'Disabled', 'ZoneRedundant', 'SameZone' ])
param postgresHighAvailabilityMode string

@description('PostgreSQL administrator login.')
param postgresAdminLogin string

@secure()
param postgresAdminPassword string

@description('Application database name.')
param databaseName string

@description('Azure Managed Redis Balanced SKU (e.g. Balanced_B0 or Balanced_B3).')
param redisSkuName string

@description('Azure Managed Redis high availability (Enabled provisions 2 nodes; Disabled provisions 1 non-SLA node).')
@allowed([ 'Enabled', 'Disabled' ])
param redisHighAvailability string

var postgresName = 'psql-${namePrefix}-${environmentName}'
var redisName = 'redis-${namePrefix}-${environmentName}'

resource postgres 'Microsoft.DBforPostgreSQL/flexibleServers@2024-08-01' = {
  name: postgresName
  location: location
  tags: tags
  sku: {
    name: postgresSkuName
    tier: postgresSkuTier
  }
  properties: {
    version: '16'
    administratorLogin: postgresAdminLogin
    administratorLoginPassword: postgresAdminPassword
    storage: {
      storageSizeGB: postgresStorageGb
      autoGrow: 'Enabled'
    }
    backup: {
      backupRetentionDays: postgresBackupRetentionDays
      geoRedundantBackup: postgresGeoRedundantBackup
    }
    highAvailability: {
      mode: postgresHighAvailabilityMode
    }
    network: {
      publicNetworkAccess: 'Disabled'
    }
  }
}

resource database 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2024-08-01' = {
  parent: postgres
  name: databaseName
  properties: {
    charset: 'UTF8'
    collation: 'en_US.utf8'
  }
}

resource postgresPrivateEndpoint 'Microsoft.Network/privateEndpoints@2023-11-01' = {
  name: 'pe-${postgresName}'
  location: location
  tags: tags
  properties: {
    subnet: {
      id: privateEndpointSubnetId
    }
    privateLinkServiceConnections: [
      {
        name: '${postgresName}-connection'
        properties: {
          privateLinkServiceId: postgres.id
          groupIds: [
            'postgresqlServer'
          ]
        }
      }
    ]
  }
}

resource postgresPrivateDnsGroup 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2023-11-01' = {
  parent: postgresPrivateEndpoint
  name: 'default'
  properties: {
    privateDnsZoneConfigs: [
      {
        name: 'postgres-privatelink'
        properties: {
          privateDnsZoneId: postgresPrivateDnsZoneId
        }
      }
    ]
  }
}

resource redis 'Microsoft.Cache/redisEnterprise@2025-04-01' = {
  name: redisName
  location: location
  tags: tags
  sku: {
    name: redisSkuName
  }
  properties: {
    highAvailability: redisHighAvailability
    minimumTlsVersion: '1.2'
    publicNetworkAccess: 'Disabled'
  }
}

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

resource redisPrivateEndpoint 'Microsoft.Network/privateEndpoints@2023-11-01' = {
  name: 'pe-${redisName}'
  location: location
  tags: tags
  properties: {
    subnet: {
      id: privateEndpointSubnetId
    }
    privateLinkServiceConnections: [
      {
        name: '${redisName}-connection'
        properties: {
          privateLinkServiceId: redis.id
          groupIds: [
            'redisEnterprise'
          ]
        }
      }
    ]
  }
}

resource redisPrivateDnsGroup 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2023-11-01' = {
  parent: redisPrivateEndpoint
  name: 'default'
  properties: {
    privateDnsZoneConfigs: [
      {
        name: 'redis-privatelink'
        properties: {
          privateDnsZoneId: redisPrivateDnsZoneId
        }
      }
    ]
  }
}

output postgresFqdn string = postgres.properties.fullyQualifiedDomainName
output postgresAdminLogin string = postgresAdminLogin
output databaseName string = databaseName
output redisHostName string = redis.properties.hostName
output redisPort int = 10000
