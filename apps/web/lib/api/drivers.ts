import type {
  DriverAvailabilityTarget,
  DriverDelivery,
  DriverDeliveryLoadingContext,
  DriverProfile,
  PaginatedAvailableDeliveries,
  PaginatedDriverDeliveries,
  UpdateDeliveryScheduleInput,
  UpdateDeliveryStatusInput,
} from '@iriefishmongers/types';

import { apiGet, apiPatch, apiPost } from '../api-client';

export function fetchMyDriverProfile(): Promise<DriverProfile> {
  return apiGet<DriverProfile>('/drivers/me');
}

export function updateMyDriverAvailability(
  status: DriverAvailabilityTarget,
): Promise<DriverProfile> {
  return apiPatch<DriverProfile>('/drivers/me/availability', { status });
}

export function fetchAvailableDeliveries(
  page = 1,
  pageSize = 20,
): Promise<PaginatedAvailableDeliveries> {
  return apiGet<PaginatedAvailableDeliveries>(
    `/delivery/available?page=${page}&pageSize=${pageSize}`,
  );
}

export function claimAvailableDelivery(
  vendorOrderId: string,
): Promise<DriverDelivery> {
  return apiPost<DriverDelivery>('/delivery/assign', { vendorOrderId });
}

export function fetchMyDeliveries(
  page = 1,
  pageSize = 50,
): Promise<PaginatedDriverDeliveries> {
  return apiGet<PaginatedDriverDeliveries>(
    `/delivery/mine?page=${page}&pageSize=${pageSize}`,
  );
}

export function updateDeliverySchedule(
  deliveryId: string,
  input: UpdateDeliveryScheduleInput,
): Promise<DriverDelivery> {
  return apiPatch<DriverDelivery>(
    `/delivery/${encodeURIComponent(deliveryId)}/schedule`,
    input,
  );
}

export function updateDeliveryStatus(
  deliveryId: string,
  input: UpdateDeliveryStatusInput,
): Promise<DriverDelivery> {
  return apiPatch<DriverDelivery>(
    `/delivery/${encodeURIComponent(deliveryId)}/status`,
    input,
  );
}

export function fetchDriverLoadingContext(
  deliveryId: string,
): Promise<DriverDeliveryLoadingContext> {
  return apiGet<DriverDeliveryLoadingContext>(
    `/telemetry/deliveries/${encodeURIComponent(deliveryId)}/loading-context`,
  );
}

export function recordCargoPickup(input: {
  deliveryId: string;
  fleetAssetId: string;
  compartmentId: string;
  trackerId?: string;
  sensorDeviceId?: string;
  notes?: string;
  lots: Array<{ lotId: string; quantityUnits: number }>;
}): Promise<unknown> {
  return apiPost('/telemetry/cargo/pickup', input);
}

export function recordCargoHandover(input: {
  deliveryId: string;
  compartmentId?: string;
  notes?: string;
  items?: Array<{ lotId: string; handedOverQuantity: number }>;
}): Promise<unknown> {
  return apiPost('/telemetry/cargo/handover', input);
}

export function recordCargoTransfer(input: {
  deliveryId: string;
  fromCompartmentId?: string;
  toFleetAssetId: string;
  toCompartmentId: string;
  notes?: string;
  items?: Array<{ lotId: string; transferQuantity: number }>;
}): Promise<unknown> {
  return apiPost('/telemetry/cargo/transfer', input);
}

export function recordManualTemperatureCheck(input: {
  lotId: string;
  checkpoint: 'DRIVER_PICKUP' | 'DELIVERY';
  temperatureC: number;
  notes?: string;
}): Promise<unknown> {
  return apiPost('/temperature-readings', input);
}
