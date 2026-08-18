// Phase 17E — Tier-1 foundation (resource-group scope).
//
// Creates: Log Analytics workspace, Container Apps managed environment, three
// placeholder Container Apps (external ingress → FQDN reservation), and the
// resource-group cost budget. No Tier-3 runtime resources are present here.

@description('Azure region.')
param location string

@description('Short, lowercase name prefix.')
param namePrefix string

@description('Environment label.')
param environmentName string

@description('Tags applied to every resource.')
param tags object

@description('Monthly cost budget (USD).')
param budgetAmount int

@description('Optional budget alert email recipients. Empty => notify RG Owners by role.')
param budgetContactEmails array

@description('Budget start date (YYYY-MM-01).')
param budgetStartDate string

@description('Ingress target port for all three placeholder apps (must match the placeholder image port, 80).')
param placeholderIngressPort int

@description('Future (Tier-3) backend application port. Metadata only.')
param backendAppPort int

@description('Future (Tier-3) web application port. Metadata only.')
param webAppPort int

@description('Future (Tier-3) admin application port. Metadata only.')
param adminAppPort int

// Public Microsoft sample image used ONLY to reserve the app FQDNs. It pulls
// from MCR without any registry credential and carries no Irie Fishmongers
// code, secrets, or dependency on PostgreSQL/Redis. Its ingress targetPort is
// set to 80 (the port this image listens on), so the placeholder ingress is
// internally consistent. Tier 3 replaces the image and updates the ingress
// targetPort to the real app port; the app-level FQDN is retained.
var placeholderImage = 'mcr.microsoft.com/k8se/quickstart:latest'

resource logAnalytics 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: 'log-${namePrefix}-${environmentName}'
  location: location
  tags: tags
  properties: {
    sku: {
      name: 'PerGB2018'
    }
    retentionInDays: 30
    workspaceCapping: {
      dailyQuotaGb: json('0.5')
    }
    features: {
      enableLogAccessUsingOnlyResourcePermissions: true
    }
  }
}

resource containerEnv 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: 'cae-${namePrefix}-${environmentName}'
  location: location
  tags: tags
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        // Fetched at deploy time from the workspace — NOT a secret stored in
        // source. The shared key never appears in this template's text.
        customerId: logAnalytics.properties.customerId
        sharedKey: logAnalytics.listKeys().primarySharedKey
      }
    }
  }
}

module backendApp 'containerApp.bicep' = {
  name: 'placeholder-backend'
  params: {
    name: 'ca-${namePrefix}-backend'
    location: location
    tags: tags
    environmentId: containerEnv.id
    targetPort: placeholderIngressPort
    futureAppPort: backendAppPort
    image: placeholderImage
  }
}

module webApp 'containerApp.bicep' = {
  name: 'placeholder-web'
  params: {
    name: 'ca-${namePrefix}-web'
    location: location
    tags: tags
    environmentId: containerEnv.id
    targetPort: placeholderIngressPort
    futureAppPort: webAppPort
    image: placeholderImage
  }
}

module adminApp 'containerApp.bicep' = {
  name: 'placeholder-admin'
  params: {
    name: 'ca-${namePrefix}-admin'
    location: location
    tags: tags
    environmentId: containerEnv.id
    targetPort: placeholderIngressPort
    futureAppPort: adminAppPort
    image: placeholderImage
  }
}

// Budget notification: use role-based recipients ('Owner') so a $75 alert can
// exist without inventing an email address or introducing an Action Group.
// When budgetContactEmails is provided, those addresses are added as well.
var notificationBase = {
  enabled: true
  operator: 'GreaterThanOrEqualTo'
  threshold: 100
  thresholdType: 'Actual'
  contactRoles: [
    'Owner'
  ]
}
var budgetNotification = empty(budgetContactEmails) ? notificationBase : union(notificationBase, {
  contactEmails: budgetContactEmails
})

resource budget 'Microsoft.Consumption/budgets@2023-11-01' = {
  name: 'budget-${namePrefix}-${environmentName}'
  properties: {
    category: 'Cost'
    amount: budgetAmount
    timeGrain: 'Monthly'
    timePeriod: {
      startDate: budgetStartDate
    }
    notifications: {
      Actual_GreaterThanOrEqualTo_100_Percent: budgetNotification
    }
  }
}

output backendFqdn string = backendApp.outputs.fqdn
output webFqdn string = webApp.outputs.fqdn
output adminFqdn string = adminApp.outputs.fqdn
output backendUrl string = 'https://${backendApp.outputs.fqdn}'
output webUrl string = 'https://${webApp.outputs.fqdn}'
output adminUrl string = 'https://${adminApp.outputs.fqdn}'
output backendApiUrl string = 'https://${backendApp.outputs.fqdn}/api/v1'

// Tier-3 metadata only — the real application ports for the eventual image swap.
output futureAppPorts object = {
  backend: backendAppPort
  web: webAppPort
  admin: adminAppPort
}
