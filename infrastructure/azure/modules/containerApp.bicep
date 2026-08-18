// Phase 17E — a single placeholder Container App used to reserve one
// authoritative external-ingress FQDN. It is intentionally minimal:
//  - external ingress on the PLACEHOLDER image's port (80), which matches the
//    port the running placeholder container actually listens on;
//  - the public MCR placeholder image (no app code, secrets, or dependencies);
//  - NO health probes (must not depend on /api/v1/health or any app path);
//  - scale to zero (minReplicas: 0).
// Tier 3 later swaps in the real application image AND updates the ingress
// target port to the real application port (recorded here as the
// `futureAppPort` tag). The app-level FQDN is stable across revision/image/port
// changes, so this reservation is retained.

@description('Container App name.')
param name string

@description('Azure region.')
param location string

@description('Tags.')
param tags object

@description('Managed environment resource id.')
param environmentId string

@description('Ingress target port for the PLACEHOLDER container (must equal the port the placeholder image listens on, 80). Not the real app port.')
@minValue(1)
@maxValue(65535)
param targetPort int

@description('Future (Tier-3) real application port. Recorded as a tag only; NOT used by the placeholder ingress.')
@minValue(1)
@maxValue(65535)
param futureAppPort int

@description('Placeholder container image (public, credential-free).')
param image string

// Record the future real app port on the resource as documentation that
// travels with it, without feeding it into the placeholder ingress.
var appTags = union(tags, {
  futureAppPort: string(futureAppPort)
})

resource containerApp 'Microsoft.App/containerApps@2024-03-01' = {
  name: name
  location: location
  tags: appTags
  properties: {
    managedEnvironmentId: environmentId
    configuration: {
      activeRevisionsMode: 'Single'
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
          name: 'placeholder'
          image: image
          resources: {
            cpu: json('0.25')
            memory: '0.5Gi'
          }
          // No probes by design: this reservation placeholder must never fail
          // on an application-specific readiness/liveness path.
        }
      ]
      scale: {
        minReplicas: 0
        maxReplicas: 1
      }
    }
  }
}

@description('The Azure-assigned application FQDN for this app (derived from the resource, not fabricated).')
output fqdn string = containerApp.properties.configuration.ingress.fqdn
