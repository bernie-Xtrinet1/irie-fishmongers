// Phase 17F (Tier-3) — real application Container App.
//
// Declared with the SAME name as the Tier-1 placeholder app, so a deployment
// UPDATES it in place: the app-level FQDN is retained across the image + port
// change (Azure Container Apps guarantees a stable ingress FQDN across
// revisions). Reused for backend / web / admin.
//
// - image is pinned by DIGEST (never a mutable tag);
// - private GHCR pull uses a registry credential (ghcr-pat secret) because
//   managed identity cannot authenticate to GHCR;
// - secret-backed env comes from Key Vault via the user-assigned identity;
// - no secret VALUES appear here.

@description('Container App name (must match the existing Tier-1 app to update in place).')
param name string

@description('Azure region.')
param location string

@description('Tags.')
param tags object

@description('Existing managed environment resource id.')
param environmentId string

@description('Image pinned by digest, e.g. ghcr.io/<ns>/backend@sha256:<digest>.')
param image string

@description('Ingress + container target port (the real application port).')
@minValue(1)
@maxValue(65535)
param targetPort int

@description('User-assigned managed identity resource id (for Key Vault secret refs).')
param identityId string

@description('Key Vault base URI (trailing slash) for building secret keyVaultUrl values.')
param keyVaultUri string

@description('GHCR server (ghcr.io).')
param registryServer string

@description('GHCR username (non-secret).')
param registryUsername string

@description('App secret name holding the GHCR read:packages token.')
param registryPasswordSecretName string

@description('Key Vault secret names to expose as Container App secrets (includes the GHCR token secret).')
param keyVaultSecretNames array

@description('Non-secret environment variables: [{ name, value }].')
param plainEnv array

@description('Secret-backed environment variables: [{ name, secretRef }] (secretRef is an app secret name).')
param secretEnv array

@description('HTTP path for readiness/liveness/startup probes.')
param probePath string

@description('Minimum replicas.')
param minReplicas int

@description('Maximum replicas.')
param maxReplicas int

// Build the Container App secret list from Key Vault references resolved by the
// user-assigned identity. Each name maps to https://<vault>/secrets/<name>.
var appSecrets = [
  for secretName in keyVaultSecretNames: {
    name: secretName
    keyVaultUrl: '${keyVaultUri}secrets/${secretName}'
    identity: identityId
  }
]

var containerEnv = concat(plainEnv, [
  for s in secretEnv: {
    name: s.name
    secretRef: s.secretRef
  }
])

resource app 'Microsoft.App/containerApps@2024-03-01' = {
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
    managedEnvironmentId: environmentId
    configuration: {
      activeRevisionsMode: 'Single'
      secrets: appSecrets
      registries: [
        {
          server: registryServer
          username: registryUsername
          passwordSecretRef: registryPasswordSecretName
        }
      ]
      ingress: {
        external: true
        targetPort: targetPort
        transport: 'Auto'
        allowInsecure: false
        traffic: [
          {
            latestRevision: true
            weight: 100
          }
        ]
      }
    }
    template: {
      containers: [
        {
          name: 'app'
          image: image
          resources: {
            cpu: json('0.5')
            memory: '1Gi'
          }
          env: containerEnv
          probes: [
            {
              type: 'Startup'
              httpGet: {
                path: probePath
                port: targetPort
              }
              initialDelaySeconds: 10
              periodSeconds: 10
              failureThreshold: 30
            }
            {
              type: 'Readiness'
              httpGet: {
                path: probePath
                port: targetPort
              }
              initialDelaySeconds: 5
              periodSeconds: 10
              failureThreshold: 3
            }
            {
              type: 'Liveness'
              httpGet: {
                path: probePath
                port: targetPort
              }
              initialDelaySeconds: 20
              periodSeconds: 30
              failureThreshold: 3
            }
          ]
        }
      ]
      scale: {
        minReplicas: minReplicas
        maxReplicas: maxReplicas
      }
    }
  }
}

@description('The retained app-level FQDN.')
output fqdn string = app.properties.configuration.ingress.fqdn
