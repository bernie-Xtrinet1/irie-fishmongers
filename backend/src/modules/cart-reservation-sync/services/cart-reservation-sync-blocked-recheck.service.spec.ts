import { uncertainObservation } from '../../inventory/types/reservation-observation.types';
import { CartReservationSyncState } from '@prisma/client';

import { CartRepository } from '../../cart/repositories/cart.repository';
import { InventoryReservationsService } from '../../inventory/services/inventory-reservations.service';
import { ReservationEngineModeService } from '../../reservation-engine-mode/services/reservation-engine-mode.service';
import { CartReservationSyncStateRepository } from '../repositories/cart-reservation-sync-state.repository';
import { CartReservationSyncBlockedRecheckService } from './cart-reservation-sync-blocked-recheck.service';

// Phase 16A.0-DA, Unit DA.4B (see the DA.4B frozen plan). A BLOCKED row is
// never a queued command - desired state is always re-read fresh from the
// current CartItem first, never replayed from the reason that originally
// caused the block. Mirrors CompensationBlockedRecheckService's own proven
// unit-test shape.
function buildBlockedMarker(overrides: Partial<CartReservationSyncState> = {}): CartReservationSyncState {
  return {
    id: 'marker-1',
    cartId: 'cart-1',
    productId: 'product-1',
    expectedMutationVersion: 0,
    expectedQuantity: 5,
    status: 'BLOCKED',
    blockReason: 'PRODUCT_SUSPECT',
    nextAttemptAt: new Date('2026-01-01T00:01:00.000Z'),
    ordinaryProvenanceState: 'HISTORICAL_UNVERIFIED',
    ordinaryEnqueueSequence: 0,
    ordinaryCommandSequence: 0,
    ordinaryAcknowledgedSequence: 0,
    generation: 3,
    attemptCount: 1,
    lastError: null,
    processingStartedAt: null,
    resolvedAt: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

describe('CartReservationSyncBlockedRecheckService', () => {
  let syncState: jest.Mocked<
    Pick<
      CartReservationSyncStateRepository,
      'findById' | 'unblockIfGenerationMatches' | 'rescheduleBlockedCheckIfGenerationMatches'
    >
  >;
  let cartRepository: jest.Mocked<Pick<CartRepository, 'findItemByCartAndProduct'>>;
  let inventoryReservations: jest.Mocked<Pick<InventoryReservationsService, 'observeProductReservations'>>;
  let modeService: jest.Mocked<Pick<ReservationEngineModeService, 'getCurrentMode'>>;
  let service: CartReservationSyncBlockedRecheckService;

  beforeEach(() => {
    syncState = {
      findById: jest.fn(),
      unblockIfGenerationMatches: jest.fn(),
      rescheduleBlockedCheckIfGenerationMatches: jest.fn(),
    };
    cartRepository = { findItemByCartAndProduct: jest.fn() };
    inventoryReservations = { observeProductReservations: jest.fn() };
    modeService = { getCurrentMode: jest.fn() };
    service = new CartReservationSyncBlockedRecheckService(
      syncState as unknown as CartReservationSyncStateRepository,
      cartRepository as unknown as CartRepository,
      inventoryReservations as unknown as InventoryReservationsService,
      modeService as unknown as ReservationEngineModeService,
    );
  });

  it('returns NOT_FOUND when no row exists', async () => {
    syncState.findById.mockResolvedValue(null);

    await expect(service.recheckBlocked('marker-1', new Date())).resolves.toEqual({
      outcome: 'NOT_FOUND',
      markerId: 'marker-1',
    });
  });

  it('returns ALREADY_RESOLVED when resolvedAt is already set', async () => {
    syncState.findById.mockResolvedValue(buildBlockedMarker({ resolvedAt: new Date() }));

    await expect(service.recheckBlocked('marker-1', new Date())).resolves.toEqual({
      outcome: 'ALREADY_RESOLVED',
      markerId: 'marker-1',
    });
  });

  it('returns NOT_DUE when the row is not currently BLOCKED', async () => {
    syncState.findById.mockResolvedValue(buildBlockedMarker({ status: 'PENDING', blockReason: null }));

    await expect(service.recheckBlocked('marker-1', new Date())).resolves.toEqual({
      outcome: 'NOT_DUE',
      markerId: 'marker-1',
    });
  });

  it('preserves BLOCKED(PRODUCT_SUSPECT) even when the CartItem has disappeared', async () => {
    syncState.findById.mockResolvedValue(buildBlockedMarker());
    cartRepository.findItemByCartAndProduct.mockResolvedValue(null);
    syncState.rescheduleBlockedCheckIfGenerationMatches.mockResolvedValue({ count: 1 });

    const outcome = await service.recheckBlocked('marker-1', new Date());

    expect(syncState.unblockIfGenerationMatches).not.toHaveBeenCalled();
    expect(inventoryReservations.observeProductReservations).toHaveBeenCalledWith('product-1', ['cart-1']);
    expect(modeService.getCurrentMode).not.toHaveBeenCalled();
    expect(outcome).toEqual({ outcome: 'BLOCKED_PRODUCT_SUSPECT', markerId: 'marker-1' });
  });

  it('unblocks MODE_NOT_ADMITTING when the CartItem has disappeared', async () => {
    syncState.findById.mockResolvedValue(buildBlockedMarker({ blockReason: 'MODE_NOT_ADMITTING' }));
    cartRepository.findItemByCartAndProduct.mockResolvedValue(null);
    syncState.unblockIfGenerationMatches.mockResolvedValue({ count: 1 });

    const outcome = await service.recheckBlocked('marker-1', new Date());

    expect(syncState.unblockIfGenerationMatches).toHaveBeenCalledWith('marker-1', 3);
    expect(inventoryReservations.observeProductReservations).not.toHaveBeenCalled();
    expect(modeService.getCurrentMode).not.toHaveBeenCalled();
    expect(outcome).toEqual({ outcome: 'UNBLOCKED_PENDING', markerId: 'marker-1' });
  });

  describe('MODE_NOT_ADMITTING', () => {
    it('reschedules while still DRAINING', async () => {
      syncState.findById.mockResolvedValue(buildBlockedMarker({ blockReason: 'MODE_NOT_ADMITTING' }));
      cartRepository.findItemByCartAndProduct.mockResolvedValue({
        id: 'item-1',
        cartId: 'cart-1',
        productId: 'product-1',
        quantity: 4,
        mutationVersion: 1,
      } as never);
      modeService.getCurrentMode.mockResolvedValue('DRAINING');
      syncState.rescheduleBlockedCheckIfGenerationMatches.mockResolvedValue({ count: 1 });

      const outcome = await service.recheckBlocked('marker-1', new Date());

      expect(syncState.rescheduleBlockedCheckIfGenerationMatches).toHaveBeenCalledWith(
        'marker-1',
        3,
        expect.any(Date),
      );
      expect(outcome).toEqual({ outcome: 'BLOCKED_MODE_NOT_ADMITTING', markerId: 'marker-1' });
    });

    it('unblocks once mode has left DRAINING', async () => {
      syncState.findById.mockResolvedValue(buildBlockedMarker({ blockReason: 'MODE_NOT_ADMITTING' }));
      cartRepository.findItemByCartAndProduct.mockResolvedValue({
        id: 'item-1',
        cartId: 'cart-1',
        productId: 'product-1',
        quantity: 4,
        mutationVersion: 1,
      } as never);
      modeService.getCurrentMode.mockResolvedValue('CART_SCOPED');
      syncState.unblockIfGenerationMatches.mockResolvedValue({ count: 1 });

      const outcome = await service.recheckBlocked('marker-1', new Date());

      expect(outcome).toEqual({ outcome: 'UNBLOCKED_PENDING', markerId: 'marker-1' });
    });
  });

  describe('PRODUCT_SUSPECT', () => {
    it('reschedules while accounting remains suspended', async () => {
      syncState.findById.mockResolvedValue(buildBlockedMarker({ blockReason: 'PRODUCT_SUSPECT' }));
      cartRepository.findItemByCartAndProduct.mockResolvedValue({
        id: 'item-1',
        cartId: 'cart-1',
        productId: 'product-1',
        quantity: 4,
        mutationVersion: 1,
      } as never);
      inventoryReservations.observeProductReservations.mockResolvedValue(uncertainObservation());
      syncState.rescheduleBlockedCheckIfGenerationMatches.mockResolvedValue({ count: 1 });

      const outcome = await service.recheckBlocked('marker-1', new Date());

      expect(outcome).toEqual({ outcome: 'BLOCKED_PRODUCT_SUSPECT', markerId: 'marker-1' });
    });

    it.each(['CONSISTENT', 'ABSENT', 'PREPARED', 'ENFORCED', 'INFRASTRUCTURE_UNCERTAIN'] as const)('keeps PRODUCT_SUSPECT blocked after %s observation', async (finding) => {
      syncState.findById.mockResolvedValue(buildBlockedMarker({ blockReason: 'PRODUCT_SUSPECT' }));
      cartRepository.findItemByCartAndProduct.mockResolvedValue({
        id: 'item-1',
        cartId: 'cart-1',
        productId: 'product-1',
        quantity: 4,
        mutationVersion: 1,
      } as never);
      inventoryReservations.observeProductReservations.mockResolvedValue({ ...uncertainObservation(), findings: finding === 'CONSISTENT' ? ['CONSISTENT'] : ['INFRASTRUCTURE_UNCERTAIN'], restriction: { ...uncertainObservation().restriction, durableState: finding === 'ABSENT' || finding === 'PREPARED' || finding === 'ENFORCED' ? finding : 'UNKNOWN' } });
      syncState.rescheduleBlockedCheckIfGenerationMatches.mockResolvedValue({ count: 1 });

      const outcome = await service.recheckBlocked('marker-1', new Date());

      expect(outcome).toEqual({ outcome: 'BLOCKED_PRODUCT_SUSPECT', markerId: 'marker-1' });
      expect(syncState.unblockIfGenerationMatches).not.toHaveBeenCalled();
      expect(inventoryReservations.observeProductReservations).toHaveBeenCalledWith('product-1', ['cart-1']);
    });
  });

  it('reports STALE_BLOCKED_CHECK when the generation-fenced unblock misses (customer mutation superseded)', async () => {
    syncState.findById.mockResolvedValue(buildBlockedMarker({ blockReason: 'MODE_NOT_ADMITTING' }));
    cartRepository.findItemByCartAndProduct.mockResolvedValue(null);
    syncState.unblockIfGenerationMatches.mockResolvedValue({ count: 0 });

    const outcome = await service.recheckBlocked('marker-1', new Date());

    expect(outcome).toEqual({ outcome: 'STALE_BLOCKED_CHECK', markerId: 'marker-1' });
  });

  it('reports STALE_BLOCKED_CHECK when the generation-fenced reschedule misses', async () => {
    syncState.findById.mockResolvedValue(buildBlockedMarker({ blockReason: 'PRODUCT_SUSPECT' }));
    cartRepository.findItemByCartAndProduct.mockResolvedValue({
      id: 'item-1',
      cartId: 'cart-1',
      productId: 'product-1',
      quantity: 4,
      mutationVersion: 1,
    } as never);
    inventoryReservations.observeProductReservations.mockResolvedValue(uncertainObservation());
    syncState.rescheduleBlockedCheckIfGenerationMatches.mockResolvedValue({ count: 0 });

    const outcome = await service.recheckBlocked('marker-1', new Date());

    expect(outcome).toEqual({ outcome: 'STALE_BLOCKED_CHECK', markerId: 'marker-1' });
  });
});
