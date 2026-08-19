// Phase 17F (Tier-3) — migrator Container Apps Job.
//
// Runs `prisma migrate deploy` (the migrator image's default CMD) once, before
// the backend rollout. Manual trigger: the operator starts it with
// `az containerapp job start` and waits for a successful completion. It needs
// only DATABASE_URL (a Key Vault secret) and the GHCR pull credential.

@description('Job name.')
param name string

@description('Azure region.')
param location string

@description('Tags.')
param tags object

@description('Existing managed environment resource id.')
param environmentId string

@description('Migrator image pinned by digest.')
param image string

@description('User-assigned managed identity resource id.')
param identityId string

@description('Key Vault base URI (trailing slash).')
param keyVaultUri string

@description('GHCR server.')
param registryServer string

@description('GHCR username (non-secret).')
param registryUsername string

@description('App secret name holding the GHCR read:packages token.')
param registryPasswordSecretName string

@description('Key Vault secret name holding DATABASE_URL.')
param databaseUrlSecretName string

var jobSecretNames = [
  databaseUrlSecretName
  registryPasswordSecretName
]

var jobSecrets = [
  for secretName in jobSecretNames: {
    name: secretName
    keyVaultUrl: '${keyVaultUri}secrets/${secretName}'
    identity: identityId
  }
]

resource job 'Microsoft.App/jobs@2024-03-01' = {
  name: name
  location: location
  tags: tags
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${identityId}': {}
    }
  }
  properties: {
    environmentId: environmentId
    configuration: {
      triggerType: 'Manual'
      replicaTimeout: 1800
      replicaRetryLimit: 1
      manualTriggerConfig: {
        parallelism: 1
        replicaCompletionCount: 1
      }
      secrets: jobSecrets
      registries: [
        {
          server: registryServer
          username: registryUsername
          passwordSecretRef: registryPasswordSecretName
        }
      ]
    }
    template: {
      containers: [
        {
          name: 'migrator'
          image: image
          resources: {
            cpu: json('0.5')
            memory: '1Gi'
          }
          env: [
            {
              name: 'DATABASE_URL'
              secretRef: databaseUrlSecretName
            }
          ]
        }
      ]
    }
  }
}

@description('Migrator job resource id.')
output jobId string = job.id

@description('Migrator job name (start it with: az containerapp job start -n <name> -g <rg>).')
output jobName string = job.name
