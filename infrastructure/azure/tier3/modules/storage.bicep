// Opt-in Azure Blob Storage for Admin -> Catalogue Photos.
//
// Provisioned ONLY when storageEnabled=true after resource/cost approval.
// Uses two containers on one Standard_LRS Hot StorageV2 account:
//   - catalogue-photos         (publicAccess: 'Blob', direct read for published assets)
//   - catalogue-photos-drafts  (publicAccess: 'None', strictly private drafts)
// Authenticates via Managed Identity RBAC (Storage Blob Data Contributor) with
// shared key access disabled (zero storage keys stored in Key Vault).

@description('Azure region.')
param location string

@description('Name prefix.')
param namePrefix string

@description('Environment label.')
param environmentName string

@description('Tags.')
param tags object

@description('Principal ID of the user-assigned runtime managed identity.')
param runtimeIdentityPrincipalId string

@description('Allowed frontend origins for CORS GET/HEAD access to public blobs.')
param corsAllowedOrigins array

@description('Public container for approved & retained storefront catalogue photos.')
param publicContainerName string = 'catalogue-photos'

@description('Private container for draft and rejected catalogue uploads.')
param privateContainerName string = 'catalogue-photos-drafts'

var cleanPrefix = toLower(replace('${namePrefix}${environmentName}', '-', ''))
var storageAccountName = take('st${cleanPrefix}${uniqueString(resourceGroup().id)}', 24)

// Built-in role: Storage Blob Data Contributor
var storageBlobDataContributorRoleId = 'ba92f5b4-2d11-453d-a403-e96b0029c9fe'

resource storageAccount 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: storageAccountName
  location: location
  tags: tags
  sku: {
    name: 'Standard_LRS'
  }
  kind: 'StorageV2'
  properties: {
    accessTier: 'Hot'
    allowBlobPublicAccess: true
    allowSharedKeyAccess: false
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
    publicNetworkAccess: 'Enabled'
  }
}

resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: storageAccount
  name: 'default'
  properties: {
    cors: {
      corsRules: [
        {
          allowedOrigins: corsAllowedOrigins
          allowedMethods: [ 'GET', 'HEAD', 'OPTIONS' ]
          allowedHeaders: [ '*' ]
          exposedHeaders: [ 'Content-Length', 'Content-Type', 'ETag' ]
          maxAgeInSeconds: 3600
        }
      ]
    }
  }
}

resource publicContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: publicContainerName
  properties: {
    publicAccess: 'Blob'
  }
}

resource privateContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: privateContainerName
  properties: {
    publicAccess: 'None'
  }
}

resource runtimeBlobContributorRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(storageAccount.id, runtimeIdentityPrincipalId, storageBlobDataContributorRoleId)
  scope: storageAccount
  properties: {
    principalId: runtimeIdentityPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', storageBlobDataContributorRoleId)
  }
}

output storageAccountName string = storageAccount.name
output blobPrimaryEndpoint string = storageAccount.properties.primaryEndpoints.blob
output publicContainerName string = publicContainer.name
output privateContainerName string = privateContainer.name
