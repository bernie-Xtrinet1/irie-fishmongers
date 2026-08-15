import { Injectable } from '@nestjs/common';
import { Prisma, ReservationEngineMode } from '@prisma/client';

import { InventoryReservationsService } from '../../inventory/services/inventory-reservations.service';
import { RedisService } from '../../../common/redis/redis.service';
import { PrismaService } from '../../../database/prisma.service';
import {
  PrismaClientOrTx,
  ReservationEngineModeConfigRepository,
} from '../repositories/reservation-engine-mode-config.repository';
import {
  ReservationEngineModeSnapshot,
  RollbackVerificationResult,
  SetReservationEngineModeInput,
  SetReservationEngineModeResult,
} from '../types/reservation-engine-mode.types';

const CART_INDEX_KEY_PATTERN = /^inv:reserved:cart-index:\{([^{}]+)\}$/;
const PRODUCT_TOTAL_KEY_PATTERN = /^inv:reserved:product-total:\{([^{}]+)\}$/;

// Every valid (from, to) pair - the state-transition table lives in
// ADR-007 Decision 8; this is its exact code form. No self-loops - a
// same-mode "transition" is INVALID_TRANSITION, not a silent no-op.
const VALID_TRANSITIONS: ReadonlySet<string> = new Set([
  'LEGACY->MIRROR',
  'MIRROR->LEGACY',
  'MIRROR->CART_SCOPED',
  'CART_SCOPED->DRAINING',
  'DRAINING->CART_SCOPED',
  'DRAINING->LEGACY',
]);

// Phase 16A.0-DA, Unit DA.4B (see the DA.4B frozen plan). One lock key,
// referenced by both setMode() (exclusive) and verifyModeRevisionUnchanged
// (shared) - never duplicated as a second hardcoded string literal. Postgres
// advisory locks implement the standard reader-writer pattern: multiple
// shared holders may coexist, but a shared acquisition blocks while an
// exclusive holder is active and vice versa. setMode()'s entire
// read-validate-write sequence already holds this lock exclusively; a
// recovery attempt's terminal resolution holds it shared only long enough
// to re-read and compare the mode identity it chose a write against,
// proving no transition can have committed in between.
const TRANSITION_LOCK_KEY = 'reservation_engine_mode_transition';

// Owns reservation-engine-mode business rules: the state-transition table
// and the DRAINING -> LEGACY rollback-verification gate (see ADR-007
// Decision 8). Never queries prisma.reservationEngineModeConfig.* directly
// - all persistence goes through ReservationEngineModeConfigRepository.
// PrismaService is injected solely to open $transaction (matching
// PriceLockService's precedent) for setMode's advisory-lock-serialized
// read-validate-write sequence. Additive and unwired - nothing calls
// getCurrentMode()/setMode() yet.
@Injectable()
export class ReservationEngineModeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly repository: ReservationEngineModeConfigRepository,
    private readonly redis: RedisService,
    private readonly inventoryReservations: InventoryReservationsService,
  ) {}

  // No config row yet means LEGACY, not an error - deliberately different
  // from MarketplaceConfigService.getCurrentModeConfig()'s throw-if-missing
  // precedent. That precedent is safe because marketplace mode config is
  // always seeded before the app is meaningfully usable; this config has
  // zero callers today and, once Phase C wires one in, "unconfigured" must
  // mean "behave exactly as before" (current, legacy behavior), never a
  // 500 on every cart operation. A plain, lock-free read - only setMode's
  // read-validate-write sequence needs serialization.
  async getCurrentMode(): Promise<ReservationEngineMode> {
    const config = await this.repository.findCurrent();
    return config?.mode ?? 'LEGACY';
  }

  // Phase 16A.0-DA, Unit DA.4B. Same plain, lock-free read as getCurrentMode
  // (this is a best-effort read used to CHOOSE a recovery write, never the
  // terminal fencing check itself - see verifyModeRevisionUnchanged below
  // for that), but also returns the identity that choice was made against,
  // so a caller can later prove nothing changed before treating anything as
  // resolved. The implicit-LEGACY case is a real, comparable identity of
  // its own - see ReservationEngineModeSnapshot's own doc comment.
  async getCurrentModeSnapshot(client: PrismaClientOrTx = this.prisma): Promise<ReservationEngineModeSnapshot> {
    const config = await this.repository.findCurrent(client);
    if (!config) {
      return { mode: 'LEGACY', revisionId: null, revision: null };
    }
    return { mode: config.mode, revisionId: config.id, revision: config.revision };
  }

  // The entire read-validate-(gate-check)-write sequence runs inside one
  // Postgres transaction, serialized by a transaction-scoped advisory
  // lock acquired first (pg_advisory_xact_lock - auto-released at
  // COMMIT/ROLLBACK, no manual unlock bookkeeping). Without this, two
  // concurrent admin calls could both read the same stale "current" mode,
  // both validate their own transition against it, and both succeed -
  // leaving two new rows whose relative "current" status depends on
  // wall-clock createdAt ordering, and letting a transition sequence
  // through that was never actually valid against what became current.
  // With the lock, the second caller is serialized behind the first and
  // re-reads the *new* current mode before its own transition is
  // validated - so a stale, now-invalid intent is correctly rejected
  // rather than blindly applied. Mode changes are rare, deliberate,
  // admin-triggered actions, not a hot path - global serialization is an
  // acceptable cost here.
  async setMode(input: SetReservationEngineModeInput): Promise<SetReservationEngineModeResult> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${TRANSITION_LOCK_KEY}))`;

      const currentConfig = await this.repository.findCurrent(tx);
      const currentMode: ReservationEngineMode = currentConfig?.mode ?? 'LEGACY';
      const { targetMode, updatedById } = input;

      if (!VALID_TRANSITIONS.has(`${currentMode}->${targetMode}`)) {
        return { ok: false, code: 'INVALID_TRANSITION', from: currentMode, to: targetMode };
      }

      if (currentMode === 'DRAINING' && targetMode === 'LEGACY') {
        const verification = await this.verifyRollbackSafe();
        if (!verification.clear) {
          if (verification.structureDriftProductIds.length > 0) {
            return {
              ok: false,
              code: 'ROLLBACK_STRUCTURE_DRIFT',
              structureDriftProductIds: verification.structureDriftProductIds,
            };
          }
          return { ok: false, code: 'ROLLBACK_BLOCKED', outstandingProductIds: verification.outstandingProductIds };
        }
      }

      const created = await this.repository.create({ mode: targetMode, updatedById }, tx);
      return { ok: true, id: created.id, mode: created.mode, createdAt: created.createdAt };
    });
  }

  // Phase 16A.0-DA, Unit DA.4B (see the DA.4B frozen plan's atomic-fencing
  // design). Proves, under the SAME advisory lock key setMode() holds
  // exclusively, that a previously-observed mode identity is still current -
  // the terminal fencing check a recovery attempt must pass before it may
  // ever treat a write as resolved. Takes an externally-managed transaction
  // client (never opens its own): the caller needs the SAME transaction for
  // its own conditional marker-resolution write immediately afterward, so
  // the shared lock acquired here remains held for the rest of that
  // transaction's lifetime - provably preventing any setMode() transition
  // from committing until this transaction ends. Compares the complete
  // identity (both revisionId and revision - see ReservationEngineModeSnapshot's
  // own comment), including the implicit-LEGACY/no-row case symmetrically:
  // { revisionId: null, revision: null } is a real, comparable identity.
  async verifyModeRevisionUnchanged(
    tx: Prisma.TransactionClient,
    expected: Pick<ReservationEngineModeSnapshot, 'revisionId' | 'revision'>,
  ): Promise<boolean> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock_shared(hashtext(${TRANSITION_LOCK_KEY}))`;
    const current = await this.repository.findCurrent(tx);
    const currentRevisionId = current?.id ?? null;
    const currentRevision = current?.revision ?? null;
    return currentRevisionId === expected.revisionId && currentRevision === expected.revision;
  }

  // The DRAINING -> LEGACY gate itself, callable independently of setMode
  // for read-only status checks (e.g. "how close are we to a safe
  // rollback") without attempting a write or acquiring the advisory lock
  // - it never touches Postgres. Checks two independent Redis signals -
  // see ADR-007 Decision 8's "outstanding reservations vs. data-structure
  // drift" distinction. Not a hot path: this is a rare, manually-triggered
  // emergency-rollback gate, not something called per request, so a full
  // keyspace scan is an acceptable cost here.
  async verifyRollbackSafe(): Promise<RollbackVerificationResult> {
    const [nonZeroTotalProductIds, liveIndexProductIds] = await Promise.all([
      this.findProductsWithNonZeroTotal(),
      this.findProductsWithLiveCartIndexReservations(),
    ]);

    const totalsSet = new Set(nonZeroTotalProductIds);
    const liveSet = new Set(liveIndexProductIds);
    const outstandingProductIds: string[] = [];
    const structureDriftProductIds: string[] = [];

    for (const productId of new Set([...totalsSet, ...liveSet])) {
      if (totalsSet.has(productId) && liveSet.has(productId)) {
        outstandingProductIds.push(productId);
      } else {
        structureDriftProductIds.push(productId);
      }
    }

    outstandingProductIds.sort();
    structureDriftProductIds.sort();

    return {
      clear: outstandingProductIds.length === 0 && structureDriftProductIds.length === 0,
      outstandingProductIds,
      structureDriftProductIds,
    };
  }

  // Fast-path signal: does any product's aggregated reserved-total key
  // report a non-zero value? This is the projection reservation-lifecycle.md
  // §7 already documents as capable of OVERCOUNT/UNDERCOUNT drift - one of
  // two independent signals, never trusted alone.
  private async findProductsWithNonZeroTotal(): Promise<string[]> {
    const client = this.redis.getClient();
    const nonZero: string[] = [];
    let cursor = '0';

    do {
      const [nextCursor, keys] = await client.scan(
        cursor,
        'MATCH',
        'inv:reserved:product-total:{*}',
        'COUNT',
        100,
      );
      cursor = nextCursor;
      for (const key of keys) {
        const match = PRODUCT_TOTAL_KEY_PATTERN.exec(key);
        if (!match) {
          continue;
        }
        const value = await client.get(key);
        if (value !== null && Number(value) > 0) {
          nonZero.push(match[1]!);
        }
      }
    } while (cursor !== '0');

    return nonZero;
  }

  // Ground-truth signal: walk the cart-scoped reservation index
  // (inv:reserved:cart-index:{cartId}, per reservation-lifecycle.md §4 -
  // every productId a given cart currently holds a reservation for), and
  // for every (cartId, productId) member, ask
  // InventoryReservationsService.getActiveReservation whether that hold is
  // genuinely still live - reusing the exact same parse/expiry logic every
  // other read path already depends on, rather than re-deriving it here.
  // A stale index member (evicted key, expired entry) is correctly
  // reported as not live. Aggregated by productId (not cartId) so it is
  // directly comparable against findProductsWithNonZeroTotal's per-product
  // signal for drift detection.
  private async findProductsWithLiveCartIndexReservations(): Promise<string[]> {
    const client = this.redis.getClient();
    const liveProductIds = new Set<string>();
    let cursor = '0';

    do {
      const [nextCursor, keys] = await client.scan(
        cursor,
        'MATCH',
        'inv:reserved:cart-index:{*}',
        'COUNT',
        100,
      );
      cursor = nextCursor;
      for (const key of keys) {
        const match = CART_INDEX_KEY_PATTERN.exec(key);
        if (!match) {
          continue;
        }
        const cartId = match[1]!;
        const productIds = await client.smembers(key);
        for (const productId of productIds) {
          if (liveProductIds.has(productId)) {
            continue;
          }
          const active = await this.inventoryReservations.getActiveReservation(cartId, productId);
          if (active) {
            liveProductIds.add(productId);
          }
        }
      }
    } while (cursor !== '0');

    return Array.from(liveProductIds);
  }
}
