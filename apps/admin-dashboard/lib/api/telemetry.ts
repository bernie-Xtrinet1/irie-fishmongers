import type {
  ActiveRunsLiveOverview,
  DeliveryTelemetryDetail,
  EyeCsvImportSummary,
  SensorTelemetryHistory,
  TelemetryDevicesOverview,
} from '@iriefishmongers/types';

import { apiGet, apiPost } from '@/lib/api-client';

export async function fetchActiveRunsLiveOverview(): Promise<ActiveRunsLiveOverview> {
  return apiGet<ActiveRunsLiveOverview>('/telemetry/overview/active-runs');
}

export async function fetchTelemetryDevicesOverview(): Promise<TelemetryDevicesOverview> {
  return apiGet<TelemetryDevicesOverview>('/telemetry/overview/devices');
}

export async function fetchSensorTelemetryHistory(
  sensorId: string,
  params?: { hours?: number; limit?: number },
): Promise<SensorTelemetryHistory> {
  const search = new URLSearchParams();
  if (params?.hours) search.set('hours', String(params.hours));
  if (params?.limit) search.set('limit', String(params.limit));
  const qs = search.toString();
  return apiGet<SensorTelemetryHistory>(`/telemetry/sensors/${sensorId}/history${qs ? `?${qs}` : ''}`);
}

export async function fetchDeliveryTelemetryDetail(deliveryId: string): Promise<DeliveryTelemetryDetail> {
  return apiGet<DeliveryTelemetryDetail>(`/telemetry/deliveries/${deliveryId}`);
}

export async function uploadEyeAppCsvRecovery(
  sensorId: string,
  input: { csvContent: string; notes?: string },
): Promise<EyeCsvImportSummary> {
  return apiPost<EyeCsvImportSummary>(`/telemetry/sensors/${sensorId}/csv-recovery`, input);
}
