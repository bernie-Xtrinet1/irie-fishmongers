import { PrismaService } from '../../../database/prisma.service';
import { OrdinaryCommandDispatchClaimRepository } from '../repositories/ordinary-command-dispatch-claim.repository';
import {
  currentAllowedControlRevision,
  nextOddRestrictionRevision,
  requireUnrestrictedProduct,
} from '../repositories/product-reservation-restriction.repository';
import { openOrdinarySchema, ordinaryFixture, ordinaryReleaseFixture } from './ordinary-provenance-test-helpers';
import { buildRecoveryRequestData, seedActiveAdminUser, sha256Hex } from './product-suspect-recovery-test-helpers';
import { OrdinaryReleaseService } from '../services/ordinary-release.service';
import { OrdinaryDispatchIdentity } from '../types/ordinary-command-dispatch-claim.types';
import { randomUUID } from 'crypto';

describe('Migration #68 product-suspect recovery schema & upgrade (PostgreSQL only)', () => {
  jest.setTimeout(120000);
  let schema: Awaited<ReturnType<typeof openOrdinarySchema>> | undefined;

  afterEach(async () => {
    if (schema) {
      const closing = schema;
      schema = undefined;
      await closing.close();
    }
  });

  async function installEnforcedRestriction(
    db: PrismaService,
    productId: string,
    incarnation: string,
    epoch: number,
    revision: number,
    digest: string,
  ) {
    const row = await db.productReservationRestriction.create({
      data: { productId, restrictionRevision: revision, reasonCategory: 'ACCOUNTING_DRIFT', observationDigest: digest },
    });
    const ack = JSON.stringify({
      version: 1,
      productId,
      state: 'RESTRICTED',
      restrictionId: row.id,
      restrictionRevision: revision,
      incarnation,
      epoch,
    });
    await db.productReservationRestrictionInstallation.create({
      data: {
        restrictionId: row.id,
        incarnation,
        epoch,
        protocolVersion: 1,
        acknowledgement: ack,
        acknowledgementHash: sha256Hex(ack),
      },
    });
    return db.productReservationRestriction.update({
      where: { id: row.id },
      data: { state: 'ENFORCED', firstEnforcedAt: new Date() },
    });
  }

  it('67 -> 68 upgrade preserves existing PREPARED and ENFORCED restrictions without auto-clearing', async () => {
    schema = await openOrdinarySchema(67);
    const db = schema.db;
    const admin = await seedActiveAdminUser(db);
    const vendorRole = await db.role.upsert({ where: { name: 'VENDOR' }, update: {}, create: { name: 'VENDOR' } });
    const custRole = await db.role.upsert({ where: { name: 'CUSTOMER' }, update: {}, create: { name: 'CUSTOMER' } });
    const vUser = await db.user.create({ data: { email: `v67-${randomUUID()}@ex.com`, passwordHash: 'x', firstName: 'V', lastName: 'U', status: 'ACTIVE', roles: { create: { roleId: vendorRole.id } } } });
    const cUser = await db.user.create({ data: { email: `c67-${randomUUID()}@ex.com`, passwordHash: 'x', firstName: 'C', lastName: 'U', status: 'ACTIVE', roles: { create: { roleId: custRole.id } } } });
    const vendor = await db.vendor.create({ data: { userId: vUser.id, businessName: 'Upgrade Co', parish: 'KINGSTON', termsAcceptedAt: new Date() } });
    const cat = await db.category.create({ data: { name: `UpgCat ${randomUUID()}`, slug: `upg-${randomUUID()}` } });
    const cart = await db.cart.create({ data: { customerId: cUser.id } });
    const prodAId = randomUUID();
    const prodBId = randomUUID();
    for (const prodId of [prodAId, prodBId]) {
      await db.$executeRawUnsafe(
        `INSERT INTO "products" ("id","vendorId","categoryId","name","description","unit","price","quantityAvailable","imageUrl","updatedAt") VALUES ($1,$2,$3,'Snapper','Fresh','PER_POUND'::"ProductUnit",500,10,'https://x.com/a.jpg',now())`,
        prodId, vendor.id, cat.id,
      );
    }
    const mode = await db.reservationEngineModeConfig.create({ data: { mode: 'CART_SCOPED', updatedById: cUser.id } });
    const inc = randomUUID();
    await db.reservationFenceTransition.create({
      data: { incarnation: inc, epoch: 1, revision: mode.revision, phase: 'OPEN', protocol: 1, mode: 'CART_SCOPED', modeRevision: mode.revision, status: 'ACKNOWLEDGED', acknowledgedAt: new Date(), reason: 'OPEN', actorId: admin.id },
    });

    const restAId = randomUUID();
    const restBId = randomUUID();
    await db.$executeRawUnsafe(
      `INSERT INTO "reservation_product_restrictions" ("id","productId","restrictionRevision","reasonCategory","observationDigest","state","physicalProtocolVersion") VALUES ($1::uuid,$2,1,'ACCOUNTING_DRIFT'::"ProductReservationRestrictionReason",$3,'PREPARED'::"ProductReservationRestrictionState",1)`,
      restAId, prodAId, 'a'.repeat(64),
    );
    await db.$executeRawUnsafe(
      `INSERT INTO "reservation_product_restrictions" ("id","productId","restrictionRevision","reasonCategory","observationDigest","state","physicalProtocolVersion") VALUES ($1::uuid,$2,1,'MALFORMED_RESOURCE'::"ProductReservationRestrictionReason",$3,'PREPARED'::"ProductReservationRestrictionState",1)`,
      restBId, prodBId, 'b'.repeat(64),
    );
    const ackB = JSON.stringify({ version: 1, productId: prodBId, state: 'RESTRICTED', restrictionId: restBId, restrictionRevision: 1, incarnation: inc, epoch: 1 });
    await db.$executeRawUnsafe(
      `INSERT INTO "reservation_product_restriction_installations" ("restrictionId","incarnation","epoch","protocolVersion","acknowledgement","acknowledgementHash") VALUES ($1::uuid,$2::uuid,1,1,$3,$4)`,
      restBId, inc, ackB, sha256Hex(ackB),
    );
    await db.$executeRawUnsafe(
      `UPDATE "reservation_product_restrictions" SET "state" = 'ENFORCED'::"ProductReservationRestrictionState", "firstEnforcedAt" = now() WHERE "id" = $1::uuid`,
      restBId,
    );
    const markerBId = randomUUID();
    await db.$executeRawUnsafe(
      `INSERT INTO "cart_reservation_sync_states" ("id","cartId","productId","expectedMutationVersion","expectedQuantity","status","blockReason","nextAttemptAt","updatedAt") VALUES ($1,$2,$3,0,2,'BLOCKED'::"CartReservationSyncStatus",'PRODUCT_SUSPECT'::"CartReservationSyncBlockReason",now() + interval '60 seconds',now())`,
      markerBId, cart.id, prodBId,
    );
    await db.$executeRawUnsafe(
      `INSERT INTO "cart_reservation_compensations" ("id","schemaVersion","operation","status","blockReason","cartId","productId","customerId","desiredQuantity","reasonCode","lastError","nextAttemptAt","updatedAt") VALUES ($1,1,'RESERVE_MIRROR'::"CompensationOperation",'BLOCKED'::"CompensationStatus",'PRODUCT_SUSPECT'::"CompensationBlockReason",$2,$3,$4,2,'PRODUCT_SUSPENDED'::"CompensationReasonCode",'PRODUCT_SUSPENDED',now() + interval '60 seconds',now())`,
      randomUUID(), cart.id, prodBId, cUser.id,
    );

    schema.upgrade();

    const postA = await db.productReservationRestriction.findUniqueOrThrow({ where: { id: restAId } });
    const postB = await db.productReservationRestriction.findUniqueOrThrow({ where: { id: restBId } });
    expect(postA).toMatchObject({ state: 'PREPARED', restrictionRevision: 1, clearedAt: null, clearedByRecoveryId: null });
    expect(postB).toMatchObject({ state: 'ENFORCED', restrictionRevision: 1, clearedAt: null, clearedByRecoveryId: null });
    expect(await db.productSuspectRecovery.count()).toBe(0);
    await expect(db.$transaction((tx) => requireUnrestrictedProduct(tx, prodAId))).rejects.toThrow('PRODUCT_RESERVATION_RESTRICTED');
    await expect(db.$transaction((tx) => requireUnrestrictedProduct(tx, prodBId))).rejects.toThrow('PRODUCT_RESERVATION_RESTRICTED');

    const blockedSync = await db.cartReservationSyncState.findUniqueOrThrow({ where: { id: markerBId } });
    expect(blockedSync).toMatchObject({ status: 'BLOCKED', blockReason: 'PRODUCT_SUSPECT' });
    expect(await db.productReservationRestriction.count({ where: { state: 'CLEARED' } })).toBe(0);
  });

  it('enforces dual-control, role, state-machine, receipt, quarantine, and monotonic odd/even revisions (1 -> 2 -> 3 -> 4)', async () => {
    schema = await openOrdinarySchema(68);
    const db = schema.db;
    const f = await ordinaryFixture(db);
    const modeRevision = f.transition.modeRevision ?? 1;
    const adminA = await seedActiveAdminUser(db, 'ACTIVE');
    const adminB = await seedActiveAdminUser(db, 'ACTIVE');
    const adminSuspended = await seedActiveAdminUser(db, 'SUSPENDED');

    const r1 = await installEnforcedRestriction(db, f.productId, f.transition.incarnation, f.transition.epoch, 1, 'c'.repeat(64));

    await expect(
      db.productReservationRestriction.create({
        data: { productId: f.productId, restrictionRevision: 3, reasonCategory: 'ACCOUNTING_DRIFT', observationDigest: 'd'.repeat(64) },
      }),
    ).rejects.toThrow();

    const mkReq = (overrides: Record<string, unknown> = {}) => ({
      ...buildRecoveryRequestData({
        productId: f.productId,
        restrictionId: r1.id,
        targetRestrictionRevision: 1,
        clearedControlRevision: 2,
        modeRevision,
        fenceTransitionId: f.transition.id,
        incarnation: f.transition.incarnation,
        fenceEpoch: f.transition.epoch,
        fenceRevision: f.transition.revision,
        requestedById: adminA.id,
      }),
      ...overrides,
    });

    await expect(db.productSuspectRecovery.create({ data: mkReq({ requestedById: f.customerId }) })).rejects.toThrow();
    await expect(db.productSuspectRecovery.create({ data: mkReq({ requestedById: adminSuspended.id }) })).rejects.toThrow();
    await expect(db.productSuspectRecovery.create({ data: mkReq({ status: 'COMPLETED' }) })).rejects.toThrow();
    await expect(db.productSuspectRecovery.create({ data: mkReq({ clearedControlRevision: 3 }) })).rejects.toThrow();

    const rec1 = await db.productSuspectRecovery.create({ data: mkReq() });
    const now = new Date();
    const later = new Date(now.getTime() + 600_000);

    await expect(
      db.productSuspectRecovery.update({
        where: { id: rec1.id },
        data: { status: 'APPROVED', approvedById: adminA.id, approvedAt: now, approvalExpiresAt: later, approvalDigest: 'f'.repeat(64) },
      }),
    ).rejects.toThrow();
    await expect(
      db.productSuspectRecovery.update({
        where: { id: rec1.id },
        data: { status: 'APPROVED', approvedById: adminSuspended.id, approvedAt: now, approvalExpiresAt: later, approvalDigest: 'f'.repeat(64) },
      }),
    ).rejects.toThrow();
    await expect(
      db.productSuspectRecovery.update({
        where: { id: rec1.id },
        data: { status: 'APPROVED', approvedById: f.customerId, approvedAt: now, approvalExpiresAt: later, approvalDigest: 'f'.repeat(64) },
      }),
    ).rejects.toThrow();
    await expect(db.productSuspectRecovery.create({ data: mkReq() })).rejects.toThrow();

    await db.productSuspectRecovery.update({
      where: { id: rec1.id },
      data: { status: 'APPROVED', approvedById: adminB.id, approvedAt: now, approvalExpiresAt: later, approvalDigest: 'f'.repeat(64) },
    });

    const receipt1 = JSON.stringify({ requestId: rec1.requestId, productId: f.productId, status: 'APPLIED', targetTotal: 2 });
    await expect(
      db.productSuspectRecovery.update({
        where: { id: rec1.id },
        data: {
          status: 'COMPLETED', executionEvidence: 'APPLIED', evidenceEvaluatedAt: now,
          redisReceipt: receipt1, redisReceiptHash: sha256Hex(receipt1), completedAt: later,
        },
      }),
    ).rejects.toThrow();

    const execAt = new Date(now.getTime() + 5000);
    await db.productSuspectRecovery.update({
      where: { id: rec1.id },
      data: { status: 'EXECUTING', executingAt: execAt, stagedControlRevision: 1 },
    });
    await db.productReservationRestriction.update({
      where: { id: r1.id },
      data: { state: 'CLEARING', clearedByRecoveryId: rec1.id },
    });

    await expect(
      db.productSuspectRecovery.update({
        where: { id: rec1.id },
        data: {
          status: 'COMPLETED', executionEvidence: 'NOT_APPLIED', evidenceEvaluatedAt: execAt,
          redisReceipt: receipt1, redisReceiptHash: sha256Hex(receipt1), completedAt: later,
        },
      }),
    ).rejects.toThrow();
    await expect(
      db.productSuspectRecovery.update({
        where: { id: rec1.id },
        data: { status: 'ABORTED', executionEvidence: 'AMBIGUOUS', failureCode: 'BAD' },
      }),
    ).rejects.toThrow();

    await db.productSuspectRecovery.update({
      where: { id: rec1.id },
      data: {
        status: 'COMPLETED', executionEvidence: 'APPLIED', evidenceEvaluatedAt: later,
        redisReceipt: receipt1, redisReceiptHash: sha256Hex(receipt1), completedAt: later,
      },
    });
    await db.productReservationRestriction.update({
      where: { id: r1.id },
      data: { state: 'CLEARED', clearedAt: later },
    });

    await expect(db.productSuspectRecovery.update({ where: { id: rec1.id }, data: { requestReason: 'TAMPER' } })).rejects.toThrow();
    await expect(db.productSuspectRecovery.delete({ where: { id: rec1.id } })).rejects.toThrow();
    await expect(db.productReservationRestriction.update({ where: { id: r1.id }, data: { state: 'ENFORCED' } })).rejects.toThrow();
    await expect(db.productReservationRestriction.delete({ where: { id: r1.id } })).rejects.toThrow();

    expect(await db.$transaction((tx) => currentAllowedControlRevision(tx, f.productId))).toBe(2);
    expect(await db.$transaction((tx) => nextOddRestrictionRevision(tx, f.productId))).toBe(3);
    await expect(
      db.productReservationRestriction.create({
        data: { productId: f.productId, restrictionRevision: 1, reasonCategory: 'ACCOUNTING_DRIFT', observationDigest: '1'.repeat(64) },
      }),
    ).rejects.toThrow();
    const r2 = await installEnforcedRestriction(db, f.productId, f.transition.incarnation, f.transition.epoch, 3, '2'.repeat(64));
    expect(await db.productReservationRestriction.count({ where: { productId: f.productId } })).toBe(2);
    expect((await db.productReservationRestriction.findUniqueOrThrow({ where: { id: r1.id } })).state).toBe('CLEARED');

    const rec2 = await db.productSuspectRecovery.create({
      data: mkReq({ restrictionId: r2.id, targetRestrictionRevision: 3, clearedControlRevision: 4 }),
    });
    await db.productSuspectRecovery.update({
      where: { id: rec2.id },
      data: { status: 'APPROVED', approvedById: adminB.id, approvedAt: now, approvalExpiresAt: later, approvalDigest: 'f'.repeat(64) },
    });
    await db.productSuspectRecovery.update({
      where: { id: rec2.id },
      data: { status: 'EXECUTING', executingAt: execAt, stagedControlRevision: 3 },
    });
    await db.productSuspectRecovery.update({
      where: { id: rec2.id },
      data: {
        status: 'AMBIGUOUS_QUARANTINED', executionEvidence: 'AMBIGUOUS',
        evidenceEvaluatedAt: later, quarantinedAt: later, quarantineReason: 'CONTRADICTORY_REDIS_EVIDENCE',
      },
    });
    await expect(
      db.productSuspectRecovery.update({
        where: { id: rec2.id },
        data: { status: 'COMPLETED', executionEvidence: 'APPLIED', redisReceipt: receipt1, redisReceiptHash: sha256Hex(receipt1), completedAt: later },
      }),
    ).rejects.toThrow();
    await expect(db.$transaction((tx) => requireUnrestrictedProduct(tx, f.productId))).rejects.toThrow('PRODUCT_RESERVATION_RESTRICTED');
  });

  it('preserves W2 exact RELEASE under CLEARING restriction and AMBIGUOUS_QUARANTINED recovery', async () => {
    schema = await openOrdinarySchema(68);
    const db = schema.db;
    const f = await ordinaryReleaseFixture(db);
    const adminA = await seedActiveAdminUser(db, 'ACTIVE');
    const adminB = await seedActiveAdminUser(db, 'ACTIVE');
    const rest = await db.productReservationRestriction.create({
      data: { productId: f.productId, reasonCategory: 'ACCOUNTING_DRIFT', observationDigest: '3'.repeat(64) },
    });
    expect(await f.commands.issue(f.issuance, {
      reason: 'CART_INTENT', w1Transition: 'INITIAL', intentGeneration: 0, expectedMutationVersion: 0, authorizedQuantity: 2,
    }).catch(() => null)).toBeNull();

    const now = new Date();
    const later = new Date(now.getTime() + 600_000);
    const rec = await db.productSuspectRecovery.create({
      data: buildRecoveryRequestData({
        productId: f.productId, restrictionId: rest.id, targetRestrictionRevision: 1, clearedControlRevision: 2,
        modeRevision: f.transition.modeRevision ?? 1, fenceTransitionId: f.transition.id,
        incarnation: f.transition.incarnation, fenceEpoch: f.transition.epoch, fenceRevision: f.transition.revision,
        requestedById: adminA.id, requestReason: 'VERIFY_RELEASE_SEPARATION', priorStoredTotal: null,
      }),
    });
    await db.productSuspectRecovery.update({
      where: { id: rec.id },
      data: { status: 'APPROVED', approvedById: adminB.id, approvedAt: now, approvalExpiresAt: later, approvalDigest: '5'.repeat(64) },
    });
    await db.productSuspectRecovery.update({
      where: { id: rec.id },
      data: { status: 'EXECUTING', executingAt: now, stagedControlRevision: 1 },
    });
    await db.productReservationRestriction.update({
      where: { id: rest.id },
      data: { state: 'CLEARING', clearedByRecoveryId: rec.id },
    });

    await f.prepare();
    const rel = new OrdinaryReleaseService(db);
    const pub = await rel.publish(f.request.intentId, { ownerId: f.owner.id, reason: 'CART_REMOVAL' }, f.domain);
    expect(pub.status).toBe('PUBLISHED');
    if (pub.status !== 'PUBLISHED') throw new Error('Expected exact W2 release publication');
    expect((await new OrdinaryCommandDispatchClaimRepository(db).claimRelease(pub.admission, rel)).status)
      .toBe('FIRST_PHYSICAL_DISPATCH_AUTHORIZED');
    const fakeW1: OrdinaryDispatchIdentity = {
      version: 1, commandId: randomUUID(), replayId: randomUUID(), action: 'W1', sequence: 99, expectedSequence: 98,
      mutationVersion: 0, incarnation: f.transition.incarnation, epoch: f.transition.epoch, ownerId: f.owner.id, sourceOwnerId: null,
      target: { customerId: f.customerId, cartId: f.cartId, productId: f.productId, markerId: f.marker.id, generation: 0, holdInstanceId: f.owner.holdInstanceId },
      source: null, transition: 'INITIAL', quantity: 2, parent: null,
    };
    expect(await new OrdinaryCommandDispatchClaimRepository(db).claim(fakeW1, 'EXECUTE_ONLY')).toEqual({ status: 'NOT_AUTHORIZED' });
  });
});
