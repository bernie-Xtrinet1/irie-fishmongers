// Production Key Vault (RBAC + Purge Protection + 90-day soft delete) and runtime Managed Identity.
// Secret values are populated strictly out-of-band after Pass 1.

@description('Azure region.')
param location string

@description('Name prefix.')
param namePrefix string

@description('Environment label.')
param environmentName string

@description('Tags.')
param tags object

@description('Optional list of operator/workstation IPv4 CIDRs allowed to manage Key Vault data-plane secrets. Empty keeps RBAC-only public access enabled for initial setup.')
param allowedVaultOperatorCidrs array = []

var keyVaultName = 'kv-${namePrefix}-${environmentName}'
var identityName = 'id-${namePrefix}-${environmentName}-runtime'
var keyVaultSecretsUserRoleId = '4633458b-17de-408a-b874-0445c86b69e6'

var ipRules = [
  for cidr in allowedVaultOperatorCidrs: {
    value: cidr
  }
]

resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: identityName
  location: location
  tags: tags
}

resource keyVault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: keyVaultName
  location: location
  tags: tags
  properties: {
    sku: {
      family: 'A'
      name: 'standard'
    }
    tenantId: subscription().tenantId
    enableRbacAuthorization: true
    enableSoftDelete: true
    softDeleteRetentionInDays: 90
    enablePurgeProtection: true
    publicNetworkAccess: 'Enabled'
    networkAcls: {
      bypass: 'AzureServices'
      defaultAction: empty(allowedVaultOperatorCidrs) ? 'Allow' : 'Deny'
      ipRules: ipRules
    }
  }
}

resource secretsUserAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(keyVault.id, identity.id, keyVaultSecretsUserRoleId)
  scope: keyVault
  properties: {
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', keyVaultSecretsUserRoleId)
  }
}

output identityId string = identity.id
output identityPrincipalId string = identity.properties.principalId
output keyVaultUri string = keyVault.properties.vaultUri
output keyVaultName string = keyVault.name
