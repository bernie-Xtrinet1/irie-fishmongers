using './main.bicep'

// Phase 17E Tier-1 staging foundation — non-secret parameters only.
// No secrets, no connection strings, no image references, no DNS.

param location = 'eastus2'
param namePrefix = 'irie'
param environmentName = 'staging'
param resourceGroupName = 'rg-iriefishmongers-staging'

// Cost guardrail. budgetContactEmails left empty on purpose: the alert then
// notifies Resource Group Owners by role — no address is invented and no
// Action Group / notification infrastructure is created. Supply real
// addresses here later if email delivery is wanted.
param budgetAmount = 75
param budgetContactEmails = []

// Tier-1 placeholder ingress port: must match the placeholder image
// (mcr.microsoft.com/k8se/quickstart listens on 80). This is NOT the real app port.
param placeholderIngressPort = 80

// Tier-3 real application ports — metadata only (recorded as tags/outputs).
// These are NOT used for the Tier-1 placeholder ingress; Tier 3 will set each
// Container App's ingress to these when the real images are deployed.
param backendAppPort = 3001
param webAppPort = 3000
param adminAppPort = 3002

// budgetStartDate intentionally omitted -> main.bicep defaults it to the first
// day of the current month at deployment time.
