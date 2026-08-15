import { Injectable, Logger } from '@nestjs/common';
import { CompensationOperation, ReservationEngineMode } from '@prisma/client';

import { sanitizeErrorMessage } from '../../../common/utils/sanitize-error-message.util';
import { getReservationKeySegmentValidationError } from '../../inventory/constants/inventory.constants';
import { InventoryReservationsService } from '../../inventory/services/inventory-reservations.service';
import { CompensationService, MAX_LAST_ERROR_LENGTH } from '../../mirror-compensation/services/compensation.service';
import { ReservationAvailabilityResult } from '../../reservation-engine-mode/types/reservation-availability.types';
import { ReservationAvailabilityService } from '../../reservation-engine-mode/services/reservation-availability.service';
import { ReservationEngineModeService } from '../../reservation-engine-mode/services/reservation-engine-mode.service';
import {
  MirrorDiagnostic,
  MirrorFailureReasonCode,
  ReleaseCartItemResult,
  ReleaseCartResult,
  ReleaseForCartResult,
  ReservationGateway,
  ReserveForCartResult,
} from '../types/reservation-gateway.types';

interface ValidationFailure {
  field: string;
  reason: string;
}

// Phase 16A.0-C, Unit C3 (see ADR-007 and the approved C3 implementation
// contract). Owns mode-aware write routing only - no Cart/Product/PriceLock
// persistence, no idempotency. Additive and unwired: nothing calls this
// facade yet, and CheckoutReservationModule is not imported by any
// production module.
//
// Phase 16A.0-DA, Unit DA.4: owns recording MIRROR-mode mirror-write
// divergence too (see recordDivergence below) - the facade is the only
// component that actually observes a FAILED MirrorDiagnostic at the
// moment it happens, so it is the natural, non-leaky place to persist it
// (see the DA.4 read-only report's decision 1). Recording is strictly
// best-effort with respect to the customer-facing result: a persistence
// failure is caught, sanitized, and logged at ERROR (never WARN - this is
// a lost repair record, not an ordinary mirror-write failure) and never
// turns a successful LEGACY reservation/release into a failed one.
@Injectable()
export class CheckoutReservationFacade implements ReservationGateway {
  private readonly logger = new Logger(CheckoutReservationFacade.name);

  constructor(
    private readonly modeService: ReservationEngineModeService,
    private readonly inventoryReservations: InventoryReservationsService,
    private readonly availability: ReservationAvailabilityService,
    private readonly compensation: CompensationService,
  ) {}

  async reserveForCart(
    cartId: string,
    productId: string,
    customerId: string,
    desiredQuantity: number,
  ): Promise<ReserveForCartResult> {
    const validationFailure = CheckoutReservationFacade.validateReserveInputs(
      cartId,
      productId,
      customerId,
      desiredQuantity,
    );
    if (validationFailure) {
      return { ok: false, code: 'INVALID_INPUT', ...validationFailure };
    }

    const mode = await this.modeService.getCurrentMode();

    if (mode === 'DRAINING') {
      // Zero InventoryReservationsService calls, no current-quantity read,
      // no partial-decrease exception - see the approved C3 contract.
      return { ok: false, mode: 'DRAINING', code: 'MODE_NOT_ADMITTING' };
    }

    if (mode === 'LEGACY') {
      await this.inventoryReservations.reserve(productId, cartId, desiredQuantity);
      return { ok: true, mode: 'LEGACY', mirror: { status: 'NOT_ATTEMPTED' } };
    }

    if (mode === 'MIRROR') {
      // Legacy is authoritative and unwrapped - a thrown legacy exception
      // propagates untouched, and the mirror write below is never reached,
      // so the customer can never receive a false success.
      await this.inventoryReservations.reserve(productId, cartId, desiredQuantity);
      const mirror = await this.attemptMirrorReserve(cartId, productId, customerId, desiredQuantity);
      return { ok: true, mode: 'MIRROR', mirror };
    }

    // CART_SCOPED
    const outcome = await this.inventoryReservations.reserveOrRenew(
      cartId,
      productId,
      customerId,
      desiredQuantity,
    );
    if (!outcome.ok) {
      return { ok: false, code: outcome.code };
    }
    return { ok: true, mode: 'CART_SCOPED', mirror: { status: 'NOT_ATTEMPTED' } };
  }

  private async attemptMirrorReserve(
    cartId: string,
    productId: string,
    customerId: string,
    desiredQuantity: number,
  ): Promise<MirrorDiagnostic> {
    try {
      const outcome = await this.inventoryReservations.reserveOrRenew(
        cartId,
        productId,
        customerId,
        desiredQuantity,
      );
      if (!outcome.ok) {
        const reasonCode: MirrorFailureReasonCode =
          outcome.code === 'RESERVATION_PRODUCT_SUSPENDED' ? 'PRODUCT_SUSPENDED' : 'CHECKOUT_IN_PROGRESS';
        this.logMirrorFailure(cartId, productId, 'RESERVE', reasonCode);
        await this.recordDivergence('RESERVE_MIRROR', cartId, productId, customerId, desiredQuantity, reasonCode, null);
        return { status: 'FAILED', operation: 'RESERVE', reasonCode };
      }
      if (outcome.result.underflow !== null) {
        this.logMirrorFailure(cartId, productId, 'RESERVE', 'ACCOUNTING_UNDERFLOW');
        await this.recordDivergence(
          'RESERVE_MIRROR',
          cartId,
          productId,
          customerId,
          desiredQuantity,
          'ACCOUNTING_UNDERFLOW',
          null,
        );
        return { status: 'FAILED', operation: 'RESERVE', reasonCode: 'ACCOUNTING_UNDERFLOW' };
      }
      return { status: 'SYNCED' };
    } catch (error) {
      this.logMirrorFailure(cartId, productId, 'RESERVE', 'UNKNOWN_INFRA_FAILURE');
      await this.recordDivergence(
        'RESERVE_MIRROR',
        cartId,
        productId,
        customerId,
        desiredQuantity,
        'UNKNOWN_INFRA_FAILURE',
        CheckoutReservationFacade.errorMessage(error),
      );
      return { status: 'FAILED', operation: 'RESERVE', reasonCode: 'UNKNOWN_INFRA_FAILURE' };
    }
  }

  async releaseForCart(cartId: string, productId: string): Promise<ReleaseForCartResult> {
    const validationFailure = CheckoutReservationFacade.validateReleaseInputs(cartId, productId);
    if (validationFailure) {
      return { ok: false, code: 'INVALID_INPUT', ...validationFailure };
    }

    const mode = await this.modeService.getCurrentMode();
    return this.releaseForCartInMode(mode, cartId, productId);
  }

  // Never queries mode itself - always driven by an already-resolved mode,
  // either releaseForCart's own single read or releaseCart's one snapshot
  // read. This guarantees every item in one releaseCart call uses
  // identical routing semantics even if mode changes mid-operation.
  private async releaseForCartInMode(
    mode: ReservationEngineMode,
    cartId: string,
    productId: string,
  ): Promise<ReleaseForCartResult> {
    if (mode === 'LEGACY') {
      await this.inventoryReservations.release(productId, cartId);
      return { ok: true, mode: 'LEGACY', mirror: { status: 'NOT_ATTEMPTED' } };
    }

    if (mode === 'MIRROR') {
      await this.inventoryReservations.release(productId, cartId);
      const mirror = await this.attemptMirrorRelease(cartId, productId);
      return { ok: true, mode: 'MIRROR', mirror };
    }

    // CART_SCOPED and DRAINING both route identically - cart-scoped only.
    // Full cleanup remains allowed while DRAINING.
    await this.inventoryReservations.releaseReservation(cartId, productId);
    return { ok: true, mode, mirror: { status: 'NOT_ATTEMPTED' } };
  }

  private async attemptMirrorRelease(cartId: string, productId: string): Promise<MirrorDiagnostic> {
    try {
      const result = await this.inventoryReservations.releaseReservation(cartId, productId);
      if (result.underflow !== null) {
        this.logMirrorFailure(cartId, productId, 'RELEASE', 'ACCOUNTING_UNDERFLOW');
        await this.recordDivergence('RELEASE_MIRROR', cartId, productId, null, null, 'ACCOUNTING_UNDERFLOW', null);
        return { status: 'FAILED', operation: 'RELEASE', reasonCode: 'ACCOUNTING_UNDERFLOW' };
      }
      return { status: 'SYNCED' };
    } catch (error) {
      this.logMirrorFailure(cartId, productId, 'RELEASE', 'UNKNOWN_INFRA_FAILURE');
      await this.recordDivergence(
        'RELEASE_MIRROR',
        cartId,
        productId,
        null,
        null,
        'UNKNOWN_INFRA_FAILURE',
        CheckoutReservationFacade.errorMessage(error),
      );
      return { status: 'FAILED', operation: 'RELEASE', reasonCode: 'UNKNOWN_INFRA_FAILURE' };
    }
  }

  // Best-effort persistence of a MIRROR divergence diagnostic - see this
  // class's own DA.4 doc comment. reasonCode is MirrorFailureReasonCode at
  // every call site, passed straight through as CompensationReasonCode:
  // the two enums are documented as structurally identical (same members,
  // same order) in mirror-compensation's own RecordMirrorDivergenceInput
  // comment, specifically so callers holding one can pass it directly
  // without a cast. Never throws; never affects the caller's returned
  // MirrorDiagnostic.
  private async recordDivergence(
    operation: CompensationOperation,
    cartId: string,
    productId: string,
    customerId: string | null,
    desiredQuantity: number | null,
    reasonCode: MirrorFailureReasonCode,
    lastError: string | null,
  ): Promise<void> {
    try {
      const result = await this.compensation.recordMirrorDivergence({
        operation,
        cartId,
        productId,
        customerId,
        desiredQuantity,
        reasonCode,
        lastError,
        now: new Date(),
      });
      if (!result.ok) {
        this.logger.error('Mirror divergence rejected as invalid input - repair record lost', {
          cartId,
          productId,
          operation,
          reasonCode,
          field: result.field,
          reason: result.reason,
        });
      }
    } catch (error) {
      this.logger.error('Failed to persist mirror divergence compensation record - repair record lost, manual investigation required', {
        cartId,
        productId,
        operation,
        reasonCode,
        error: sanitizeErrorMessage(CheckoutReservationFacade.errorMessage(error), MAX_LAST_ERROR_LENGTH),
      });
    }
  }

  private static errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  async releaseCart(cartId: string, productIds: string[]): Promise<ReleaseCartResult> {
    const validationFailure = CheckoutReservationFacade.validateReleaseCartInputs(cartId, productIds);
    if (validationFailure) {
      return { ok: false, code: 'INVALID_INPUT', ...validationFailure };
    }

    const uniqueProductIds = Array.from(new Set(productIds));
    const mode = await this.modeService.getCurrentMode();

    const items: ReleaseCartItemResult[] = [];
    for (const productId of uniqueProductIds) {
      items.push({ productId, result: await this.releaseForCartInMode(mode, cartId, productId) });
    }
    return { ok: true, items };
  }

  async getCartAdmissionAvailability(
    productId: string,
    quantityAvailable: number,
    cartId: string,
  ): Promise<ReservationAvailabilityResult> {
    return this.availability.getCartAdmissionAvailability(productId, quantityAvailable, cartId);
  }

  private logMirrorFailure(
    cartId: string,
    productId: string,
    operation: 'RESERVE' | 'RELEASE',
    reasonCode: MirrorFailureReasonCode,
  ): void {
    this.logger.warn('Mirror operation failed', { cartId, productId, mode: 'MIRROR', operation, reasonCode });
  }

  private static validateReserveInputs(
    cartId: string,
    productId: string,
    customerId: string,
    desiredQuantity: number,
  ): ValidationFailure | null {
    const cartIdError = getReservationKeySegmentValidationError(cartId, 'cartId');
    if (cartIdError) {
      return { field: 'cartId', reason: cartIdError };
    }
    const productIdError = getReservationKeySegmentValidationError(productId, 'productId');
    if (productIdError) {
      return { field: 'productId', reason: productIdError };
    }
    const customerIdError = getReservationKeySegmentValidationError(customerId, 'customerId');
    if (customerIdError) {
      return { field: 'customerId', reason: customerIdError };
    }
    if (!Number.isInteger(desiredQuantity) || desiredQuantity <= 0) {
      return { field: 'desiredQuantity', reason: 'desiredQuantity must be a positive integer' };
    }
    return null;
  }

  private static validateReleaseInputs(cartId: string, productId: string): ValidationFailure | null {
    const cartIdError = getReservationKeySegmentValidationError(cartId, 'cartId');
    if (cartIdError) {
      return { field: 'cartId', reason: cartIdError };
    }
    const productIdError = getReservationKeySegmentValidationError(productId, 'productId');
    if (productIdError) {
      return { field: 'productId', reason: productIdError };
    }
    return null;
  }

  private static validateReleaseCartInputs(
    cartId: string,
    productIds: string[],
  ): ValidationFailure | null {
    const cartIdError = getReservationKeySegmentValidationError(cartId, 'cartId');
    if (cartIdError) {
      return { field: 'cartId', reason: cartIdError };
    }
    if (productIds.length === 0) {
      return { field: 'productIds', reason: 'productIds cannot be empty' };
    }
    for (const productId of productIds) {
      const productIdError = getReservationKeySegmentValidationError(productId, 'productId');
      if (productIdError) {
        return { field: 'productIds', reason: productIdError };
      }
    }
    return null;
  }
}
