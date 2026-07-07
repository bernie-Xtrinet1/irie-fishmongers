import type { BestVendorResolution, Parish } from '@iriefishmongers/types';

import { apiPost } from '../api-client';

export interface ResolveBestVendorInput {
  productId: string;
  quantity: number;
  deliveryParish: Parish;
}

export function resolveBestVendor(input: ResolveBestVendorInput): Promise<BestVendorResolution> {
  return apiPost<BestVendorResolution>('/marketplace/best-vendor/resolve', input);
}
