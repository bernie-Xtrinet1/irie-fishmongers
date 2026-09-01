import { apiGet } from '../api-client';

export const PARISHES = [
  'KINGSTON',
  'ST_ANDREW',
  'ST_CATHERINE',
  'CLARENDON',
  'MANCHESTER',
  'ST_ELIZABETH',
  'HANOVER',
  'WESTMORELAND',
  'ST_JAMES',
  'TRELAWNY',
  'ST_ANN',
  'ST_MARY',
  'PORTLAND',
  'ST_THOMAS',
] as const;

export type Parish = (typeof PARISHES)[number];

export interface ResolvedZoneResponse {
  zoneId: string | null;
}

export function resolveDeliveryZone(
  parish: Parish,
): Promise<ResolvedZoneResponse> {
  return apiGet<ResolvedZoneResponse>(
    `/delivery-zones/resolve?parish=${encodeURIComponent(parish)}`,
  );
}

export function formatParish(parish: Parish): string {
  if (parish === 'KINGSTON') {
    return 'Kingston';
  }

  return parish
    .toLowerCase()
    .split('_')
    .map((word) => {
      if (word === 'st') {
        return 'St.';
      }

      return word.charAt(0).toUpperCase() + word.slice(1);
    })
    .join(' ');
}
