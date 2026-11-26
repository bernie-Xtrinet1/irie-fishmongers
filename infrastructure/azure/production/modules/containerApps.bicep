// VNet-integrated Workload Profiles (Consumption) Container Apps environment,
// the three Container Apps (backend, web, admin), and the production migrator Job.
//
// Two-pass design via `deployApplications`:
//   Pass 1 (false): reserves app FQDNs with mcr.microsoft.com/k8se/quickstart:latest
//                   while preserving admin IP access restrictions from day one.
//   Pass 2 (true):  updates containers in place to digest-pinned GHCR images, real ports,
//                   Key Vault secret refs, and creates `ca-irie-db-migrate-prod`.

@description('Azure region.')
param location string

@description('Name prefix.')
param namePrefix string

@description('Environment label.')
param environmentName string

@description('Tags.')
param tags object

@description('Existing Log Analytics workspace name (same resource group).')
param logAnalyticsName string

@description('Delegated Container Apps subnet ID (>= /27).')
param acaSubnetId string

@description('Whether the Container Apps Environment spans multiple Availability Zones.')
param zoneRedundantEnvironment bool

@description('Pass gate: false = placeholders + VNet environment; true = real digest-pinned apps + migrator Job.')
param deployApplications bool

@description('User-assigned managed identity resource ID.')
param identityId string

@description('Key Vault base URI (trailing slash).')
param keyVaultUri string

@description('GHCR server.')
param registryServer string

@description('GHCR username (non-secret).')
param registryUsername string

@description('Digest-pinned backend image reference.')
param backendImage string

@description('Digest-pinned web image reference.')
param webImage string

@description('Digest-pinned admin image reference.')
param adminImage string

@description('Digest-pinned migrator image reference.')
param migratorImage string

@description('Non-empty list of IPv4 CIDRs allowed to reach the admin portal.')
@minLength(1)
param adminAllowedIpCidrs array

@description('Backend replica bounds.')
param backendMinReplicas int
param backendMaxReplicas int

@description('Web storefront replica bounds.')
param webMinReplicas int
param webMaxReplicas int

@description('Admin portal replica bounds.')
param adminMinReplicas int
param adminMaxReplicas int

@description('Public storefront & API host settings for backend runtime validation.')
param backendBaseUrl string
param corsOrigin string
param jwtAccessExpiresIn string
param jwtRefreshExpiresIn string
param wipayApiUrl string
@allowed([ 'customer_pay', 'merchant_absorb', 'split' ])
param wipayFeeStructure string
param sendgridFromEmail string
@allowed([ 'true', 'false' ])
param emailEnabled string
@allowed([ 'strict', 'lax', 'none' ])
param refreshCookieSameSite string
@allowed([ 'true', 'false' ])
param enableScheduler string

var placeholderImage = 'mcr.microsoft.com/k8se/quickstart:latest'
var ghcrPatSecretName = 'ghcr-pat'
var databaseUrlSecretName = 'database-url'
var emailOn = emailEnabled == 'true'

var backendKeyVaultSecretNames = concat(
  [
    databaseUrlSecretName
    'redis-url'
    'jwt-access-secret'
    'jwt-refresh-secret'
    'checkout-quote-signing-secret'
    'wipay-account-number'
    'wipay-api-key'
  ],
  emailOn ? [ 'sendgrid-api-key' ] : [],
  [
    'firebase-project-id'
    'firebase-client-email'
    'firebase-private-key'
    ghcrPatSecretName
  ]
)

var frontendKeyVaultSecretNames = [
  ghcrPatSecretName
]

var adminIpRestrictions = [
  for (cidr, idx) in adminAllowedIpCidrs: {
    name: 'allow-admin-cidr-${idx}'
    description: 'Approved production admin operator workstation/VPN'
    ipAddressRange: cidr
    action: 'Allow'
  }
]

var backendPlainEnv = [
  { name: 'NODE_ENV', value: 'production' }
  { name: 'PORT', value: '3001' }
  { name: 'API_PREFIX', value: 'api/v1' }
  { name: 'CORS_ORIGIN', value: corsOrigin }
  { name: 'APP_BASE_URL', value: backendBaseUrl }
  { name: 'JWT_ACCESS_EXPIRES_IN', value: jwtAccessExpiresIn }
  { name: 'JWT_REFRESH_EXPIRES_IN', value: jwtRefreshExpiresIn }
  { name: 'WIPAY_API_URL', value: wipayApiUrl }
  { name: 'WIPAY_FEE_STRUCTURE', value: wipayFeeStructure }
  { name: 'SENDGRID_FROM_EMAIL', value: sendgridFromEmail }
  { name: 'EMAIL_ENABLED', value: emailEnabled }
  { name: 'REFRESH_COOKIE_SAMESITE', value: refreshCookieSameSite }
  { name: 'ENABLE_SCHEDULER', value: enableScheduler }
]

var backendSecretEnv = concat(
  [
    { name: 'DATABASE_URL', secretRef: databaseUrlSecretName }
    { name: 'REDIS_URL', secretRef: 'redis-url' }
    { name: 'JWT_ACCESS_SECRET', secretRef: 'jwt-access-secret' }
    { name: 'JWT_REFRESH_SECRET', secretRef: 'jwt-refresh-secret' }
    { name: 'CHECKOUT_QUOTE_SIGNING_SECRET', secretRef: 'checkout-quote-signing-secret' }
    { name: 'WIPAY_ACCOUNT_NUMBER', secretRef: 'wipay-account-number' }
    { name: 'WIPAY_API_KEY', secretRef: 'wipay-api-key' }
  ],
  emailOn ? [ { name: 'SENDGRID_API_KEY', secretRef: 'sendgrid-api-key' } ] : [],
  [
    { name: 'FIREBASE_PROJECT_ID', secretRef: 'firebase-project-id' }
    { name: 'FIREBASE_CLIENT_EMAIL', secretRef: 'firebase-client-email' }
    { name: 'FIREBASE_PRIVATE_KEY', secretRef: 'firebase-private-key' }
  ]
)

var appSpecs = [
  {
    key: 'backend'
    name: 'ca-${namePrefix}-backend-${environmentName}'
    image: backendImage
    port: 3001
    probePath: '/api/v1/health'
    minReplicas: backendMinReplicas
    maxReplicas: backendMaxReplicas
    secretNames: backendKeyVaultSecretNames
    plainEnv: backendPlainEnv
    secretEnv: backendSecretEnv
    ipRestrictions: []
  }
  {
    key: 'web'
    name: 'ca-${namePrefix}-web-${environmentName}'
    image: webImage
    port: 3000
    probePath: '/'
    minReplicas: webMinReplicas
    maxReplicas: webMaxReplicas
    secretNames: frontendKeyVaultSecretNames
    plainEnv: [
      { name: 'NODE_ENV', value: 'production' }
      { name: 'PORT', value: '3000' }
      { name: 'HOSTNAME', value: '0.0.0.0' }
    ]
    secretEnv: []
    ipRestrictions: []
  }
  {
    key: 'admin'
    name: 'ca-${namePrefix}-admin-${environmentName}'
    image: adminImage
    port: 3002
    probePath: '/login'
    minReplicas: adminMinReplicas
    maxReplicas: adminMaxReplicas
    secretNames: frontendKeyVaultSecretNames
    plainEnv: [
      { name: 'NODE_ENV', value: 'production' }
      { name: 'PORT', value: '3002' }
      { name: 'HOSTNAME', value: '0.0.0.0' }
    ]
    secretEnv: []
    ipRestrictions: adminIpRestrictions
  }
]

resource logAnalytics 'Microsoft.OperationalInsights/workspaces@2023-09-01' existing = {
  name: logAnalyticsName
}

resource containerEnv 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: 'cae-${namePrefix}-${environmentName}'
  location: location
  tags: tags
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logAnalytics.properties.customerId
        sharedKey: logAnalytics.listKeys().primarySharedKey
      }
    }
    vnetConfiguration: {
      infrastructureSubnetId: acaSubnetId
      internal: false
    }
    workloadProfiles: [
      {
        name: 'Consumption'
        workloadProfileType: 'Consumption'
      }
    ]
    zoneRedundant: zoneRedundantEnvironment
  }
}

resource apps 'Microsoft.App/containerApps@2024-03-01' = [
  for spec in appSpecs: {
    name: spec.name
    location: location
    tags: tags
    identity: deployApplications
      ? {
          type: 'UserAssigned'
          userAssignedIdentities: {
            '${identityId}': {}
          }
        }
      : {
          type: 'None'
        }
    properties: {
      managedEnvironmentId: containerEnv.id
      workloadProfileName: 'Consumption'
      configuration: union(
        {
          activeRevisionsMode: 'Single'
          ingress: union(
            {
              external: true
              targetPort: deployApplications ? spec.port : 80
              transport: 'Auto'
              allowInsecure: false
              traffic: [
                {
                  latestRevision: true
                  weight: 100
                }
              ]
            },
            empty(spec.ipRestrictions) ? {} : { ipSecurityRestrictions: spec.ipRestrictions }
          )
        },
        deployApplications
          ? {
              secrets: map(spec.secretNames, secretName => {
                name: secretName
                keyVaultUrl: '${keyVaultUri}secrets/${secretName}'
                identity: identityId
              })
              registries: [
                {
                  server: registryServer
                  username: registryUsername
                  passwordSecretRef: ghcrPatSecretName
                }
              ]
            }
          : {}
      )
      template: {
        containers: [
          deployApplications
            ? {
                name: 'app'
                image: spec.image
                resources: {
                  cpu: json('0.5')
                  memory: '1Gi'
                }
                env: concat(spec.plainEnv, spec.secretEnv)
                probes: [
                  {
                    type: 'Startup'
                    httpGet: {
                      path: spec.probePath
                      port: spec.port
                    }
                    initialDelaySeconds: 10
                    periodSeconds: 10
                    failureThreshold: 30
                  }
                  {
                    type: 'Readiness'
                    httpGet: {
                      path: spec.probePath
                      port: spec.port
                    }
                    initialDelaySeconds: 5
                    periodSeconds: 10
                    failureThreshold: 3
                  }
                  {
                    type: 'Liveness'
                    httpGet: {
                      path: spec.probePath
                      port: spec.port
                    }
                    initialDelaySeconds: 30
                    periodSeconds: 30
                    failureThreshold: 3
                  }
                ]
              }
            : {
                name: 'placeholder'
                image: placeholderImage
                resources: {
                  cpu: json('0.25')
                  memory: '0.5Gi'
                }
              }
        ]
        scale: {
          minReplicas: deployApplications ? spec.minReplicas : 0
          maxReplicas: deployApplications ? spec.maxReplicas : 1
        }
      }
    }
  }
]

resource migratorJob 'Microsoft.App/jobs@2024-03-01' = if (deployApplications) {
  name: 'ca-${namePrefix}-db-migrate-${environmentName}'
  location: location
  tags: tags
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${identityId}': {}
    }
  }
  properties: {
    environmentId: containerEnv.id
    workloadProfileName: 'Consumption'
    configuration: {
      triggerType: 'Manual'
      replicaTimeout: 1800
      replicaRetryLimit: 1
      manualTriggerConfig: {
        parallelism: 1
        replicaCompletionCount: 1
      }
      secrets: [
        {
          name: databaseUrlSecretName
          keyVaultUrl: '${keyVaultUri}secrets/${databaseUrlSecretName}'
          identity: identityId
        }
        {
          name: ghcrPatSecretName
          keyVaultUrl: '${keyVaultUri}secrets/${ghcrPatSecretName}'
          identity: identityId
        }
      ]
      registries: [
        {
          server: registryServer
          username: registryUsername
          passwordSecretRef: ghcrPatSecretName
        }
      ]
    }
    template: {
      containers: [
        {
          name: 'migrator'
          image: migratorImage
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

output backendFqdn string = apps[0].properties.configuration.ingress.fqdn
output webFqdn string = apps[1].properties.configuration.ingress.fqdn
output adminFqdn string = apps[2].properties.configuration.ingress.fqdn
output environmentStaticIp string = containerEnv.properties.staticIp
output customDomainVerificationId string = containerEnv.properties.customDomainConfiguration.customDomainVerificationId
output requiredKeyVaultSecretNames array = backendKeyVaultSecretNames
