import { Injectable } from '@nestjs/common';

import { getReservationKeySegmentValidationError } from '../../inventory/constants/inventory.constants';
import { InventoryReservationsService } from '../../inventory/services/inventory-reservations.service';
import {
  MirrorComparison,
  ReservationAvailabilityResult,
} from '../types/reservation-availability.types';
import { ReservationEngineModeService } from './reservation-engine-mode.service';

interface InputValidationFailure {
  field: string;
  reason: string;
}

// Phase 16A.0-C, Unit C2 (see ADR-007, "final authority matrix"). Owns
// mode-aware availability computation only - read-only, no reservation
// writes anywhere in this file. Additive and unwired: nothing calls
// getGeneralAvailability/getCartAdmissionAvailability yet, and
// CartService/ProductsService remain untouched. C3's future
// CheckoutReservationFacade is expected to delegate its own availability
// method to this service rather than duplicating this logic.
@Injectable()
export class ReservationAvailabilityService {
  constructor(
    private readonly modeService: ReservationEngineModeService,
    private readonly inventoryReservations: InventoryReservationsService,
  ) {}

  // No cart context: general product-browsing availability (e.g.
  // ProductsService's future use) - never performs an own-cart add-back.
  async getGeneralAvailability(
    productId: string,
    quantityAvailable: number,
  ): Promise<ReservationAvailabilityResult> {
    return this.computeAvailability(productId, quantityAvailable, null);
  }

  // Cart context required: cart-admission availability (e.g. CartService's
  // future use) - applies the requesting cart's own-cart add-back per mode.
  async getCartAdmissionAvailability(
    productId: string,
    quantityAvailable: number,
    cartId: string,
  ): Promise<ReservationAvailabilityResult> {
    return this.computeAvailability(productId, quantityAvailable, cartId);
  }

  private async computeAvailability(
    productId: string,
    quantityAvailable: number,
    excludingCartId: string | null,
  ): Promise<ReservationAvailabilityResult> {
    const validationFailure = ReservationAvailabilityService.validateInput(
      productId,
      quantityAvailable,
      excludingCartId,
    );
    if (validationFailure) {
      return { ok: false, code: 'INVALID_INPUT', ...validationFailure };
    }

    const mode = await this.modeService.getCurrentMode();

    // DRAINING short-circuits before any other call - zero reads of
    // InventoryReservationsService, never a numeric zero (see ADR-007
    // Decision 8 as corrected during this unit). Every future reservation-
    // admission entry point built on top of this (C3's
    // CheckoutReservationFacade, and eventually CartService/ProductsService
    // once wired) must preserve this same ordering.
    if (mode === 'DRAINING') {
      return { ok: false, mode: 'DRAINING', code: 'MODE_NOT_ADMITTING' };
    }

    // No magic empty-string cart sentinel at this service's public surface
    // (getGeneralAvailability/getCartAdmissionAvailability) - null is
    // mapped to the legacy/new-engine methods' own pre-existing empty-
    // string "exclude nothing" convention only here, at the internal
    // boundary to those methods.
    const legacyExcludingCartId = excludingCartId ?? '';

    if (mode === 'LEGACY') {
      const available = await this.legacyAvailable(productId, quantityAvailable, legacyExcludingCartId);
      return { ok: true, mode: 'LEGACY', source: 'LEGACY', available };
    }

    if (mode === 'MIRROR') {
      const available = await this.legacyAvailable(productId, quantityAvailable, legacyExcludingCartId);
      const mirrorComparison = await this.computeMirrorComparison(
        productId,
        quantityAvailable,
        legacyExcludingCartId,
      );
      return { ok: true, mode: 'MIRROR', source: 'LEGACY', available, mirrorComparison };
    }

    // CART_SCOPED: new engine only, never legacy.
    const result = await this.inventoryReservations.getAvailabilityWithSuspectStatus(
      productId,
      quantityAvailable,
      legacyExcludingCartId,
    );
    if (result.status === 'SUSPECT') {
      return { ok: false, code: 'RESERVATION_STRUCTURE_DRIFT' };
    }
    return { ok: true, mode: 'CART_SCOPED', source: 'CART_SCOPED', available: result.available };
  }

  private async legacyAvailable(
    productId: string,
    quantityAvailable: number,
    excludingCartId: string,
  ): Promise<number> {
    const reservedByOthers = await this.inventoryReservations.getReservedByOthers(
      productId,
      excludingCartId,
    );
    return Math.max(0, quantityAvailable - reservedByOthers);
  }

  // MIRROR's comparison path is strictly diagnostic - its outcome must
  // never alter or block the real, legacy-derived `available` value
  // computed above, and a failure here must never propagate out and abort
  // the whole request. A thrown error (infrastructure hiccup) is
  // deliberately never conflated with a confirmed suspect-flag finding -
  // see MirrorComparison's own documentation.
  private async computeMirrorComparison(
    productId: string,
    quantityAvailable: number,
    excludingCartId: string,
  ): Promise<MirrorComparison> {
    try {
      const result = await this.inventoryReservations.getAvailabilityWithSuspectStatus(
        productId,
        quantityAvailable,
        excludingCartId,
      );
      if (result.status === 'SUSPECT') {
        return { status: 'STRUCTURE_DRIFT_CONFIRMED' };
      }
      return { status: 'AVAILABLE', available: result.available };
    } catch {
      return { status: 'COMPARISON_UNAVAILABLE' };
    }
  }

  private static validateInput(
    productId: string,
    quantityAvailable: number,
    excludingCartId: string | null,
  ): InputValidationFailure | null {
    const productIdError = getReservationKeySegmentValidationError(productId, 'productId');
    if (productIdError) {
      return { field: 'productId', reason: productIdError };
    }

    if (excludingCartId !== null) {
      const cartIdError = getReservationKeySegmentValidationError(excludingCartId, 'cartId');
      if (cartIdError) {
        return { field: 'cartId', reason: cartIdError };
      }
    }

    if (!Number.isInteger(quantityAvailable) || quantityAvailable < 0) {
      return {
        field: 'quantityAvailable',
        reason: 'quantityAvailable must be a non-negative integer',
      };
    }

    return null;
  }
}
