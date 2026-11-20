import { FenceTuple } from './reservation-fence.types';
import { ResourceAuthority } from './reservation-mutation.types';
import { OrdinaryBarrierBinding } from './ordinary-invalidation.types';

// Inactive, standalone Redis protocol. Never a generic mutation permit.
export interface OrdinaryPhysicalIdentity {
  version: 1;
  commandId: string;
  replayId: string;
  action: 'W1' | 'CANCEL_W1' | 'RELEASE';
  sequence: number;
  expectedSequence: number;
  mutationVersion: number;
  incarnation: string;
  epoch: number;
  ownerId: string;
  sourceOwnerId: string | null;
  target: ResourceAuthority;
  source: ResourceAuthority | null;
  transition: 'INITIAL' | 'SAME_GENERATION' | 'IMMEDIATE_PREDECESSOR' | null;
  quantity: number | null;
  parent: string | null;
}

export interface OrdinaryPhysicalGrant {
  version: 1;
  grantId: string;
  tuple: FenceTuple;
  identity: string;
  purpose: 'GENESIS' | 'EXECUTE';
  expiresAt: number;
  barrierBinding?: OrdinaryBarrierBinding;
  releasePublication?: { global: string; marker: string; ownershipReceipt: string };
  controlRevision?: number;
}

export type OrdinaryPhysicalResult =
  | { code: 'REJECTED'; reason?: 'RELEASE_AUTHORITY_REJECTED' }
  | { code: 'UNCERTAIN' }
  | { code: 'INITIALIZED' }
  | { code: 'COMPLETED' | 'EXECUTION_WON' | 'CANCELLED'; historical: true;
      identity: string; receipt: string; completionReceiptHash: string };

// Deliberately no TTL on the ledger or its initialization history. No cleanup
// policy, PostgreSQL acknowledgement, or production registration in Stage B.
export const ordinaryPhysicalLedgerKey = (markerId: string) => `reservation:fence:ordinary-command:${markerId}`;
export const ordinaryPhysicalGrantKey = (grantId: string) => `reservation:fence:ordinary-command-grant:${grantId}`;
