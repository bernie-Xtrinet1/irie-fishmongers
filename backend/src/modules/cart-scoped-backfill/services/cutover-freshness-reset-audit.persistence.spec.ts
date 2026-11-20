import { createHash, randomUUID } from 'crypto';

import { Prisma } from '@prisma/client';

import { MAX_RESERVATION_LIFETIME_SECONDS, RESERVATION_TTL_SECONDS } from '../../inventory/constants/inventory.constants';
import { setUpCompensationFixture } from '../../mirror-compensation/repositories/compensation-repository-test-helpers';
import { ordinaryHoldInstanceId } from '../../reservation-fence/ordinary-hold-instance-id';
import { openOrdinarySchema, seedCartAndProductForSchema } from '../../reservation-fence/tests/ordinary-provenance-test-helpers';

jest.setTimeout(120_000);

type SeedContext = {
  cutoverRunId: string;
  operatorId: string;
  customerId: string;
  cartId: string;
  productId: string;
  markerId: string;
  generation: number;
  holdInstanceId: string;
  barrierRevision: number;
  modeRevision: number;
  fenceTransitionId: string;
  incarnation: string;
  fenceEpoch: number;
  fenceRevision: number;
  quantity: number;
};

async function seedFreshnessAuditPrerequisites(db: Awaited<ReturnType<typeof openOrdinarySchema>>['db']): Promise<SeedContext> {
  const base = await setUpCompensationFixture(db);
  const { cartId, productId, customerId } = await seedCartAndProductForSchema(base);
  const operatorId = base.userIds[0]!;
  const quantity = 3;
  const generation = 1;

  await db.cartItem.create({ data: { cartId, productId, quantity, mutationVersion: 1 } });
  const marker = await db.cartReservationSyncState.create({
    data: { cartId, productId, expectedQuantity: quantity, expectedMutationVersion: 1, generation, resolvedAt: new Date() },
  });
  const barrier = await db.cartMutationBarrierConfig.create({ data: { active: true, activatedById: operatorId } });
  const mode = await db.reservationEngineModeConfig.create({ data: { mode: 'MIRROR', updatedById: operatorId } });
  const latestFence = await db.reservationFenceTransition.findFirst({ orderBy: { revision: 'desc' } });
  const incarnation = randomUUID();
  const fence = await db.reservationFenceTransition.create({
    data: {
      id: randomUUID(),
      incarnation,
      epoch: (latestFence?.epoch ?? 0) + 1,
      revision: (latestFence?.revision ?? 0) + 1,
      phase: 'OPEN',
      protocol: 1,
      mode: 'MIRROR',
      modeRevision: mode.revision,
      status: 'ACKNOWLEDGED',
      acknowledgedAt: new Date(),
      reason: 'OPEN',
      actorId: operatorId,
    },
  });

  return {
    cutoverRunId: randomUUID(),
    operatorId,
    customerId,
    cartId,
    productId,
    markerId: marker.id,
    generation,
    holdInstanceId: ordinaryHoldInstanceId(marker.id, generation),
    barrierRevision: barrier.revision,
    modeRevision: mode.revision,
    fenceTransitionId: fence.id,
    incarnation,
    fenceEpoch: fence.epoch,
    fenceRevision: fence.revision,
    quantity,
  };
}

function buildPreparedInput(seed: SeedContext, requestId = randomUUID(), anchorNowMs = Date.now()) {
  return {
    requestId,
    cutoverRunId: seed.cutoverRunId,
    barrierRevision: seed.barrierRevision,
    fenceTransitionId: seed.fenceTransitionId,
    incarnation: seed.incarnation,
    fenceEpoch: seed.fenceEpoch,
    fenceRevision: seed.fenceRevision,
    modeRevision: seed.modeRevision,
    markerId: seed.markerId,
    generation: seed.generation,
    holdInstanceId: seed.holdInstanceId,
    customerId: seed.customerId,
    cartId: seed.cartId,
    productId: seed.productId,
    quantity: seed.quantity,
    operatorId: seed.operatorId,
    anchorNowMs: BigInt(anchorNowMs),
  };
}

function buildCompletedEvidence(requestId: string, anchorNowMs: number) {
  const receipt = JSON.stringify({ requestId, version: 1, effect: 'FRESHNESS_SWEEP', status: 'APPLIED', anchorNowMs });
  const hash = createHash('sha256').update(receipt, 'utf8').digest('hex');
  const priorCreatedAtMs = anchorNowMs - 3_500_000;
  return {
    status: 'COMPLETED' as const,
    priorCreatedAtMs: BigInt(priorCreatedAtMs),
    priorLastRenewedAtMs: BigInt(priorCreatedAtMs + 60_000),
    priorExpiresAtMs: BigInt(priorCreatedAtMs + 900_000),
    priorAbsoluteExpiresAtMs: BigInt(priorCreatedAtMs + MAX_RESERVATION_LIFETIME_SECONDS * 1000),
    newCreatedAtMs: BigInt(anchorNowMs),
    newLastRenewedAtMs: BigInt(anchorNowMs),
    newExpiresAtMs: BigInt(anchorNowMs + RESERVATION_TTL_SECONDS * 1000),
    newAbsoluteExpiresAtMs: BigInt(anchorNowMs + MAX_RESERVATION_LIFETIME_SECONDS * 1000),
    redisReceipt: receipt,
    redisReceiptHash: hash,
  };
}

describe('Migration #67: cutover_freshness_resets persistence, constraints & concurrency (disposable DB)', () => {
  it('fresh deployment from all 67 migrations installs table, constraints, indexes, triggers, and schema-scoped functions', async () => {
    const schema = await openOrdinarySchema(67);
    try {
      const [migRow] = await schema.db.$queryRaw<{ count: bigint }[]>`
        SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL`;
      expect(Number(migRow!.count)).toBe(67);

      const indexes = await schema.db.$queryRaw<{ indexname: string }[]>`
        SELECT indexname FROM pg_indexes WHERE schemaname = current_schema() AND tablename = 'cutover_freshness_resets' ORDER BY indexname`;
      expect(indexes.map((r) => r.indexname)).toEqual([
        'cutover_freshness_resets_cart_product_idx',
        'cutover_freshness_resets_idempotency_key',
        'cutover_freshness_resets_marker_gen_idx',
        'cutover_freshness_resets_pkey',
        'cutover_freshness_resets_requestId_key',
        'cutover_freshness_resets_run_status_idx',
        'cutover_freshness_resets_status_createdAt_idx',
      ]);

      const functions = await schema.db.$queryRaw<{ name: string; definer: boolean; config: string[]; schema: string }[]>`
        SELECT p.proname AS name, p.prosecdef AS definer, p.proconfig AS config, n.nspname AS schema
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = current_schema() AND p.proname LIKE 'cutover_freshness_reset_%' ORDER BY p.proname`;
      expect(functions).toHaveLength(2);
      for (const fn of functions) {
        expect(fn.definer).toBe(false);
        expect(fn.config).toEqual([`search_path=pg_catalog, ${fn.schema}, pg_temp`]);
      }
    } finally {
      await schema.close();
    }
  });

  it('upgrades cleanly from 66 -> 67 preserving pre-existing data and enforcing PREPARED -> COMPLETED & ABORTED state machine', async () => {
    const schema = await openOrdinarySchema(66);
    try {
      const [beforeCount] = await schema.db.$queryRaw<{ count: bigint }[]>`
        SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL`;
      expect(Number(beforeCount!.count)).toBe(66);

      const seed = await seedFreshnessAuditPrerequisites(schema.db);
      schema.upgrade();

      const [afterCount] = await schema.db.$queryRaw<{ count: bigint }[]>`
        SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL`;
      expect(Number(afterCount!.count)).toBe(67);

      expect(await schema.db.cartItem.findUniqueOrThrow({ where: { cartId_productId: { cartId: seed.cartId, productId: seed.productId } } }))
        .toMatchObject({ quantity: seed.quantity });

      const anchorNowMs = Date.now();
      const requestId = randomUUID();
      const prepared = await schema.db.cutoverFreshnessResetAudit.create({
        data: buildPreparedInput(seed, requestId, anchorNowMs),
      });
      expect(prepared.status).toBe('PREPARED');
      expect(prepared.completedAt).toBeNull();

      const completed = await schema.db.cutoverFreshnessResetAudit.update({
        where: { id: prepared.id },
        data: buildCompletedEvidence(requestId, anchorNowMs),
      });
      expect(completed.status).toBe('COMPLETED');
      expect(completed.completedAt).toBeInstanceOf(Date);
      expect(completed.completedAt!.getTime()).toBeGreaterThanOrEqual(completed.createdAt.getTime());

      // New cutoverRunId supports PREPARED -> ABORTED with failure code.
      const abortRun = { ...seed, cutoverRunId: randomUUID() };
      const p2 = await schema.db.cutoverFreshnessResetAudit.create({ data: buildPreparedInput(abortRun) });
      const aborted = await schema.db.cutoverFreshnessResetAudit.update({
        where: { id: p2.id },
        data: { status: 'ABORTED', failureCode: 'CHECKOUT_PIN_PRESENT', failureDetail: 'Active checkout pin detected' },
      });
      expect(aborted.status).toBe('ABORTED');
      expect(aborted.failureCode).toBe('CHECKOUT_PIN_PRESENT');
    } finally {
      await schema.close();
    }
  });

  it('rejects duplicate requestId, duplicate idempotency tuple, invalid preconditions, bad transitions, and receipt tampering', async () => {
    const schema = await openOrdinarySchema(67);
    try {
      const seed = await seedFreshnessAuditPrerequisites(schema.db);
      const anchorNowMs = Date.now();
      const req1 = randomUUID();
      const row = await schema.db.cutoverFreshnessResetAudit.create({ data: buildPreparedInput(seed, req1, anchorNowMs) });

      // Duplicate requestId under different cutoverRunId -> P2002 / 23505.
      await expect(
        schema.db.cutoverFreshnessResetAudit.create({
          data: buildPreparedInput({ ...seed, cutoverRunId: randomUUID() }, req1, anchorNowMs),
        }),
      ).rejects.toMatchObject({ code: 'P2002' });

      // Duplicate (cutoverRunId, barrierRevision, markerId, generation) under fresh requestId -> P2002 / 23505.
      await expect(
        schema.db.cutoverFreshnessResetAudit.create({
          data: buildPreparedInput(seed, randomUUID(), anchorNowMs),
        }),
      ).rejects.toMatchObject({ code: 'P2002' });

      // Direct insert as COMPLETED or ABORTED fails closed.
      await expect(
        schema.db.cutoverFreshnessResetAudit.create({
          data: {
            ...buildPreparedInput({ ...seed, cutoverRunId: randomUUID() }, randomUUID(), anchorNowMs),
            ...buildCompletedEvidence(randomUUID(), anchorNowMs),
          },
        }),
      ).rejects.toThrow();

      // Negative generation / barrierRevision / non-FRESHNESS_SWEEP / invalid SHA-256 / mismatched requestId receipt fail.
      await expect(
        schema.db.cutoverFreshnessResetAudit.create({
          data: { ...buildPreparedInput({ ...seed, cutoverRunId: randomUUID(), generation: -1 }) },
        }),
      ).rejects.toThrow();
      await expect(
        schema.db.cutoverFreshnessResetAudit.create({
          data: { ...buildPreparedInput({ ...seed, cutoverRunId: randomUUID() }), authorizationEffect: 'RESERVE' },
        }),
      ).rejects.toThrow();

      const badReceipt = buildCompletedEvidence(req1, anchorNowMs);
      await expect(
        schema.db.cutoverFreshnessResetAudit.update({
          where: { id: row.id },
          data: { ...badReceipt, redisReceiptHash: '0'.repeat(64) },
        }),
      ).rejects.toThrow();

      const mismatchedJsonReceipt = JSON.stringify({ requestId: randomUUID(), version: 1 });
      await expect(
        schema.db.cutoverFreshnessResetAudit.update({
          where: { id: row.id },
          data: {
            ...badReceipt,
            redisReceipt: mismatchedJsonReceipt,
            redisReceiptHash: createHash('sha256').update(mismatchedJsonReceipt, 'utf8').digest('hex'),
          },
        }),
      ).rejects.toThrow();

      // Bounded lease violation (exceeds +3600s) rejected.
      await expect(
        schema.db.cutoverFreshnessResetAudit.update({
          where: { id: row.id },
          data: { ...badReceipt, newAbsoluteExpiresAtMs: BigInt(anchorNowMs + 3_600_001) },
        }),
      ).rejects.toThrow();

      // Complete validly, then prove COMPLETED cannot reset to PREPARED, flip to ABORTED, or rewrite any field.
      const done = await schema.db.cutoverFreshnessResetAudit.update({
        where: { id: row.id },
        data: buildCompletedEvidence(req1, anchorNowMs),
      });
      await expect(schema.db.cutoverFreshnessResetAudit.update({ where: { id: done.id }, data: { status: 'PREPARED', completedAt: null } })).rejects.toThrow();
      await expect(schema.db.cutoverFreshnessResetAudit.update({ where: { id: done.id }, data: { status: 'ABORTED', failureCode: 'TAMPER' } })).rejects.toThrow();
      await expect(
        schema.db.$executeRaw`UPDATE cutover_freshness_resets SET "quantity" = 999 WHERE id = ${done.id}::uuid`,
      ).rejects.toThrow();
      await expect(
        schema.db.$executeRaw`UPDATE cutover_freshness_resets SET "newExpiresAtMs" = ${BigInt(anchorNowMs + 1000)} WHERE id = ${done.id}::uuid`,
      ).rejects.toThrow();

      // Restricted product and non-MIRROR mode preconditions reject new PREPARED inserts.
      await schema.db.$executeRaw`
        INSERT INTO reservation_product_restrictions (id, "productId", "reasonCategory", "observationDigest")
        VALUES (${randomUUID()}::uuid, ${seed.productId}, 'ACCOUNTING_DRIFT'::"ProductReservationRestrictionReason", ${'a'.repeat(64)})
      `;
      await expect(
        schema.db.cutoverFreshnessResetAudit.create({
          data: buildPreparedInput({ ...seed, cutoverRunId: randomUUID() }),
        }),
      ).rejects.toThrow();
    } finally {
      await schema.close();
    }
  });

  it('prevents DELETE, TRUNCATE (direct or CASCADE), and cascade deletion via cart/user/operator/product removal', async () => {
    const schema = await openOrdinarySchema(67);
    try {
      const seed = await seedFreshnessAuditPrerequisites(schema.db);
      const reqId = randomUUID();
      const anchorNowMs = Date.now();
      const row = await schema.db.cutoverFreshnessResetAudit.create({ data: buildPreparedInput(seed, reqId, anchorNowMs) });
      await schema.db.cutoverFreshnessResetAudit.update({ where: { id: row.id }, data: buildCompletedEvidence(reqId, anchorNowMs) });

      await expect(schema.db.cutoverFreshnessResetAudit.delete({ where: { id: row.id } })).rejects.toThrow();
      await expect(schema.db.$executeRaw`TRUNCATE TABLE cutover_freshness_resets`).rejects.toThrow();
      await expect(schema.db.$executeRaw`TRUNCATE TABLE carts CASCADE`).rejects.toThrow();
      await expect(schema.db.$executeRaw`TRUNCATE TABLE users CASCADE`).rejects.toThrow();

      // User deletion (both operator and customer) & cart/marker/product deletions are blocked by ON DELETE RESTRICT.
      await expect(schema.db.user.delete({ where: { id: seed.operatorId } })).rejects.toThrow();
      await expect(schema.db.user.delete({ where: { id: seed.customerId } })).rejects.toThrow();
      await expect(schema.db.cart.delete({ where: { id: seed.cartId } })).rejects.toThrow();
      await expect(schema.db.cartReservationSyncState.delete({ where: { id: seed.markerId } })).rejects.toThrow();
      await expect(schema.db.product.delete({ where: { id: seed.productId } })).rejects.toThrow();

      // Removing a CartItem AFTER completion remains allowed (no FK on cart_items) and leaves audit intact.
      await schema.db.cartItem.deleteMany({ where: { cartId: seed.cartId, productId: seed.productId } });
      expect(await schema.db.cutoverFreshnessResetAudit.count({ where: { id: row.id } })).toBe(1);
    } finally {
      await schema.close();
    }
  });

  it('serializes concurrent inserts & terminal transitions safely and proves incomplete PREPARED never mutates inventory', async () => {
    const schema = await openOrdinarySchema(67);
    const secondClient = schema.fresh();
    await secondClient.$connect();
    try {
      const seed = await seedFreshnessAuditPrerequisites(schema.db);
      const anchorNowMs = Date.now();

      // Concurrent INSERT race for identical (cutoverRunId, barrierRevision, markerId, generation)
      const [insA, insB] = await Promise.allSettled([
        schema.db.cutoverFreshnessResetAudit.create({ data: buildPreparedInput(seed, randomUUID(), anchorNowMs) }),
        secondClient.cutoverFreshnessResetAudit.create({ data: buildPreparedInput(seed, randomUUID(), anchorNowMs) }),
      ]);
      const insFulfilled = [insA, insB].filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof schema.db.cutoverFreshnessResetAudit.create>>> => r.status === 'fulfilled');
      const insRejected = [insA, insB].filter((r): r is PromiseRejectedResult => r.status === 'rejected');
      expect(insFulfilled).toHaveLength(1);
      expect(insRejected).toHaveLength(1);
      expect(String((insRejected[0]!.reason as Prisma.PrismaClientKnownRequestError).code)).toBe('P2002');

      const preparedRow = insFulfilled[0]!.value;
      expect(preparedRow.status).toBe('PREPARED');

      // Concurrent UPDATE race: one tries COMPLETED, one tries ABORTED -> exactly one wins, second rejects.
      const [updA, updB] = await Promise.allSettled([
        schema.db.cutoverFreshnessResetAudit.update({
          where: { id: preparedRow.id },
          data: buildCompletedEvidence(preparedRow.requestId, anchorNowMs),
        }),
        secondClient.cutoverFreshnessResetAudit.update({
          where: { id: preparedRow.id },
          data: { status: 'ABORTED', failureCode: 'CONCURRENT_ABORT', failureDetail: 'Concurrent abort lost/won race' },
        }),
      ]);
      const updFulfilled = [updA, updB].filter((r) => r.status === 'fulfilled');
      const updRejected = [updA, updB].filter((r) => r.status === 'rejected');
      expect(updFulfilled).toHaveLength(1);
      expect(updRejected).toHaveLength(1);

      const finalRow = await schema.db.cutoverFreshnessResetAudit.findUniqueOrThrow({ where: { id: preparedRow.id } });
      expect(['COMPLETED', 'ABORTED']).toContain(finalRow.status);

      // Creating an incomplete PREPARED row for a new run never mutates CartItem/marker/fence.
      const secondRun = { ...seed, cutoverRunId: randomUUID() };
      const incomplete = await schema.db.cutoverFreshnessResetAudit.create({ data: buildPreparedInput(secondRun, randomUUID(), anchorNowMs) });
      expect(incomplete.status).toBe('PREPARED');
      expect(await schema.db.cartItem.findUniqueOrThrow({ where: { cartId_productId: { cartId: seed.cartId, productId: seed.productId } } }))
        .toMatchObject({ quantity: seed.quantity });
    } finally {
      await secondClient.$disconnect();
      await schema.close();
    }
  });
});
