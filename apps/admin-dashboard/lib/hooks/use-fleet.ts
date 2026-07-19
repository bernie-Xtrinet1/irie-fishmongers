'use client';

import type { FleetAsset, FleetAssetStatus, FleetTrip, Paginated } from '@iriefishmongers/types';
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';

import {
  fetchFleetAssets,
  fetchFleetTrips,
  updateFleetAssetStatus,
  type ListFleetAssetsParams,
  type ListFleetTripsParams,
} from '@/lib/api/fleet';

export function useFleetAssets(params: ListFleetAssetsParams): UseQueryResult<Paginated<FleetAsset>> {
  return useQuery({
    queryKey: ['fleet-assets', params],
    queryFn: () => fetchFleetAssets(params),
  });
}

export function useUpdateFleetAssetStatus(): ReturnType<
  typeof useMutation<FleetAsset, Error, { id: string; status: FleetAssetStatus }>
> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, status }: { id: string; status: FleetAssetStatus }) => updateFleetAssetStatus(id, status),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['fleet-assets'] });
    },
  });
}

export function useFleetTrips(params: ListFleetTripsParams): UseQueryResult<Paginated<FleetTrip>> {
  return useQuery({
    queryKey: ['fleet-trips', params],
    queryFn: () => fetchFleetTrips(params),
  });
}
