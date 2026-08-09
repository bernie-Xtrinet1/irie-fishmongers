import { Prisma } from '@prisma/client';

import { CompensationRepository } from '../repositories/compensation.repository';
import { CompensationService } from './compensation.service';
import { RecordMirrorDivergenceInput } from '../types/compensation-service.types';

// Phase 16A.0-C4.2. Mocks CompensationRepository entirely - this suite
// verifies CompensationService's own validation, sanitization, and
// bounded-retry routing logic. Real-Postgres concurrency/race proof
// lives in compensation-concurrency.service.spec.ts.

type MockRepository = jest.Mocked<
  Pick<
    CompensationRepository,
    | 'create'
    | 'findUnresolvedByCartAndProduct'
    | 'advanceGenerationPreservingStatus'
    | 'advanceGenerationAndUnblock'
  >
>;

function p2002(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
  });
}

function baseInput(overrides: Partial<RecordMirrorDivergenceInput> = {}): RecordMirrorDivergenceInput {
  return {
    operation: 'RESERVE_MIRROR',
    cartId: 'cart-1',
    productId: 'product-1',
    customerId: 'customer-1',
    desiredQuantity: 5,
    reasonCode: 'UNKNOWN_INFRA_FAILURE',
    lastError: null,
    now: new Date(),
    ...overrides,
  };
}

describe('CompensationService', () => {
  let repository: MockRepository;
  let service: CompensationService;

  beforeEach(() => {
    repository = {
      create: jest.fn(),
      findUnresolvedByCartAndProduct: jest.fn(),
      advanceGenerationPreservingStatus: jest.fn(),
      advanceGenerationAndUnblock: jest.fn(),
    };
    service = new CompensationService(repository as unknown as CompensationRepository);
  });

  describe('input validation', () => {
    it('rejects a malformed cartId before any repository call', async () => {
      const result = await service.recordMirrorDivergence(baseInput({ cartId: 'cart id' }));

      expect(result).toEqual({
        ok: false,
        code: 'INVALID_INPUT',
        field: 'cartId',
        reason: 'cartId cannot contain whitespace',
      });
      expect(repository.create).not.toHaveBeenCalled();
    });

    it('rejects a malformed productId', async () => {
      const result = await service.recordMirrorDivergence(baseInput({ productId: '' }));
      expect(result).toEqual({
        ok: false,
        code: 'INVALID_INPUT',
        field: 'productId',
        reason: 'productId cannot be empty',
      });
    });

    it('rejects a malformed customerId when present', async () => {
      const result = await service.recordMirrorDivergence(baseInput({ customerId: 'bad{id}' }));
      expect(result).toEqual({
        ok: false,
        code: 'INVALID_INPUT',
        field: 'customerId',
        reason: "customerId cannot contain '{', '}', or ':'",
      });
    });

    it('rejects a missing desiredQuantity for RESERVE_MIRROR', async () => {
      const result = await service.recordMirrorDivergence(
        baseInput({ operation: 'RESERVE_MIRROR', desiredQuantity: null }),
      );
      expect(result).toEqual({
        ok: false,
        code: 'INVALID_INPUT',
        field: 'desiredQuantity',
        reason: 'desiredQuantity must be a positive integer for RESERVE_MIRROR',
      });
    });

    it('rejects a non-positive desiredQuantity for RESERVE_MIRROR', async () => {
      const result = await service.recordMirrorDivergence(
        baseInput({ operation: 'RESERVE_MIRROR', desiredQuantity: 0 }),
      );
      expect(result.ok).toBe(false);
    });

    it('rejects a non-null desiredQuantity for RELEASE_MIRROR', async () => {
      const result = await service.recordMirrorDivergence(
        baseInput({ operation: 'RELEASE_MIRROR', customerId: null, desiredQuantity: 3 }),
      );
      expect(result).toEqual({
        ok: false,
        code: 'INVALID_INPUT',
        field: 'desiredQuantity',
        reason: 'desiredQuantity must be null for RELEASE_MIRROR',
      });
    });

    it('accepts a null desiredQuantity for RELEASE_MIRROR', async () => {
      repository.create.mockResolvedValue({ id: 'comp-1' } as never);
      const result = await service.recordMirrorDivergence(
        baseInput({ operation: 'RELEASE_MIRROR', customerId: null, desiredQuantity: null }),
      );
      expect(result).toEqual({ ok: true, outcome: 'CREATED', compensationId: 'comp-1' });
    });

    it('rejects an invalid now', async () => {
      const result = await service.recordMirrorDivergence(baseInput({ now: new Date('not-a-date') }));
      expect(result).toEqual({ ok: false, code: 'INVALID_INPUT', field: 'now', reason: 'now must be a valid Date' });
      expect(repository.create).not.toHaveBeenCalled();
    });

    it('rejects a runtime-invalid operation, not just a TypeScript type', async () => {
      const result = await service.recordMirrorDivergence(
        baseInput({ operation: 'NOT_A_REAL_OPERATION' as never }),
      );
      expect(result).toEqual({
        ok: false,
        code: 'INVALID_INPUT',
        field: 'operation',
        reason: 'operation must be RESERVE_MIRROR or RELEASE_MIRROR',
      });
      expect(repository.create).not.toHaveBeenCalled();
    });

    it('rejects a runtime-invalid reasonCode, not just a TypeScript type', async () => {
      const result = await service.recordMirrorDivergence(baseInput({ reasonCode: 'NOT_A_REAL_REASON' as never }));
      expect(result).toEqual({
        ok: false,
        code: 'INVALID_INPUT',
        field: 'reasonCode',
        reason:
          'reasonCode must be one of PRODUCT_SUSPENDED, CHECKOUT_IN_PROGRESS, ACCOUNTING_UNDERFLOW, UNKNOWN_INFRA_FAILURE',
      });
    });

    it('rejects a null customerId for RESERVE_MIRROR', async () => {
      const result = await service.recordMirrorDivergence(
        baseInput({ operation: 'RESERVE_MIRROR', customerId: null }),
      );
      expect(result).toEqual({
        ok: false,
        code: 'INVALID_INPUT',
        field: 'customerId',
        reason: 'customerId is required for RESERVE_MIRROR',
      });
    });

    it('rejects a non-null customerId for RELEASE_MIRROR', async () => {
      const result = await service.recordMirrorDivergence(
        baseInput({ operation: 'RELEASE_MIRROR', customerId: 'customer-1', desiredQuantity: null }),
      );
      expect(result).toEqual({
        ok: false,
        code: 'INVALID_INPUT',
        field: 'customerId',
        reason: 'customerId must be null for RELEASE_MIRROR',
      });
    });
  });

  describe('sanitization', () => {
    it('passes the sanitized lastError to the repository, never the raw value', async () => {
      repository.create.mockResolvedValue({ id: 'comp-1' } as never);

      await service.recordMirrorDivergence(baseInput({ lastError: 'Bearer abc123.def456 failed' }));

      expect(repository.create).toHaveBeenCalledWith(
        expect.objectContaining({ lastError: 'Bearer [REDACTED] failed' }),
      );
    });

    it('never exposes raw lastError in the result', async () => {
      repository.create.mockResolvedValue({ id: 'comp-1' } as never);

      const result = await service.recordMirrorDivergence(baseInput({ lastError: 'secret=hunter2' }));

      expect(JSON.stringify(result)).not.toContain('hunter2');
    });

    it('never logs the raw lastError', async () => {
      repository.create.mockResolvedValue({ id: 'comp-1' } as never);
      const logSpy = jest.spyOn(service['logger'], 'log');

      await service.recordMirrorDivergence(baseInput({ lastError: 'password=hunter2' }));

      expect(logSpy).toHaveBeenCalled();
      expect(JSON.stringify(logSpy.mock.calls)).not.toContain('hunter2');
    });
  });

  describe('CREATED path', () => {
    it('maps a successful create to CREATED', async () => {
      repository.create.mockResolvedValue({ id: 'comp-1' } as never);

      const result = await service.recordMirrorDivergence(baseInput());

      expect(result).toEqual({ ok: true, outcome: 'CREATED', compensationId: 'comp-1' });
      expect(repository.findUnresolvedByCartAndProduct).not.toHaveBeenCalled();
    });

    it('propagates a non-P2002 create error', async () => {
      repository.create.mockRejectedValue(new Error('connection refused'));

      await expect(service.recordMirrorDivergence(baseInput())).rejects.toThrow('connection refused');
    });
  });

  describe('GENERATION_ADVANCED path', () => {
    it('P2002 + existing PENDING row -> advanceGenerationPreservingStatus, GENERATION_ADVANCED', async () => {
      repository.create.mockRejectedValue(p2002());
      repository.findUnresolvedByCartAndProduct.mockResolvedValue({ id: 'comp-1', status: 'PENDING' } as never);
      repository.advanceGenerationPreservingStatus.mockResolvedValue({ count: 1 });

      const result = await service.recordMirrorDivergence(baseInput());

      expect(result).toEqual({ ok: true, outcome: 'GENERATION_ADVANCED', compensationId: 'comp-1' });
      expect(repository.advanceGenerationAndUnblock).not.toHaveBeenCalled();
    });

    it('P2002 + existing PROCESSING row -> advanceGenerationPreservingStatus (status preserved)', async () => {
      repository.create.mockRejectedValue(p2002());
      repository.findUnresolvedByCartAndProduct.mockResolvedValue({ id: 'comp-1', status: 'PROCESSING' } as never);
      repository.advanceGenerationPreservingStatus.mockResolvedValue({ count: 1 });

      const result = await service.recordMirrorDivergence(baseInput());

      expect(result).toEqual({ ok: true, outcome: 'GENERATION_ADVANCED', compensationId: 'comp-1' });
      expect(repository.advanceGenerationAndUnblock).not.toHaveBeenCalled();
    });

    it('P2002 + BLOCKED row + ACCOUNTING_UNDERFLOW arrival -> preservingStatus (stays BLOCKED)', async () => {
      repository.create.mockRejectedValue(p2002());
      repository.findUnresolvedByCartAndProduct.mockResolvedValue({ id: 'comp-1', status: 'BLOCKED' } as never);
      repository.advanceGenerationPreservingStatus.mockResolvedValue({ count: 1 });

      const result = await service.recordMirrorDivergence(baseInput({ reasonCode: 'ACCOUNTING_UNDERFLOW' }));

      expect(result).toEqual({ ok: true, outcome: 'GENERATION_ADVANCED', compensationId: 'comp-1' });
      expect(repository.advanceGenerationPreservingStatus).toHaveBeenCalledWith(
        'comp-1',
        expect.objectContaining({ reasonCode: 'ACCOUNTING_UNDERFLOW' }),
      );
      expect(repository.advanceGenerationAndUnblock).not.toHaveBeenCalled();
    });

    it('P2002 + BLOCKED row + ordinary reason arrival -> advanceGenerationAndUnblock', async () => {
      repository.create.mockRejectedValue(p2002());
      repository.findUnresolvedByCartAndProduct.mockResolvedValue({ id: 'comp-1', status: 'BLOCKED' } as never);
      repository.advanceGenerationAndUnblock.mockResolvedValue({ count: 1 });

      const result = await service.recordMirrorDivergence(baseInput({ reasonCode: 'CHECKOUT_IN_PROGRESS' }));

      expect(result).toEqual({ ok: true, outcome: 'GENERATION_ADVANCED', compensationId: 'comp-1' });
      expect(repository.advanceGenerationPreservingStatus).not.toHaveBeenCalled();
    });

    it('never asks the repository to touch attemptCount/blockedCheckCount on arrival', async () => {
      repository.create.mockRejectedValue(p2002());
      repository.findUnresolvedByCartAndProduct.mockResolvedValue({ id: 'comp-1', status: 'PENDING' } as never);
      repository.advanceGenerationPreservingStatus.mockResolvedValue({ count: 1 });

      await service.recordMirrorDivergence(baseInput());

      const [, updateInput] = repository.advanceGenerationPreservingStatus.mock.calls[0]!;
      expect(updateInput).not.toHaveProperty('attemptCount');
      expect(updateInput).not.toHaveProperty('blockedCheckCount');
    });
  });

  describe('bounded retry loop', () => {
    it('retries create when findUnresolvedByCartAndProduct finds nothing after P2002', async () => {
      repository.create.mockRejectedValueOnce(p2002()).mockResolvedValueOnce({ id: 'comp-2' } as never);
      repository.findUnresolvedByCartAndProduct.mockResolvedValue(null);

      const result = await service.recordMirrorDivergence(baseInput());

      expect(result).toEqual({ ok: true, outcome: 'CREATED', compensationId: 'comp-2' });
      expect(repository.create).toHaveBeenCalledTimes(2);
    });

    it('retries create when the arrival update matches zero rows (resolved between read and write)', async () => {
      repository.create.mockRejectedValueOnce(p2002()).mockResolvedValueOnce({ id: 'comp-2' } as never);
      repository.findUnresolvedByCartAndProduct.mockResolvedValue({ id: 'comp-1', status: 'PENDING' } as never);
      repository.advanceGenerationPreservingStatus.mockResolvedValue({ count: 0 });

      const result = await service.recordMirrorDivergence(baseInput());

      expect(result).toEqual({ ok: true, outcome: 'CREATED', compensationId: 'comp-2' });
      expect(repository.create).toHaveBeenCalledTimes(2);
    });

    it('throws a plain consistency error once MAX_OPTIMISTIC_RETRIES is exhausted', async () => {
      repository.create.mockRejectedValue(p2002());
      repository.findUnresolvedByCartAndProduct.mockResolvedValue(null);

      await expect(service.recordMirrorDivergence(baseInput())).rejects.toThrow(/consistency error/i);
      expect(repository.create).toHaveBeenCalledTimes(3);
    });
  });
});
