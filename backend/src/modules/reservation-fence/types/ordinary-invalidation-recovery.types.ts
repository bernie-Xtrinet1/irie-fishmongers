import { Prisma } from '@prisma/client';
import { InvalidationRequest } from './ordinary-invalidation.types';

export type RecoveryDisposition =
  | 'REPLAYED'
  | 'SUPERSEDED'
  | 'ALREADY_PUBLISHED'
  | 'READY_RECONCILED'
  | 'BLOCKED_MANUAL_REVIEW';

export interface RecoveryResult {
  intentId: string;
  disposition: RecoveryDisposition;
  reason?: string;
  publishedRevision?: number;
  error?: string;
}

export type BootstrapStatus =
  | 'READY'
  | 'ALREADY_READY'
  | 'IN_PROGRESS'
  | 'REJECTED'
  | 'FAILED';

export interface BootstrapResult {
  scope: string;
  markerId: string;
  status: BootstrapStatus;
  revision?: number;
  reason?: string;
  error?: string;
}

export interface SweepResult {
  bootstrappedCount: number;
  reconciledCount: number;
  replayedCount: number;
  readinessCount: number;
  blockedCount: number;
  errors: string[];
}

export interface InvalidationRecoveryHandler {
  readonly kind: 'MODE' | 'FENCE' | 'OWNER' | 'CART';
  readonly subtype?: string;
  validateRequest(request: InvalidationRequest): boolean;
  assertPreconditions(tx: Prisma.TransactionClient, request: InvalidationRequest): Promise<void>;
  execute(tx: Prisma.TransactionClient, request: InvalidationRequest): Promise<Prisma.InputJsonValue>;
}
