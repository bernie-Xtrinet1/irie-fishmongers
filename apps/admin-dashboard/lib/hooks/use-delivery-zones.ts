'use client';

import type { DeliveryZone } from '@iriefishmongers/types';
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';

import {
  createDeliveryZone,
  fetchDeliveryZones,
  updateDeliveryZone,
  type CreateDeliveryZoneInput,
  type UpdateDeliveryZoneInput,
} from '@/lib/api/delivery-zones';

const ZONES_QUERY_KEY = ['delivery-zones'] as const;

export function useDeliveryZones(): UseQueryResult<DeliveryZone[]> {
  return useQuery({
    queryKey: ZONES_QUERY_KEY,
    queryFn: () => fetchDeliveryZones(),
  });
}

export function useCreateDeliveryZone(): ReturnType<typeof useMutation<DeliveryZone, Error, CreateDeliveryZoneInput>> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: CreateDeliveryZoneInput) => createDeliveryZone(input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ZONES_QUERY_KEY });
    },
  });
}

export function useUpdateDeliveryZone(): ReturnType<
  typeof useMutation<DeliveryZone, Error, { id: string; input: UpdateDeliveryZoneInput }>
> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateDeliveryZoneInput }) => updateDeliveryZone(id, input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ZONES_QUERY_KEY });
    },
  });
}
