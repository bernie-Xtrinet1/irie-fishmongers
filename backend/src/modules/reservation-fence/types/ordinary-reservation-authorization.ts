import { FenceTuple } from './reservation-fence.types';
import { ResourceAuthority } from './reservation-mutation.types';

// W1-only: never substitutes for a generic mutation permit or checkout grant.
export interface OrdinaryReservationAuthorization {
  version: 1;
  tuple: FenceTuple;
  target: ResourceAuthority;
  from: ResourceAuthority | null;
  quantity: number;
  requestId: string;
  expiresAt: number;
}
