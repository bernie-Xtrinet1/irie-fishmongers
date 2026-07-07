import type { VendorProfile } from '@iriefishmongers/types';

import { apiGet } from '../api-client';

export function fetchVendorProfile(vendorId: string): Promise<VendorProfile> {
  return apiGet<VendorProfile>(`/vendors/${vendorId}/profile`);
}
