import { Injectable, Logger } from '@nestjs/common';
import { CompensationOperation, CompensationReasonCode, Prisma } from '@prisma/client';

import { sanitizeErrorMessage } from '../../../common/utils/sanitize-error-message.util';
import { getReservationKeySegmentValidationError } from '../../inventory/constants/inventory.constants';
import { CompensationRepository, MAX_OPTIMISTIC_RETRIES } from '../repositories/compensation.repository';
import { RecordMirrorDivergenceInput, RecordMirrorDivergenceResult } from '../types/compensation-service.types';

const MAX_LAST_ERROR_LENGTH = 500;

// Runtime membership checks, not just TypeScript typing - input crossing
// a service boundary is never trusted to actually be a valid enum member
// merely because it is typed as one, matching this codebase's general
// boundary-validation discipline.
const VALID_OPERATIONS: ReadonlySet<string> = new Set<CompensationOperation>([
  'RESERVE_MIRROR',
  'RELEASE_MIRROR',
]);
const VALID_REASON_CODES: ReadonlySet<string> = new Set<CompensationReasonCode>([
  'PRODUCT_SUSPENDED',
  'CHECKOUT_IN_PROGRESS',
  'ACCOUNTING_UNDERFLOW',
  'UNKNOWN_INFRA_FAILURE',
]);

interface ValidationFailure {
  field: string;
  reason: string;
}

// Phase 16A.0-C4.2 (see ADR-007). Owns durable creation/recording of
// MIRROR divergence only - no desired-state recovery (C4.3), no batch
// orchestration (C4.4), no scheduling (C4.5). Additive and unwired:
// nothing outside this unit's own tests calls recordMirrorDivergence yet,
// and MirrorCompensationModule is not imported by any production module.
@Injectable()
export class CompensationService {
  private readonly logger = new Logger(CompensationService.name);

  constructor(private readonly repository: CompensationRepository) {}

  async recordMirrorDivergence(
    input: RecordMirrorDivergenceInput,
  ): Promise<RecordMirrorDivergenceResult> {
    const validationFailure = CompensationService.validateInput(input);
    if (validationFailure) {
      return { ok: false, code: 'INVALID_INPUT', ...validationFailure };
    }

    const sanitizedLastError = sanitizeErrorMessage(input.lastError, MAX_LAST_ERROR_LENGTH);

    for (let attempt = 1; attempt <= MAX_OPTIMISTIC_RETRIES; attempt += 1) {
      const created = await this.tryCreate(input, sanitizedLastError);
      if (created) {
        this.logOutcome('CREATED', created.id, input);
        return { ok: true, outcome: 'CREATED', compensationId: created.id };
      }

      // create() hit the partial unique index (P2002) - a still-unresolved
      // row already exists for this (cartId, productId) pair.
      const existing = await this.repository.findUnresolvedByCartAndProduct(input.cartId, input.productId);
      if (!existing) {
        // Resolved between our failed create and this read - retry create.
        continue;
      }

      const updateInput = {
        operation: input.operation,
        customerId: input.customerId,
        desiredQuantity: input.desiredQuantity,
        reasonCode: input.reasonCode,
        lastError: sanitizedLastError,
        now: input.now,
      };
      const unblock = existing.status === 'BLOCKED' && input.reasonCode !== 'ACCOUNTING_UNDERFLOW';
      const { count } = unblock
        ? await this.repository.advanceGenerationAndUnblock(existing.id, updateInput)
        : await this.repository.advanceGenerationPreservingStatus(existing.id, updateInput);

      if (count === 0) {
        // The row resolved between our read and this write - retry create.
        continue;
      }

      this.logOutcome('GENERATION_ADVANCED', existing.id, input);
      return { ok: true, outcome: 'GENERATION_ADVANCED', compensationId: existing.id };
    }

    throw new Error(
      `Internal consistency error: recordMirrorDivergence exhausted ${MAX_OPTIMISTIC_RETRIES} ` +
        `attempts for cartId=${input.cartId} productId=${input.productId} without durable unresolved work`,
    );
  }

  private async tryCreate(
    input: RecordMirrorDivergenceInput,
    sanitizedLastError: string | null,
  ): Promise<{ id: string } | null> {
    try {
      return await this.repository.create({
        operation: input.operation,
        cartId: input.cartId,
        productId: input.productId,
        customerId: input.customerId,
        desiredQuantity: input.desiredQuantity,
        reasonCode: input.reasonCode,
        lastError: sanitizedLastError,
      });
    } catch (error) {
      if (CompensationService.isUniqueConstraintViolation(error)) {
        return null;
      }
      throw error;
    }
  }

  // This table has exactly one possible P2002 source - the partial
  // unique index on (cartId, productId) for unresolved rows (the primary
  // key is server-generated via uuid() and not a realistic collision
  // source) - so no meta.target discrimination is needed, unlike
  // CheckoutAttemptRepository's idempotencyKey check, which must
  // distinguish between multiple possible unique constraints.
  private static isUniqueConstraintViolation(error: unknown): boolean {
    return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
  }

  private logOutcome(
    outcome: 'CREATED' | 'GENERATION_ADVANCED',
    compensationId: string,
    input: RecordMirrorDivergenceInput,
  ): void {
    const logLine = {
      compensationId,
      cartId: input.cartId,
      productId: input.productId,
      operation: input.operation,
      reasonCode: input.reasonCode,
      outcome,
    };
    if (outcome === 'CREATED') {
      this.logger.log('Mirror divergence recorded', logLine);
    } else {
      this.logger.warn('Mirror divergence recurred against an unresolved row', logLine);
    }
  }

  private static validateInput(input: RecordMirrorDivergenceInput): ValidationFailure | null {
    if (!VALID_OPERATIONS.has(input.operation)) {
      return { field: 'operation', reason: 'operation must be RESERVE_MIRROR or RELEASE_MIRROR' };
    }
    if (!VALID_REASON_CODES.has(input.reasonCode)) {
      return {
        field: 'reasonCode',
        reason:
          'reasonCode must be one of PRODUCT_SUSPENDED, CHECKOUT_IN_PROGRESS, ACCOUNTING_UNDERFLOW, UNKNOWN_INFRA_FAILURE',
      };
    }

    const cartIdError = getReservationKeySegmentValidationError(input.cartId, 'cartId');
    if (cartIdError) {
      return { field: 'cartId', reason: cartIdError };
    }
    const productIdError = getReservationKeySegmentValidationError(input.productId, 'productId');
    if (productIdError) {
      return { field: 'productId', reason: productIdError };
    }

    if (input.operation === 'RESERVE_MIRROR') {
      if (input.customerId === null) {
        return { field: 'customerId', reason: 'customerId is required for RESERVE_MIRROR' };
      }
      const customerIdError = getReservationKeySegmentValidationError(input.customerId, 'customerId');
      if (customerIdError) {
        return { field: 'customerId', reason: customerIdError };
      }
      if (
        input.desiredQuantity === null ||
        !Number.isInteger(input.desiredQuantity) ||
        input.desiredQuantity <= 0
      ) {
        return {
          field: 'desiredQuantity',
          reason: 'desiredQuantity must be a positive integer for RESERVE_MIRROR',
        };
      }
    } else {
      // RELEASE_MIRROR
      if (input.customerId !== null) {
        return { field: 'customerId', reason: 'customerId must be null for RELEASE_MIRROR' };
      }
      if (input.desiredQuantity !== null) {
        return { field: 'desiredQuantity', reason: 'desiredQuantity must be null for RELEASE_MIRROR' };
      }
    }

    if (!(input.now instanceof Date) || Number.isNaN(input.now.getTime())) {
      return { field: 'now', reason: 'now must be a valid Date' };
    }

    return null;
  }
}
