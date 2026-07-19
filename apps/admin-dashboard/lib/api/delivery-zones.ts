import type { DeliveryZone } from '@iriefishmongers/types';

import { apiGet, apiPatch, apiPost } from '@/lib/api-client';

export interface CreateDeliveryZoneInput {
  name: string;
  code: string;
  description?: string;
}

export interface UpdateDeliveryZoneInput {
  name?: string;
  description?: string;
  active?: boolean;
}

// Unpaginated - the backend returns a plain array (registration-form zone
// pickers and dispatch views both need the full list, and zones are
// operationally few in number).
export async function fetchDeliveryZones(): Promise<DeliveryZone[]> {
  return apiGet<DeliveryZone[]>('/delivery-zones');
}

export async function createDeliveryZone(input: CreateDeliveryZoneInput): Promise<DeliveryZone> {
  return apiPost<DeliveryZone>('/delivery-zones', input);
}

export async function updateDeliveryZone(id: string, input: UpdateDeliveryZoneInput): Promise<DeliveryZone> {
  return apiPatch<DeliveryZone>(`/delivery-zones/${id}`, input);
}
