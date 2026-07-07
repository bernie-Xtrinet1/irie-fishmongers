import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import type { VendorProfile } from '@iriefishmongers/types';

import { fetchVendorProfile } from '../api/vendors';

export function useVendorProfile(vendorId: string): UseQueryResult<VendorProfile, Error> {
  return useQuery({
    queryKey: ['vendor-profile', vendorId],
    queryFn: () => fetchVendorProfile(vendorId),
  });
}
