import type { FleetAsset, FleetAssetStatus, FleetAssetType, FleetOwnership, FleetTrip, Paginated } from '@iriefishmongers/types';

import { apiGet, apiPatch, apiPost } from '@/lib/api-client';

export interface CreateFleetAssetInput {
  zoneId: string;
  assetType: FleetAssetType;
  ownership: FleetOwnership;
  licensePlate: string;
  capacityLbs: number;
  coldChainCapable?: boolean;
}

export interface ListFleetAssetsParams {
  page: number;
  pageSize: number;
  zoneId?: string;
  status?: FleetAssetStatus;
}

export async function createFleetAsset(input: CreateFleetAssetInput): Promise<FleetAsset> {
  return apiPost<FleetAsset>('/fleet-assets', input);
}

export async function assignFleetAssetDriver(
  id: string,
  currentDriverId: string | null,
): Promise<FleetAsset> {
  return apiPatch<FleetAsset>(`/fleet-assets/${id}`, { currentDriverId });
}

export async function fetchFleetAssets(params: ListFleetAssetsParams): Promise<Paginated<FleetAsset>> {
  const search = new URLSearchParams();
  search.set('page', String(params.page));
  search.set('pageSize', String(params.pageSize));
  if (params.zoneId) search.set('zoneId', params.zoneId);
  if (params.status) search.set('status', params.status);

  return apiGet<Paginated<FleetAsset>>(`/fleet-assets?${search.toString()}`);
}

export async function updateFleetAssetStatus(id: string, status: FleetAssetStatus): Promise<FleetAsset> {
  return apiPatch<FleetAsset>(`/fleet-assets/${id}`, { status });
}

export interface ListFleetTripsParams {
  page: number;
  pageSize: number;
  fleetAssetId?: string;
  driverId?: string;
}

export async function fetchFleetTrips(params: ListFleetTripsParams): Promise<Paginated<FleetTrip>> {
  const search = new URLSearchParams();
  search.set('page', String(params.page));
  search.set('pageSize', String(params.pageSize));
  if (params.fleetAssetId) search.set('fleetAssetId', params.fleetAssetId);
  if (params.driverId) search.set('driverId', params.driverId);

  return apiGet<Paginated<FleetTrip>>(`/fleet-trips?${search.toString()}`);
}
