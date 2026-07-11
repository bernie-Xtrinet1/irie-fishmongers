'use client';

import type { AssignableVendorStatus, Paginated, VendorAdmin } from '@iriefishmongers/types';
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';

import { fetchVendors, updateVendorStatus, type ListVendorsParams } from '@/lib/api/vendors';

export function useVendors(params: ListVendorsParams): UseQueryResult<Paginated<VendorAdmin>> {
  return useQuery({
    queryKey: ['vendors', params],
    queryFn: () => fetchVendors(params),
  });
}

export function useUpdateVendorStatus(): ReturnType<
  typeof useMutation<VendorAdmin, Error, { id: string; status: AssignableVendorStatus }>
> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, status }: { id: string; status: AssignableVendorStatus }) => updateVendorStatus(id, status),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['vendors'] });
      // A vendor status change moves the vendors.byStatus (and possibly
      // needs-attention) KPIs on the dashboard overview.
      void queryClient.invalidateQueries({ queryKey: ['dashboard-summary'] });
    },
  });
}
