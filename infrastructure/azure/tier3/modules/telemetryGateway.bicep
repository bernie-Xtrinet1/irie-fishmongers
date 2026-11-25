@description('Azure region for telemetry receiver resources')
param location string

@description('Resource naming prefix (e.g. irie-staging)')
param namePrefix string

@description('Common Azure resource tags')
param tags object = {}

@description('Full container image URI containing dist/telemetry-gateway.js (reuses built backend image)')
param telemetryGatewayImage string

@description('Public HTTPS base URL of ca-irie-backend API (e.g. https://ca-irie-backend....azurecontainerapps.io/api/v1)')
param backendApiUrl string

@description('Registry server hosting telemetryGatewayImage')
param registryServer string

@description('Registry pull username')
param registryUsername string

@secure()
@description('Registry pull token / password')
param registryPassword string

@secure()
@description('Shared GATEWAY-scoped telemetry credential issued via POST /api/v1/telemetry/credentials')
param telemetryGatewayToken string

@description('Raw Teltonika Codec 8 Extended TCP/TLS port exposed to LTE trackers')
param tcpPort int = 5027

@description('DNS name label for the public ACI telemetry receiver')
param dnsNameLabel string = '${namePrefix}-teltonika-gw'

@description('Set true to also deploy an Azure IoT Hub (MQTT TLS 8883) for Teltonika Codec JSON over TLS')
param enableIotHub bool = false

resource telemetryAci 'Microsoft.ContainerInstance/containerGroups@2023-05-01' = {
  name: 'aci-${namePrefix}-teltonika-gw'
  location: location
  tags: tags
  properties: {
    osType: 'Linux'
    restartPolicy: 'Always'
    ipAddress: {
      type: 'Public'
      dnsNameLabel: dnsNameLabel
      ports: [
        {
          protocol: 'TCP'
          port: tcpPort
        }
      ]
    }
    imageRegistryCredentials: [
      {
        server: registryServer
        username: registryUsername
        password: registryPassword
      }
    ]
    containers: [
      {
        name: 'teltonika-codec8e-gateway'
        properties: {
          image: telemetryGatewayImage
          command: [
            'node'
            'dist/telemetry-gateway.js'
          ]
          environmentVariables: [
            { name: 'NODE_ENV', value: 'production' }
            { name: 'TELEMETRY_TCP_PORT', value: string(tcpPort) }
            { name: 'BACKEND_API_URL', value: backendApiUrl }
            { name: 'TELEMETRY_GATEWAY_TOKEN', secureValue: telemetryGatewayToken }
          ]
          resources: {
            // Note: Azure Container Instances bills Linux container groups at a
            // minimum of 1 vCPU and 1 GB memory (rounded up to whole vCPU).
            // Keep this Bicep module UNPROVISIONED until service/cost approval.
            requests: {
              cpu: json('1')
              memoryInGB: json('1')
            }
          }
        }
      }
    ]
  }
}

resource iotHub 'Microsoft.Devices/IotHubs@2023-06-30' = if (enableIotHub) {
  name: 'iothub-${namePrefix}'
  location: location
  tags: tags
  sku: {
    name: 'S1'
    capacity: 1
  }
  properties: {
    minTlsVersion: '1.2'
  }
}

output gatewayFqdn string = telemetryAci.properties.ipAddress.fqdn
output gatewayIpAddress string = telemetryAci.properties.ipAddress.ip
output gatewayPort int = tcpPort
output iotHubHostName string = enableIotHub ? iotHub.properties.hostName : ''
