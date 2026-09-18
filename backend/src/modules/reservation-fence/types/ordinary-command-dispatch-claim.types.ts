import { OrdinaryPhysicalIdentity } from './ordinary-command-physical.types';

declare const dispatchClaimBrand: unique symbol;

// Opaque process-local proof, never a persisted/restart capability.
export interface OrdinaryDispatchClaim { readonly [dispatchClaimBrand]: true }

export type OrdinaryDispatchClaimResult =
  | { status: 'NOT_AUTHORIZED' }
  | { status: 'FIRST_PHYSICAL_DISPATCH_AUTHORIZED'; claim: OrdinaryDispatchClaim };

export type OrdinaryDispatchIdentity = OrdinaryPhysicalIdentity;
