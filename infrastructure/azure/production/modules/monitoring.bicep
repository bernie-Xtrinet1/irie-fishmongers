// Production monitoring & cost guardrails: Log Analytics, Application Insights, and Monthly Budget.

@description('Azure region.')
param location string

@description('Name prefix.')
param namePrefix string

@description('Environment label.')
param environmentName string

@description('Tags.')
param tags object

@description('Log retention in days.')
@minValue(30)
@maxValue(730)
param logRetentionInDays int

@description('Daily ingestion cap in GB (string decimal for Bicep json()).')
param logDailyQuotaGb string

@description('Monthly budget threshold in USD.')
@minValue(1)
param budgetAmount int

@description('Optional email recipients for budget alerts. Empty falls back to Resource Group Owners.')
param budgetContactEmails array

@description('Budget start date (YYYY-MM-01).')
param budgetStartDate string

var logAnalyticsName = 'log-${namePrefix}-${environmentName}'

resource logAnalytics 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: logAnalyticsName
  location: location
  tags: tags
  properties: {
    sku: {
      name: 'PerGB2018'
    }
    retentionInDays: logRetentionInDays
    workspaceCapping: {
      dailyQuotaGb: json(logDailyQuotaGb)
    }
    features: {
      enableLogAccessUsingOnlyResourcePermissions: true
    }
  }
}

resource appInsights 'Microsoft.Insights/components@2020-02-02' = {
  name: 'appi-${namePrefix}-${environmentName}'
  location: location
  tags: tags
  kind: 'web'
  properties: {
    Application_Type: 'web'
    WorkspaceResourceId: logAnalytics.id
  }
}

var baseActualNotification = {
  enabled: true
  operator: 'GreaterThanOrEqualTo'
  threshold: 100
  thresholdType: 'Actual'
  contactRoles: [
    'Owner'
  ]
}

var baseForecastNotification = {
  enabled: true
  operator: 'GreaterThanOrEqualTo'
  threshold: 80
  thresholdType: 'Forecasted'
  contactRoles: [
    'Owner'
  ]
}

var actualNotification = empty(budgetContactEmails) ? baseActualNotification : union(baseActualNotification, {
  contactEmails: budgetContactEmails
})

var forecastNotification = empty(budgetContactEmails) ? baseForecastNotification : union(baseForecastNotification, {
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
      Forecasted_GreaterThanOrEqualTo_80_Percent: forecastNotification
      Actual_GreaterThanOrEqualTo_100_Percent: actualNotification
    }
  }
}

output logAnalyticsName string = logAnalytics.name
output logAnalyticsId string = logAnalytics.id
output appInsightsId string = appInsights.id
