'use client';

import type { FleetAsset, FleetAssetStatus, FleetTrip, Paginated } from '@iriefishmongers/types';
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';

import {
  assignFleetAssetDriver,
  createFleetAsset,
  fetchFleetAssets,
  fetchFleetTrips,
  updateFleetAssetStatus,
  type CreateFleetAssetInput,
  type ListFleetAssetsParams,
  type ListFleetTripsParams,
} from '@/lib/api/fleet';

export function useCreateFleetAsset(): ReturnType<
  typeof useMutation<FleetAsset, Error, CreateFleetAssetInput>
> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: CreateFleetAssetInput) => createFleetAsset(input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['fleet-assets'] });
      void queryClient.invalidateQueries({ queryKey: ['telemetry-compartments'] });
    },
  });
}

export function useAssignFleetAssetDriver(): ReturnType<
  typeof useMutation<FleetAsset, Error, { id: string; currentDriverId: string | null }>
> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, currentDriverId }) => assignFleetAssetDriver(id, currentDriverId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['fleet-assets'] });
    },
  });
}

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
