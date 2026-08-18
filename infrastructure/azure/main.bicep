// Phase 17E — Tier-1 Azure staging FOUNDATION (hostname reservation only).
//
// Scope: creates the resource group and the minimum resources needed to obtain
// the three authoritative Azure Container Apps FQDNs that unblock Gate B2.
// It deliberately contains NO PostgreSQL, Redis, Key Vault, managed identity,
// GHCR/registry credentials, ACR, GitHub OIDC, DNS, application images, or
// application secrets — those are deferred to a separately-authorized Tier 3.
//
// This template is authored for review only. Nothing here has been deployed;
// no Azure API call, login, or provisioning was performed.

targetScope = 'subscription'

@description('Azure region for all Tier-1 staging resources.')
param location string = 'eastus2'

@description('Short, lowercase name prefix used in resource names.')
@minLength(2)
@maxLength(8)
param namePrefix string = 'irie'

@description('Environment label used in resource names and tags.')
param environmentName string = 'staging'

@description('Name of the resource group to create for the staging foundation.')
param resourceGroupName string = 'rg-iriefishmongers-staging'

@description('Monthly cost budget (USD) for the resource-group alert.')
@minValue(1)
param budgetAmount int = 75

@description('Optional email recipients for the budget alert. When empty, the alert notifies Resource Group Owners via role membership — no address is invented and no Action Group is created.')
param budgetContactEmails array = []

@description('First day of the month the budget starts tracking (YYYY-MM-01). Defaults to the first of the current month at deployment time.')
param budgetStartDate string = utcNow('yyyy-MM-01')

@description('Ingress target port for ALL THREE Tier-1 placeholder apps. This must match the port the placeholder image listens on (mcr.microsoft.com/k8se/quickstart listens on 80). It is NOT the real application port.')
param placeholderIngressPort int = 80

// The real application ports below are Tier-3 METADATA ONLY. They are recorded
// as resource tags and outputs for the eventual deployment, and are
// deliberately NOT used for the Tier-1 placeholder ingress.
@description('Future (Tier-3) backend application port. Metadata only; not used for the placeholder ingress.')
param backendAppPort int = 3001

@description('Future (Tier-3) web application port. Metadata only; not used for the placeholder ingress.')
param webAppPort int = 3000

@description('Future (Tier-3) admin application port. Metadata only; not used for the placeholder ingress.')
param adminAppPort int = 3002

var tags = {
  project: 'iriefishmongers'
  environment: environmentName
  tier: 'staging-foundation'
  phase: '17E-tier1'
  managedBy: 'bicep'
  purpose: 'fqdn-reservation'
}

resource rg 'Microsoft.Resources/resourceGroups@2024-03-01' = {
  name: resourceGroupName
  location: location
  tags: tags
}

module foundation 'modules/foundation.bicep' = {
  name: 'tier1-foundation'
  scope: rg
  params: {
    location: location
    namePrefix: namePrefix
    environmentName: environmentName
    tags: tags
    budgetAmount: budgetAmount
    budgetContactEmails: budgetContactEmails
    budgetStartDate: budgetStartDate
    placeholderIngressPort: placeholderIngressPort
    backendAppPort: backendAppPort
    webAppPort: webAppPort
    adminAppPort: adminAppPort
  }
}

@description('The resource group that was created.')
output resourceGroupName string = rg.name

@description('Authoritative backend Container App FQDN (from Azure, not fabricated).')
output backendFqdn string = foundation.outputs.backendFqdn

@description('Authoritative web Container App FQDN (from Azure, not fabricated).')
output webFqdn string = foundation.outputs.webFqdn

@description('Authoritative admin Container App FQDN (from Azure, not fabricated).')
output adminFqdn string = foundation.outputs.adminFqdn

@description('Derived HTTPS URL for the backend app.')
output backendUrl string = foundation.outputs.backendUrl

@description('Derived HTTPS URL for the web app.')
output webUrl string = foundation.outputs.webUrl

@description('Derived HTTPS URL for the admin app.')
output adminUrl string = foundation.outputs.adminUrl

@description('Derived backend API base URL ending in /api/v1 — the value for STAGING_NEXT_PUBLIC_API_URL.')
output backendApiUrl string = foundation.outputs.backendApiUrl

@description('Future (Tier-3) real application ports, surfaced for the eventual image swap. NOT used by the Tier-1 placeholder ingress.')
output futureAppPorts object = foundation.outputs.futureAppPorts
