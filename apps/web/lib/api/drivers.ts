import type {
  DriverAvailabilityTarget,
  DriverDelivery,
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
