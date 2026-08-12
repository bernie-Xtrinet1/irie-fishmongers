import { CartItemAddAttempt } from '@prisma/client';

import { CartItemAddAttemptRepository } from '../repositories/cart-item-add-attempt.repository';
import { CART_ITEM_ADD_ATTEMPT_STALE_TIMEOUT_MS, CartItemAddIdempotencyService } from './cart-item-add-idempotency.service';

// Phase 16A.0-DA, Unit DA.2 (see the DA.2 design review). Covers the
// classify state machine in isolation: NEW/CONFLICT/COMPLETED replay/
// REJECTED replay/ALREADY_PROCESSING/stale-reclaim, plus reject/complete
// pass-through. Real-Postgres proof of the fenced transitions themselves
// lives in cart-item-add-idempotency.integration.spec.ts.
describe('CartItemAddIdempotencyService', () => {
  let repository: jest.Mocked<
    Pick<
      CartItemAddAttemptRepository,
      'createOrGetByIdempotencyKey' | 'reclaimIfStale' | 'findById' | 'rejectIfCurrentAttempt' | 'completeIfCurrentAttempt'
    >
  >;
  let service: CartItemAddIdempotencyService;
  const now = new Date('2026-01-01T00:00:00.000Z');

  function buildAttempt(overrides: Partial<CartItemAddAttempt> = {}): CartItemAddAttempt {
    return {
      id: 'attempt-1',
      idempotencyKey: 'key-1',
      customerId: 'user-1',
      cartId: 'cart-1',
      productId: 'product-1',
      requestedQuantity: 2,
      status: 'PROCESSING',
      attemptCount: 1,
      rejectionCode: null,
      rejectionMessage: null,
      resultCartItemId: null,
      resultQuantity: null,
      resultMutationVersion: null,
      resultGeneration: null,
      createdAt: now,
      updatedAt: now,
      ...overrides,
    };
  }

  beforeEach(() => {
    repository = {
      createOrGetByIdempotencyKey: jest.fn(),
      reclaimIfStale: jest.fn(),
      findById: jest.fn(),
      rejectIfCurrentAttempt: jest.fn(),
      completeIfCurrentAttempt: jest.fn(),
    };
    service = new CartItemAddIdempotencyService(repository as unknown as CartItemAddAttemptRepository);
  });

  const input = {
    customerId: 'user-1',
    idempotencyKey: 'key-1',
    cartId: 'cart-1',
    productId: 'product-1',
    requestedQuantity: 2,
    now,
  };

  describe('classify', () => {
    it('a new key creates the row and returns EXECUTE at attemptCount 1', async () => {
      repository.createOrGetByIdempotencyKey.mockResolvedValue({ attempt: buildAttempt(), created: true });

      const result = await service.classify(input);

      expect(repository.createOrGetByIdempotencyKey).toHaveBeenCalledWith({
        idempotencyKey: 'key-1',
        customerId: 'user-1',
        cartId: 'cart-1',
        productId: 'product-1',
        requestedQuantity: 2,
        now,
      });
      expect(result).toEqual({ outcome: 'EXECUTE', attemptId: 'attempt-1', attemptCount: 1 });
    });

    it('an existing row with a different productId is a conflict regardless of status', async () => {
      repository.createOrGetByIdempotencyKey.mockResolvedValue({
        attempt: buildAttempt({ productId: 'product-2', status: 'COMPLETED' }),
        created: false,
      });

      const result = await service.classify(input);

      expect(result).toEqual({ outcome: 'IDEMPOTENCY_KEY_CONFLICT' });
    });

    it('an existing row with a different requestedQuantity is a conflict regardless of status', async () => {
      repository.createOrGetByIdempotencyKey.mockResolvedValue({
        attempt: buildAttempt({ requestedQuantity: 99, status: 'COMPLETED' }),
        created: false,
      });

      const result = await service.classify(input);

      expect(result).toEqual({ outcome: 'IDEMPOTENCY_KEY_CONFLICT' });
    });

    it('a COMPLETED row with a matching fingerprint replays the stored result and never touches the repository further', async () => {
      repository.createOrGetByIdempotencyKey.mockResolvedValue({
        attempt: buildAttempt({
          status: 'COMPLETED',
          resultCartItemId: 'item-1',
          resultQuantity: 5,
          resultMutationVersion: 2,
          resultGeneration: 7,
        }),
        created: false,
      });

      const result = await service.classify(input);

      expect(result).toEqual({
        outcome: 'COMPLETED_REPLAY',
        result: { cartItemId: 'item-1', quantity: 5, mutationVersion: 2, generation: 7 },
      });
      expect(repository.reclaimIfStale).not.toHaveBeenCalled();
    });

    it('a REJECTED row with a matching fingerprint replays the stored rejection', async () => {
      repository.createOrGetByIdempotencyKey.mockResolvedValue({
        attempt: buildAttempt({
          status: 'REJECTED',
          rejectionCode: 'QUANTITY_NOT_AVAILABLE',
          rejectionMessage: 'Only 1 unit(s) of this product are currently available',
        }),
        created: false,
      });

      const result = await service.classify(input);

      expect(result).toEqual({
        outcome: 'REJECTED_REPLAY',
        rejectionCode: 'QUANTITY_NOT_AVAILABLE',
        rejectionMessage: 'Only 1 unit(s) of this product are currently available',
      });
    });

    it('a PROCESSING row updated within the staleness window is ALREADY_PROCESSING', async () => {
      const recentlyTouched = new Date(now.getTime() - 1000); // 1s ago, well inside the 15s window
      repository.createOrGetByIdempotencyKey.mockResolvedValue({
        attempt: buildAttempt({ status: 'PROCESSING', updatedAt: recentlyTouched }),
        created: false,
      });

      const result = await service.classify(input);

      expect(result).toEqual({ outcome: 'ALREADY_PROCESSING' });
      expect(repository.reclaimIfStale).not.toHaveBeenCalled();
    });

    it('a PROCESSING row exactly at the staleness boundary is not yet stale (strict greater-than)', async () => {
      const atCutoff = new Date(now.getTime() - CART_ITEM_ADD_ATTEMPT_STALE_TIMEOUT_MS);
      repository.createOrGetByIdempotencyKey.mockResolvedValue({
        attempt: buildAttempt({ status: 'PROCESSING', updatedAt: atCutoff }),
        created: false,
      });
      repository.reclaimIfStale.mockResolvedValue({ count: 1 });

      await service.classify(input);

      // updatedAt === staleCutoff is not > staleCutoff, so this attempts a
      // reclaim rather than reporting ALREADY_PROCESSING.
      expect(repository.reclaimIfStale).toHaveBeenCalledWith('attempt-1', 1, atCutoff, now);
    });

    it('a stale PROCESSING row is reclaimed and returns EXECUTE at attemptCount + 1', async () => {
      const stale = new Date(now.getTime() - CART_ITEM_ADD_ATTEMPT_STALE_TIMEOUT_MS - 1000);
      repository.createOrGetByIdempotencyKey.mockResolvedValue({
        attempt: buildAttempt({ status: 'PROCESSING', updatedAt: stale, attemptCount: 3 }),
        created: false,
      });
      repository.reclaimIfStale.mockResolvedValue({ count: 1 });

      const result = await service.classify(input);

      const expectedCutoff = new Date(now.getTime() - CART_ITEM_ADD_ATTEMPT_STALE_TIMEOUT_MS);
      expect(repository.reclaimIfStale).toHaveBeenCalledWith('attempt-1', 3, expectedCutoff, now);
      expect(result).toEqual({ outcome: 'EXECUTE', attemptId: 'attempt-1', attemptCount: 4 });
    });

    it('a lost reclaim race re-reads the row and reclassifies against its current state', async () => {
      const stale = new Date(now.getTime() - CART_ITEM_ADD_ATTEMPT_STALE_TIMEOUT_MS - 1000);
      repository.createOrGetByIdempotencyKey.mockResolvedValue({
        attempt: buildAttempt({ status: 'PROCESSING', updatedAt: stale, attemptCount: 1 }),
        created: false,
      });
      repository.reclaimIfStale.mockResolvedValue({ count: 0 }); // a concurrent reclaimer won
      repository.findById.mockResolvedValue(
        buildAttempt({
          status: 'COMPLETED',
          attemptCount: 2,
          resultCartItemId: 'item-1',
          resultQuantity: 5,
          resultMutationVersion: 1,
          resultGeneration: 3,
        }),
      );

      const result = await service.classify(input);

      expect(repository.findById).toHaveBeenCalledWith('attempt-1');
      expect(result).toEqual({
        outcome: 'COMPLETED_REPLAY',
        result: { cartItemId: 'item-1', quantity: 5, mutationVersion: 1, generation: 3 },
      });
    });

    it('repeatedly losing the reclaim race is bounded, reporting ALREADY_PROCESSING rather than looping unboundedly', async () => {
      const stale = new Date(now.getTime() - CART_ITEM_ADD_ATTEMPT_STALE_TIMEOUT_MS - 1000);
      repository.createOrGetByIdempotencyKey.mockResolvedValue({
        attempt: buildAttempt({ status: 'PROCESSING', updatedAt: stale, attemptCount: 1 }),
        created: false,
      });
      repository.reclaimIfStale.mockResolvedValue({ count: 0 });
      repository.findById.mockResolvedValue(buildAttempt({ status: 'PROCESSING', updatedAt: stale, attemptCount: 1 }));

      const result = await service.classify(input);

      expect(result).toEqual({ outcome: 'ALREADY_PROCESSING' });
      // 1 initial attempt + 3 bounded retries = 3 reclaim calls total (the
      // 3rd retry's own stale check short-circuits before a 4th reclaim).
      expect(repository.reclaimIfStale).toHaveBeenCalledTimes(3);
    });

    it('throws an internal consistency error if the row vanishes mid-reclaim (rows are never deleted in production)', async () => {
      const stale = new Date(now.getTime() - CART_ITEM_ADD_ATTEMPT_STALE_TIMEOUT_MS - 1000);
      repository.createOrGetByIdempotencyKey.mockResolvedValue({
        attempt: buildAttempt({ status: 'PROCESSING', updatedAt: stale }),
        created: false,
      });
      repository.reclaimIfStale.mockResolvedValue({ count: 0 });
      repository.findById.mockResolvedValue(null);

      await expect(service.classify(input)).rejects.toThrow('vanished mid-reclaim');
    });
  });

  describe('reject', () => {
    it('delegates to the repository with the exact fenced arguments', async () => {
      repository.rejectIfCurrentAttempt.mockResolvedValue({ count: 1 });

      const result = await service.reject('attempt-1', 2, 'QUANTITY_NOT_AVAILABLE', 'Only 1 unit(s) available', now);

      expect(repository.rejectIfCurrentAttempt).toHaveBeenCalledWith(
        'attempt-1',
        2,
        'QUANTITY_NOT_AVAILABLE',
        'Only 1 unit(s) available',
        now,
      );
      expect(result).toEqual({ count: 1 });
    });
  });

  describe('complete', () => {
    it('delegates to the repository with the transaction client and exact fenced arguments', async () => {
      const tx = {} as never;
      repository.completeIfCurrentAttempt.mockResolvedValue({ count: 1 });
      const completedResult = { cartItemId: 'item-1', quantity: 5, mutationVersion: 1, generation: 3 };

      const result = await service.complete(tx, 'attempt-1', 2, completedResult, now);

      expect(repository.completeIfCurrentAttempt).toHaveBeenCalledWith(tx, 'attempt-1', 2, completedResult, now);
      expect(result).toEqual({ count: 1 });
    });
  });
});
