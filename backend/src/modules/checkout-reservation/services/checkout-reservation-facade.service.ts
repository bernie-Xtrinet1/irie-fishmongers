import { Injectable, Logger } from '@nestjs/common';
import { ReservationEngineMode } from '@prisma/client';

import { getReservationKeySegmentValidationError } from '../../inventory/constants/inventory.constants';
import { InventoryReservationsService } from '../../inventory/services/inventory-reservations.service';
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
// persistence, no compensation ledger, no idempotency. Additive and
// unwired: nothing calls this facade yet, and CheckoutReservationModule is
// not imported by any production module.
@Injectable()
export class CheckoutReservationFacade implements ReservationGateway {
  private readonly logger = new Logger(CheckoutReservationFacade.name);

  constructor(
    private readonly modeService: ReservationEngineModeService,
    private readonly inventoryReservations: InventoryReservationsService,
    private readonly availability: ReservationAvailabilityService,
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
        return { status: 'FAILED', operation: 'RESERVE', reasonCode };
      }
      if (outcome.result.underflow !== null) {
        this.logMirrorFailure(cartId, productId, 'RESERVE', 'ACCOUNTING_UNDERFLOW');
        return { status: 'FAILED', operation: 'RESERVE', reasonCode: 'ACCOUNTING_UNDERFLOW' };
      }
      return { status: 'SYNCED' };
    } catch {
      this.logMirrorFailure(cartId, productId, 'RESERVE', 'UNKNOWN_INFRA_FAILURE');
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
        return { status: 'FAILED', operation: 'RELEASE', reasonCode: 'ACCOUNTING_UNDERFLOW' };
      }
      return { status: 'SYNCED' };
    } catch {
      this.logMirrorFailure(cartId, productId, 'RELEASE', 'UNKNOWN_INFRA_FAILURE');
      return { status: 'FAILED', operation: 'RELEASE', reasonCode: 'UNKNOWN_INFRA_FAILURE' };
    }
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
