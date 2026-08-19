// Phase 17F (Tier-3) — Key Vault + user-assigned managed identity + RBAC.
//
// Key Vault uses RBAC authorization. The user-assigned identity is granted the
// built-in "Key Vault Secrets User" role so the Container Apps / migrator Job
// can resolve secret references (keyvaultref + identityref) at runtime.
//
// NO secret VALUES are created here. Secrets are set into the vault OUT OF BAND
// (`az keyvault secret set`) between the infra deploy and the app deploy, so no
// secret value ever appears in Git/Bicep/parameters.

@description('Azure region.')
param location string

@description('Name prefix.')
param namePrefix string

@description('Environment label.')
param environmentName string

@description('Tags.')
param tags object

var keyVaultName = 'kv-${namePrefix}-${environmentName}'
var identityName = 'id-${namePrefix}-${environmentName}-runtime'
// Built-in role: Key Vault Secrets User (read secret values).
var keyVaultSecretsUserRoleId = '4633458b-17de-408a-b874-0445c86b69e6'

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
    softDeleteRetentionInDays: 7
    publicNetworkAccess: 'Enabled'
  }
}

// Grant the runtime identity read access to secrets in THIS vault only.
resource secretsUserAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(keyVault.id, identity.id, keyVaultSecretsUserRoleId)
  scope: keyVault
  properties: {
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', keyVaultSecretsUserRoleId)
  }
}

@description('Resource ID of the user-assigned managed identity (for app identityref).')
output identityId string = identity.id

@description('Principal ID of the user-assigned managed identity.')
output identityPrincipalId string = identity.properties.principalId

@description('Key Vault base URI (ends with a trailing slash), used to build secret keyVaultUrl values.')
output keyVaultUri string = keyVault.properties.vaultUri

@description('Key Vault name.')
output keyVaultName string = keyVault.name
