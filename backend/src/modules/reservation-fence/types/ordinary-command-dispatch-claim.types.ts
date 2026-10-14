import { OrdinaryPhysicalIdentity } from './ordinary-command-physical.types';

declare const dispatchClaimBrand: unique symbol;

// Opaque process-local proof, never a persisted/restart capability.
export interface OrdinaryDispatchClaim { readonly [dispatchClaimBrand]: true }

export type OrdinaryDispatchClaimResult =
  | { status: 'NOT_AUTHORIZED' }
  | { status: 'FIRST_PHYSICAL_DISPATCH_AUTHORIZED'; claim: OrdinaryDispatchClaim };

export type OrdinaryDispatchIdentity = OrdinaryPhysicalIdentity;

export type OrdinaryPurposePlan = 'EXECUTE_ONLY' | 'GENESIS_THEN_EXECUTE';
declare const mutationCapabilityBrand: unique symbol;
export interface OrdinaryMutationCapability { readonly [mutationCapabilityBrand]: true }
export interface OrdinaryMutationAdmission {
  readonly identity: OrdinaryDispatchIdentity;
  readonly dispatchTransitionId: string;
}
export type OrdinaryMutationClaimResult =
  | { status: 'NOT_AUTHORIZED' }
  | { status: 'FIRST_PHYSICAL_DISPATCH_AUTHORIZED'; claim: OrdinaryMutationCapability };
export type OrdinaryInitializationResult =
  | { code: 'INITIALIZED'; continuation: OrdinaryMutationCapability }
  | { code: 'REJECTED' | 'UNCERTAIN' };
