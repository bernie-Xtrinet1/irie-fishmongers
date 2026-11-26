// Dedicated production Virtual Network, NSG, and Private DNS zones for iriefishmongers.com.
// Isolates Container Apps outbound traffic to PostgreSQL and Managed Redis via Private Link.

@description('Azure region.')
param location string

@description('Name prefix.')
param namePrefix string

@description('Environment label.')
param environmentName string

@description('Tags.')
param tags object

var vnetName = 'vnet-${namePrefix}-${environmentName}'
var acaNsgName = 'nsg-${namePrefix}-${environmentName}-aca'
var vnetAddressPrefix = '10.20.0.0/16'
var acaSubnetPrefix = '10.20.0.0/23'
var privateEndpointSubnetPrefix = '10.20.2.0/24'

resource acaNsg 'Microsoft.Network/networkSecurityGroups@2023-11-01' = {
  name: acaNsgName
  location: location
  tags: tags
  properties: {
    securityRules: [
      {
        name: 'allow-postgres-private-link'
        properties: {
          priority: 100
          direction: 'Outbound'
          access: 'Allow'
          protocol: 'Tcp'
          sourcePortRange: '*'
          destinationPortRange: '5432'
          sourceAddressPrefix: acaSubnetPrefix
          destinationAddressPrefix: privateEndpointSubnetPrefix
        }
      }
      {
        name: 'allow-redis-private-link'
        properties: {
          priority: 110
          direction: 'Outbound'
          access: 'Allow'
          protocol: 'Tcp'
          sourcePortRange: '*'
          destinationPortRange: '10000'
          sourceAddressPrefix: acaSubnetPrefix
          destinationAddressPrefix: privateEndpointSubnetPrefix
        }
      }
    ]
  }
}

resource vnet 'Microsoft.Network/virtualNetworks@2023-11-01' = {
  name: vnetName
  location: location
  tags: tags
  properties: {
    addressSpace: {
      addressPrefixes: [
        vnetAddressPrefix
      ]
    }
    subnets: [
      {
        name: 'snet-aca'
        properties: {
          addressPrefix: acaSubnetPrefix
          networkSecurityGroup: {
            id: acaNsg.id
          }
          delegations: [
            {
              name: 'aca-environments'
              properties: {
                serviceName: 'Microsoft.App/environments'
              }
            }
          ]
        }
      }
      {
        name: 'snet-private-endpoints'
        properties: {
          addressPrefix: privateEndpointSubnetPrefix
          privateEndpointNetworkPolicies: 'Disabled'
        }
      }
    ]
  }
}

resource postgresPrivateDnsZone 'Microsoft.Network/privateDnsZones@2020-06-01' = {
  name: 'privatelink.postgres.database.azure.com'
  location: 'global'
  tags: tags
}

resource postgresDnsLink 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2020-06-01' = {
  parent: postgresPrivateDnsZone
  name: '${vnetName}-postgres-link'
  location: 'global'
  tags: tags
  properties: {
    registrationEnabled: false
    virtualNetwork: {
      id: vnet.id
    }
  }
}

resource redisPrivateDnsZone 'Microsoft.Network/privateDnsZones@2020-06-01' = {
  name: 'privatelink.redis.azure.net'
  location: 'global'
  tags: tags
}

resource redisDnsLink 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2020-06-01' = {
  parent: redisPrivateDnsZone
  name: '${vnetName}-redis-link'
  location: 'global'
  tags: tags
  properties: {
    registrationEnabled: false
    virtualNetwork: {
      id: vnet.id
    }
  }
}

output vnetId string = vnet.id
output acaSubnetId string = vnet.properties.subnets[0].id
output privateEndpointSubnetId string = vnet.properties.subnets[1].id
output postgresPrivateDnsZoneId string = postgresPrivateDnsZone.id
output redisPrivateDnsZoneId string = redisPrivateDnsZone.id
