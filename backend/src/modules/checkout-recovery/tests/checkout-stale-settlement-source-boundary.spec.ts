import { readFileSync, readdirSync, existsSync } from 'fs';
import { join, resolve } from 'path';
import { PrismaService } from '../../../database/prisma.service';
import { CheckoutRecoverySettlementRepository } from '../repositories/checkout-recovery-settlement.repository';
import { CheckoutRecoveryAcquisitionEvidenceService } from '../services/checkout-recovery-acquisition-evidence.service';
import { ReservationFenceRepository } from '../../reservation-fence/repositories/reservation-fence.repository';
import { CheckoutSettlementRepository } from '../../reservation-fence/repositories/checkout-settlement.repository';
import { unitManifest } from './checkout-stale-settlement-test-helpers';

describe('Slice B authority and source boundary', () => {
  it('production has no raw revert method/script/caller or historical fixture import', () => {
    const root = resolve(__dirname, '../../..');
    const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(e =>
      e.isDirectory() ? files(join(dir, e.name)) : e.name.endsWith('.ts') && !e.name.includes('.spec.') &&
        !e.name.includes('test-helper') ? [join(dir, e.name)] : []);
    const offenders = files(root).filter(p => /(?:\.checkoutRevert\s*\(|async checkoutRevert\s*\(|historical-checkout-revert|CHECKOUT_REVERT_SCRIPT)/.test(readFileSync(p, 'utf8')));
    expect(offenders).toEqual([]);
    expect(existsSync(resolve(__dirname, '../../inventory/lua/checkout-revert-lua-scripts.ts'))).toBe(false);
  });
  it('worker cannot infer authority from G.PR0 or W3-O and never recaptures a cart', () => {
    const worker = readFileSync(resolve(__dirname, '../services/checkout-recovery-worker.service.ts'), 'utf8');
    expect(worker).not.toMatch(/findFencedCleanupPage|CheckoutAttemptStaleFencingService|CheckoutRollout|W3Observation|\.prepare\(/);
    expect(worker).toContain('authorizeStaleRecoverySettlement');
    const wiring = readFileSync(resolve(__dirname, '../checkout-recovery.module.ts'), 'utf8');
    expect(wiring).not.toMatch(/CheckoutModule|CheckoutDispatchModule|OrdersModule|PaymentsModule|ReservationFenceModule/);
  });
  it.each(['missing', 'unsealed', 'empty-resources', 'bad-hold', 'bad-quantity', 'bad-generation',
    'null-operation-E', 'null-attempt-E', 'wrong-E', 'wrong-cart', 'wrong-customer', 'wrong-key',
    'LEGACY', 'NULL-path', 'bad-capture-I', 'FAILED-only', 'FROZEN', 'RETIRED', 'changed-I', 'changed-E', 'changed-mode-R'])
  ('%s cannot create stale authority', async kind => {
    const m = unitManifest(); m.state = 'ACQUIRED'; m.effect = null; m.settlementReplayId = null;
    m.attempt.status = 'PROCESSING'; m.attempt.failureCode = null;
    if (kind === 'unsealed') m.sealed = false;
    if (kind === 'empty-resources') m.resources = [];
    if (kind === 'bad-hold') m.resources[0]!.holdInstanceId = m.id;
    if (kind === 'bad-quantity') m.resources[0]!.quantity = 0;
    if (kind === 'bad-generation') m.resources[0]!.generation = -1;
    if (kind === 'null-operation-E') m.operation.reservationExecutionEpoch = null;
    if (kind === 'null-attempt-E') m.attempt.reservationExecutionEpoch = null;
    if (kind === 'wrong-E') m.attempt.reservationExecutionEpoch = 2;
    if (kind === 'wrong-cart') m.attempt.cartId = 'other';
    if (kind === 'wrong-customer') m.attempt.customerId = 'other';
    if (kind === 'wrong-key') m.attempt.idempotencyKey = 'other';
    if (kind === 'LEGACY') m.attempt.selectedPath = 'LEGACY';
    if (kind === 'NULL-path') m.attempt.selectedPath = null;
    if (kind === 'FAILED-only') { m.attempt.status = 'FAILED'; m.attempt.failureCode = 'STALE_RECOVERY_FENCED'; }
    const capture = { status: 'ACKNOWLEDGED', phase: 'OPEN', protocol: 1,
      incarnation: kind === 'bad-capture-I' ? 'other' : m.incarnation, epoch: 1 };
    const current = { ...capture, phase: ['FROZEN', 'RETIRED'].includes(kind) ? kind : 'OPEN',
      incarnation: kind === 'changed-I' ? 'other' : capture.incarnation, epoch: kind === 'changed-E' ? 2 : 1,
      mode: 'CART_SCOPED', modeRevision: kind === 'changed-mode-R' ? 2 : 1 };
    const tx = { $queryRaw: jest.fn(), checkoutReservationSettlement: { findUnique: jest.fn().mockResolvedValue(kind === 'missing' ? null : m) },
      reservationFenceTransition: { findUnique: jest.fn().mockResolvedValue(capture) }, checkoutAttempt: { updateMany: jest.fn() } };
    const fences = { locked: jest.fn((work: (client: typeof tx) => Promise<unknown>) => work(tx)),
      latest: jest.fn().mockResolvedValue(current), mode: jest.fn().mockResolvedValue({ mode: 'CART_SCOPED', modeRevision: 1 }) };
    const manifests = { find: jest.fn().mockResolvedValue(m), markRevertPending: jest.fn() };
    const evidence = { provePreparedAcquired: jest.fn() };
    const repo = new CheckoutRecoverySettlementRepository({} as PrismaService, fences as unknown as ReservationFenceRepository,
      manifests as unknown as CheckoutSettlementRepository, evidence as unknown as CheckoutRecoveryAcquisitionEvidenceService);
    expect(await repo.authorizeStaleRecoverySettlement({ attemptId: m.attemptId, customerId: m.operation.customerId,
      observedHeartbeatAt: new Date(0), staleBefore: new Date(1000), observedAt: new Date(2000) })).toEqual({ code: 'DEFERRED' });
    expect(tx.checkoutAttempt.updateMany).not.toHaveBeenCalled(); expect(manifests.markRevertPending).not.toHaveBeenCalled();
    expect(evidence.provePreparedAcquired).not.toHaveBeenCalled();
  });
});
