import type {
  AlertSeverity,
  AssignableLotStatus,
  EmergencyResponse,
  EmergencyResponseStatus,
  Paginated,
  SeafoodLotAdmin,
  TemperatureAlert,
  TemperatureDevice,
} from '@iriefishmongers/types';

import { apiGet, apiPatch } from '@/lib/api-client';

export interface ListTemperatureAlertsParams {
  page: number;
  pageSize: number;
  severity?: AlertSeverity;
  resolved?: boolean;
}

export async function fetchTemperatureAlerts(
  params: ListTemperatureAlertsParams,
): Promise<Paginated<TemperatureAlert>> {
  const search = new URLSearchParams();
  search.set('page', String(params.page));
  search.set('pageSize', String(params.pageSize));
  if (params.severity) search.set('severity', params.severity);
  if (params.resolved !== undefined) search.set('resolved', String(params.resolved));

  return apiGet<Paginated<TemperatureAlert>>(`/temperature-alerts?${search.toString()}`);
}

export async function resolveTemperatureAlert(id: string): Promise<TemperatureAlert> {
  return apiPatch<TemperatureAlert>(`/temperature-alerts/${id}/resolve`, {});
}

export async function fetchTemperatureDevices(): Promise<TemperatureDevice[]> {
  return apiGet<TemperatureDevice[]>('/temperature-devices');
}

export async function calibrateTemperatureDevice(id: string): Promise<TemperatureDevice> {
  return apiPatch<TemperatureDevice>(`/temperature-devices/${id}/calibrate`, {});
}

export async function fetchEmergencyResponses(status?: EmergencyResponseStatus): Promise<EmergencyResponse[]> {
  const search = new URLSearchParams();
  if (status) search.set('status', status);
  const query = search.toString();
  return apiGet<EmergencyResponse[]>(`/food-safety/emergency-responses${query ? `?${query}` : ''}`);
}

export async function acknowledgeEmergencyResponse(id: string): Promise<EmergencyResponse> {
  return apiPatch<EmergencyResponse>(`/food-safety/emergency-responses/${id}/acknowledge`, {});
}

export interface UpdateEmergencyResponseStatusInput {
  status: EmergencyResponseStatus;
  actionsTaken?: string;
  rootCause?: string;
  correctiveAction?: string;
  preventiveAction?: string;
}

export async function updateEmergencyResponseStatus(
  id: string,
  input: UpdateEmergencyResponseStatusInput,
): Promise<EmergencyResponse> {
  return apiPatch<EmergencyResponse>(`/food-safety/emergency-responses/${id}/status`, input);
}

export interface ListQuarantinedLotsParams {
  page: number;
  pageSize: number;
}

// Fixed to status=QUARANTINED - this section of the screen is specifically
// the quarantine queue, not a general lot browser (see the approved 12A
// plan's compatibility matrix).
export async function fetchQuarantinedLots(params: ListQuarantinedLotsParams): Promise<Paginated<SeafoodLotAdmin>> {
  const search = new URLSearchParams();
  search.set('page', String(params.page));
  search.set('pageSize', String(params.pageSize));
  search.set('status', 'QUARANTINED');

  return apiGet<Paginated<SeafoodLotAdmin>>(`/seafood-lots?${search.toString()}`);
}

export interface UpdateLotStatusInput {
  status: AssignableLotStatus;
  reason?: string;
}

export async function updateLotStatus(id: string, input: UpdateLotStatusInput): Promise<SeafoodLotAdmin> {
  return apiPatch<SeafoodLotAdmin>(`/seafood-lots/${id}/status`, input);
}
