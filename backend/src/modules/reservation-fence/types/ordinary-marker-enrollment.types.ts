import { OrdinaryInvalidationHead } from '@prisma/client';

export type OrdinaryMarkerEnrollmentStatus =
  | 'ENROLLED'
  | 'ALREADY_ENROLLED'
  | 'REJECTED';

export type OrdinaryMarkerEnrollmentRejectionReason =
  | 'MARKER_NOT_FOUND'
  | 'CART_NOT_FOUND'
  | 'FENCE_REJECTED'
  | 'GLOBAL_HEAD_MISSING'
  | 'GLOBAL_HEAD_NOT_READY'
  | 'GLOBAL_INVALIDATION_PENDING'
  | 'GLOBAL_EPOCH_MISMATCH'
  | 'INELIGIBLE_PROVENANCE'
  | 'UNRESOLVED_COMMANDS_EXIST'
  | 'INVALIDATION_HISTORY_EXISTS'
  | 'STALE_MARKER_HEAD';

export type OrdinaryMarkerEnrollmentResult =
  | { status: 'ENROLLED'; head: OrdinaryInvalidationHead }
  | { status: 'ALREADY_ENROLLED'; head: OrdinaryInvalidationHead }
  | { status: 'REJECTED'; reason: OrdinaryMarkerEnrollmentRejectionReason };
