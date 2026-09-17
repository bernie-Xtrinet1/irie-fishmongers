import { CartReservationSyncState, OrdinaryCommandEffect, OrdinaryCommandReason, OrdinaryW1Transition, Prisma } from '@prisma/client';

// Persistence-only inputs. These are NOT mutation permits or physical receipts.
// No c.0a consumer is registered in a production module.
export interface OrdinaryOwnerIssuance {
  markerId: string;
  generation: number;
  cartId: string;
  productId: string;
  customerId: string;
  incarnation: string;
  reservationExecutionEpoch: number;
  issuanceTransitionId: string;
}

export interface OrdinaryCommandPayload {
  ownerId: string;
  sourceOwnerId?: string;
  effect: OrdinaryCommandEffect;
  reason: OrdinaryCommandReason;
  w1Transition?: OrdinaryW1Transition;
  intentGeneration: number;
  expectedMutationVersion: number;
  authorizedQuantity?: number;
  dependsOnCommandId?: string;
  cancelledCommandId?: string;
  checkoutManifestId?: string;
  settlementReceiptHash?: string;
  causeTransitionId?: string;
}

// A future physical protocol must verify execution BEFORE passing this evidence.
// This inert API checks durable identity and receipt structure, not Redis truth.
export interface OrdinaryAcknowledgement {
  commandId: string;
  replayId: string;
  sequence: number;
  expectedSequence: number;
  completionReceiptHash: string;
}

export interface OrdinaryMarkerTransaction {
  tx: Prisma.TransactionClient;
  marker: CartReservationSyncState;
}
