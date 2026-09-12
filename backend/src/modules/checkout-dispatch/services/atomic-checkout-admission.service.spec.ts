import { randomUUID } from 'crypto';
import { CheckoutOperation, Prisma } from '@prisma/client';
import { PrismaService } from '../../../database/prisma.service';
import { CheckoutOperationRepository } from '../../checkout-operation/repositories/checkout-operation.repository';
import { CheckoutAttemptRepository } from '../../checkout-attempt/repositories/checkout-attempt.repository';
import { CheckoutRolloutParticipantsRepository } from '../../checkout-rollout/repositories/checkout-rollout-participants.repository';
import { RolloutControlsRepository } from '../../checkout-rollout-admin/repositories/rollout-controls.repository';
import { AtomicCheckoutAdmissionService } from './atomic-checkout-admission.service';

describe('G.3b atomic admission contract', () => {
  const context = { customerId: randomUUID(), cartId: randomUUID(), operationId: randomUUID() };
  let operation: CheckoutOperation;
  const tx = {
    $executeRaw: jest.fn<Promise<number>, [TemplateStringsArray, ...unknown[]]>(),
    reservationFenceTransition: { findFirst: jest.fn() },
    reservationEngineModeConfig: { findFirst: jest.fn() },
  };
  const transaction = jest.fn();
  const operations = { lockOwned: jest.fn(), assignPath: jest.fn(), bindReservationCapability: jest.fn(), findOwned: jest.fn() };
  const attempts = { findByIdempotencyKey: jest.fn(), createWithReservationCapability: jest.fn() };
  const controls = { findCurrent: jest.fn() };
  const participants = { findCurrent: jest.fn() };
  const service = new AtomicCheckoutAdmissionService(
    { $transaction: transaction } as unknown as PrismaService,
    operations as unknown as CheckoutOperationRepository,
    attempts as unknown as CheckoutAttemptRepository,
    controls as unknown as RolloutControlsRepository,
    participants as unknown as CheckoutRolloutParticipantsRepository,
  );
  beforeEach(() => {
    jest.resetAllMocks();
    operation = {
      reservationExecutionEpoch: null,
      reservationCapabilityState: null,
      id: context.operationId,
      customerId: context.customerId,
      cartId: context.cartId,
      operationKey: randomUUID(),
      selectedPath: null,
      retryKeyHash: 'hash',
      priceLockFingerprint: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    transaction.mockImplementation(
      async (work: (client: Prisma.TransactionClient) => Promise<unknown>) =>
        work(tx as unknown as Prisma.TransactionClient),
    );
    tx.$executeRaw.mockResolvedValue(1);
    tx.reservationFenceTransition.findFirst.mockResolvedValue({ status: 'ACKNOWLEDGED', phase: 'OPEN', mode: 'CART_SCOPED', epoch: 7, modeRevision: 3 });
    tx.reservationEngineModeConfig.findFirst.mockResolvedValue({ mode: 'CART_SCOPED', revision: 3 });
    operations.lockOwned.mockImplementation(() => Promise.resolve(operation));
    operations.assignPath.mockResolvedValue({ count: 1 });
    operations.bindReservationCapability.mockResolvedValue({ count: 1 });
    operations.findOwned.mockImplementation(() =>
      Promise.resolve({ ...operation, selectedPath: 'CART_SCOPED', reservationExecutionEpoch: 7, reservationCapabilityState: 'ACTIVE' }),
    );
    attempts.findByIdempotencyKey.mockResolvedValue(null);
    attempts.createWithReservationCapability.mockImplementation((input: Parameters<CheckoutAttemptRepository['createWithReservationCapability']>[0]) => Promise.resolve({
      id: randomUUID(), customerId: input.customerId, cartId: input.cartId,
      selectedPath: 'CART_SCOPED', reservationExecutionEpoch: input.epoch,
    }));
    controls.findCurrent.mockResolvedValue({
      newAdmissionStopped: false,
      behavior: 'CART_SCOPED',
      eligibleCohort: 'pilot',
    });
    participants.findCurrent.mockResolvedValue({ enabled: true, cohort: 'pilot' });
  });
  it('uses exact global and participant keys in fixed order, and transaction clients for all reads/writes', async () => {
    expect(await service.admit(context)).toMatchObject({
      ok: true,
      decision: 'CART_SCOPED',
      durable: true,
    });
    expect(tx.$executeRaw.mock.calls[0]?.slice(1)).toEqual([1196634962, 1]);
    expect(tx.$executeRaw.mock.calls[0]?.[0].join('')).toContain(
      'pg_advisory_xact_lock_shared',
    );
    expect(tx.$executeRaw.mock.calls[1]?.slice(1)).toEqual([
      `checkout_rollout_participant:${context.customerId}`,
    ]);
    expect(tx.$executeRaw.mock.calls[1]?.[0].join('')).toContain(
      'pg_advisory_xact_lock(hashtext(',
    );
    expect(operations.lockOwned).toHaveBeenCalledWith(context.operationId, context.customerId, tx);
    expect(attempts.findByIdempotencyKey).toHaveBeenCalledWith(operation.operationKey, tx);
    expect(controls.findCurrent).toHaveBeenCalledWith(tx);
    expect(participants.findCurrent).toHaveBeenCalledWith(context.customerId, tx);
    expect(operations.bindReservationCapability).toHaveBeenCalledWith(
      operation.id,
      7,
      tx,
    );
    expect(operations.assignPath).not.toHaveBeenCalled();
    expect(attempts.createWithReservationCapability).toHaveBeenCalledWith({
      operationKey: operation.operationKey, customerId: operation.customerId,
      cartId: operation.cartId, epoch: 7,
    }, tx);
    expect(transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: 'ReadCommitted',
      timeout: 5000,
      maxWait: 5000,
    });
    const order = [
      tx.$executeRaw.mock.invocationCallOrder[0]!,
      tx.$executeRaw.mock.invocationCallOrder[1]!,
      operations.lockOwned.mock.invocationCallOrder[0]!,
      controls.findCurrent.mock.invocationCallOrder[0]!,
      participants.findCurrent.mock.invocationCallOrder[0]!,
      operations.bindReservationCapability.mock.invocationCallOrder[0]!,
      attempts.createWithReservationCapability.mock.invocationCallOrder[0]!,
    ];
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });
  it.each(['global', 'participant', 'lock', 'commit'])(
    'fails closed on %s failure',
    async (failure) => {
      if (failure === 'global') controls.findCurrent.mockRejectedValue(new Error('private'));
      if (failure === 'participant')
        participants.findCurrent.mockRejectedValue(new Error('private'));
      if (failure === 'lock') tx.$executeRaw.mockRejectedValue(new Error('private'));
      if (failure === 'commit') transaction.mockRejectedValue(new Error('private'));
      expect(await service.admit(context)).toEqual({ ok: false, code: 'UNAVAILABLE' });
      expect(operations.assignPath).not.toHaveBeenCalled();
    },
  );
  it('missing global state never fabricates legacy', async () => {
    controls.findCurrent.mockResolvedValue(null);
    expect(await service.admit(context)).toEqual({ ok: false, code: 'UNAVAILABLE' });
    expect(participants.findCurrent).not.toHaveBeenCalled();
  });
  it.each([true, false])(
    'stop/explicit DENY precedes participant lookup (stop=%s)',
    async (stop) => {
      controls.findCurrent.mockResolvedValue({
        newAdmissionStopped: stop,
        behavior: stop ? 'CART_SCOPED' : 'DENY',
      });
      expect(await service.admit(context)).toEqual({ ok: false, code: 'ADMISSION_DENIED' });
      expect(participants.findCurrent).not.toHaveBeenCalled();
      expect(operations.assignPath).not.toHaveBeenCalled();
    },
  );
  it.each([null, { enabled: false, cohort: 'pilot' }, { enabled: true, cohort: 'other' }])(
    'denies missing/disabled/mismatched participant %j',
    async (participant) => {
      participants.findCurrent.mockResolvedValue(participant);
      expect(await service.admit(context)).toEqual({ ok: false, code: 'ADMISSION_DENIED' });
      expect(operations.assignPath).not.toHaveBeenCalled();
    },
  );
  it.each(['LEGACY', 'CART_SCOPED'] as const)(
    'assigned %s bypasses policy even when unavailable',
    async (path) => {
      operation.selectedPath = path;
      if (path === 'CART_SCOPED') {
        operation.reservationExecutionEpoch = 7;
        operation.reservationCapabilityState = 'ACTIVE';
      }
      controls.findCurrent.mockRejectedValue(new Error('unavailable'));
      participants.findCurrent.mockRejectedValue(new Error('unavailable'));
      expect(await service.admit(context)).toEqual({
        ok: true,
        decision: path,
        operation,
        durable: true,
      });
      expect(controls.findCurrent).not.toHaveBeenCalled();
      expect(participants.findCurrent).not.toHaveBeenCalled();
      expect(operations.assignPath).not.toHaveBeenCalled();
    },
  );
  it('SHADOW has no assignment or durable ownership', async () => {
    controls.findCurrent.mockResolvedValue({
      newAdmissionStopped: false,
      behavior: 'SHADOW',
      eligibleCohort: null,
    });
    expect(await service.admit(context)).toEqual({
      ok: true,
      decision: 'SHADOW',
      operation,
      durable: false,
    });
    expect(operations.assignPath).not.toHaveBeenCalled();
  });
  it.each([{ cartId: randomUUID() }, { customerId: 'invalid' }, { operationKey: 'forged' }])(
    'rejects ownership/client override %j',
    async (override) => {
      expect(await service.admit({ ...context, ...override })).toEqual({
        ok: false,
        code: 'PATH_MISMATCH',
      });
      expect(controls.findCurrent).not.toHaveBeenCalled();
    },
  );
  it.each([null, 'LEGACY', 'SHADOW'])(
    'does not repair inconsistent attempt path %s',
    async (path) => {
      operation.selectedPath = 'CART_SCOPED';
      attempts.findByIdempotencyKey.mockResolvedValue({
        customerId: operation.customerId,
        cartId: operation.cartId,
        idempotencyKey: operation.operationKey,
        selectedPath: path,
      });
      expect(await service.admit(context)).toEqual({ ok: false, code: 'PATH_MISMATCH' });
      expect(controls.findCurrent).not.toHaveBeenCalled();
    },
  );
  it('returns an attempt-race replay signal without preparation or policy lookup', async () => {
    operation.selectedPath = 'CART_SCOPED';
    attempts.findByIdempotencyKey.mockResolvedValue({
      customerId: operation.customerId,
      cartId: operation.cartId,
      idempotencyKey: operation.operationKey,
      selectedPath: 'CART_SCOPED',
    });
    expect(await service.admit(context)).toEqual({
      ok: true,
      decision: 'EXISTING_ATTEMPT',
      operation,
      durable: true,
    });
    expect(controls.findCurrent).not.toHaveBeenCalled();
    expect(operations.assignPath).not.toHaveBeenCalled();
  });

  it('does not upgrade an assigned historical NULL-E operation', async () => {
    operation.selectedPath = 'CART_SCOPED';
    expect(await service.admit(context)).toEqual({ ok: false, code: 'PATH_MISMATCH' });
    expect(operations.bindReservationCapability).not.toHaveBeenCalled();
    expect(attempts.createWithReservationCapability).not.toHaveBeenCalled();
  });

  it('inspects a historical NULL-E attempt without manufacturing capability', async () => {
    operation.selectedPath = 'CART_SCOPED';
    attempts.findByIdempotencyKey.mockResolvedValue({
      customerId: operation.customerId, cartId: operation.cartId,
      idempotencyKey: operation.operationKey, selectedPath: 'CART_SCOPED',
      reservationExecutionEpoch: null,
    });
    expect(await service.admit(context)).toMatchObject({ ok: true, decision: 'EXISTING_ATTEMPT' });
    expect(operations.bindReservationCapability).not.toHaveBeenCalled();
    expect(attempts.createWithReservationCapability).not.toHaveBeenCalled();
    expect(tx.reservationFenceTransition.findFirst).not.toHaveBeenCalled();
  });

  it('does not silently upgrade a previously bound operation to a newer epoch', async () => {
    operation.selectedPath = 'CART_SCOPED';
    operation.reservationExecutionEpoch = 6;
    operation.reservationCapabilityState = 'ACTIVE';
    expect(await service.admit(context)).toEqual({ ok: false, code: 'UNAVAILABLE' });
    expect(attempts.createWithReservationCapability).not.toHaveBeenCalled();
  });

  it.each([null, { status: 'PENDING', phase: 'OPEN', mode: 'CART_SCOPED', epoch: 7, modeRevision: 3 },
    { status: 'ACKNOWLEDGED', phase: 'DRAINING', mode: 'CART_SCOPED', epoch: 7, modeRevision: 3 },
    { status: 'ACKNOWLEDGED', phase: 'OPEN', mode: 'CART_SCOPED', epoch: 7, modeRevision: 2 }])(
    'refuses new capability for unavailable or inconsistent durable fence %j', async (fence) => {
      tx.reservationFenceTransition.findFirst.mockResolvedValue(fence);
      expect(await service.admit(context)).toEqual({ ok: false, code: 'UNAVAILABLE' });
      expect(operations.bindReservationCapability).not.toHaveBeenCalled();
      expect(attempts.createWithReservationCapability).not.toHaveBeenCalled();
    });

  it('rejects inconsistent epoch inheritance inside the assignment transaction', async () => {
    attempts.createWithReservationCapability.mockResolvedValue({
      customerId: operation.customerId, cartId: operation.cartId,
      selectedPath: 'CART_SCOPED', reservationExecutionEpoch: null,
    });
    expect(await service.admit(context)).toEqual({ ok: false, code: 'UNAVAILABLE' });
  });

  it('keeps new LEGACY assignment capability-free', async () => {
    controls.findCurrent.mockResolvedValue({ newAdmissionStopped: false, behavior: 'LEGACY', eligibleCohort: null });
    operations.findOwned.mockResolvedValue({ ...operation, selectedPath: 'LEGACY' });
    expect(await service.admit(context)).toMatchObject({ ok: true, decision: 'LEGACY' });
    expect(operations.assignPath).toHaveBeenCalledWith(operation.id, context.customerId, 'LEGACY', tx);
    expect(operations.bindReservationCapability).not.toHaveBeenCalled();
    expect(attempts.createWithReservationCapability).not.toHaveBeenCalled();
    expect(tx.reservationFenceTransition.findFirst).not.toHaveBeenCalled();
  });
});
