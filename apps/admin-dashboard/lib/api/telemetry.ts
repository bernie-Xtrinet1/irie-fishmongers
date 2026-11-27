import type {
  ActiveRunsLiveOverview,
  CompartmentKind,
  DeliveryTelemetryDetail,
  EyeCsvImportSummary,
  PortableCoolerSummary,
  SensorTelemetryHistory,
  TelemetryDevicesOverview,
  TrackerHardwareModel,
} from '@iriefishmongers/types';

import { apiGet, apiPost } from '@/lib/api-client';

export interface CreateCompartmentInput {
  fleetAssetId?: string;
  compartmentKind?: CompartmentKind;
  coolerCode?: string;
  compartmentCode?: string;
  label: string;
  storageType?: 'FRESH' | 'FROZEN';
  targetMinC?: number;
  targetMaxC?: number;
  sensorSlot?: number;
  notes?: string;
}

export interface RegisterTrackerInput {
  fleetAssetId: string;
  imei: string;
  hardwareModel?: TrackerHardwareModel;
  firmwareVersion?: string;
  simIccid?: string;
  simCarrier?: string;
}

export interface RegisterSensorInput {
  compartmentId: string;
  deviceCode: string;
  bleMacAddress?: string;
  sensorSlot?: number;
  firmwareVersion?: string;
}

export async function fetchCompartments(): Promise<PortableCoolerSummary[]> {
  return apiGet<PortableCoolerSummary[]>('/telemetry/compartments');
}

export async function createCompartment(input: CreateCompartmentInput): Promise<unknown> {
  return apiPost('/telemetry/compartments', input);
}

export async function assignCoolerVehicle(
  compartmentId: string,
  input: { fleetAssetId: string; sensorSlot?: number; notes?: string },
): Promise<unknown> {
  return apiPost(`/telemetry/compartments/${compartmentId}/assign`, input);
}

export async function unassignCoolerVehicle(
  compartmentId: string,
  input: { notes?: string } = {},
): Promise<unknown> {
  return apiPost(`/telemetry/compartments/${compartmentId}/unassign`, input);
}

export async function registerVehicleTracker(input: RegisterTrackerInput): Promise<unknown> {
  return apiPost('/telemetry/trackers', input);
}

export async function registerCargoSensor(input: RegisterSensorInput): Promise<unknown> {
  return apiPost('/telemetry/sensors', input);
}

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
