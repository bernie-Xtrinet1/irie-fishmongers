import { ProductReservationRestrictionReason } from '@prisma/client';
import { PrismaService } from '../../../database/prisma.service';
import { RedisService } from '../../../common/redis/redis.service';
import { InventoryReservationsService } from '../../inventory/services/inventory-reservations.service';
import { UUID_PATTERN } from '../types/reservation-fence.types';
import { ProductRestrictionAdmission, RestrictionObservationBinding, restrictionDigest } from '../types/product-reservation-restriction.types';

// Inactive. Uses existing read-only observation, not the mutating reconciler.
export class ProductReservationRestrictionAdmissionService {
  readonly #admissions = new WeakMap<object, RestrictionObservationBinding>();
  readonly #observer: InventoryReservationsService;
  constructor(private readonly prisma: PrismaService, redis: RedisService) {
    this.#observer = new InventoryReservationsService(redis);
  }

  async observe(markerId: string): Promise<ProductRestrictionAdmission | null> {
    if (!UUID_PATTERN.test(markerId)) return null;
    try {
      const marker = await this.prisma.cartReservationSyncState.findUnique({ where: { id: markerId } });
      if (!marker) return null;
      const observed = await this.#observer.getActiveReservation(marker.cartId, marker.productId);
      const accounting = await this.#observer.getReservedTotalExcludingCart(marker.productId, marker.cartId);
      const after = await this.prisma.cartReservationSyncState.findUnique({ where: { id: markerId } });
      if (!after || after.generation !== marker.generation || after.expectedQuantity !== marker.expectedQuantity) return null;
      let reasonCategory: ProductReservationRestrictionReason;
      if (observed.status === 'MALFORMED' || observed.status === 'UNTRUSTED') reasonCategory = 'MALFORMED_RESOURCE';
      else if (accounting.status === 'SUSPECT') reasonCategory = 'ACCOUNTING_DRIFT';
      else return null; // Absence, expiry and transport errors are not denial authority.
      const evidence = JSON.stringify({ version: 1, productId: marker.productId, markerId,
        generation: marker.generation, observation: observed.status, accounting: accounting.status, reasonCategory });
      const token = Object.freeze({}) as ProductRestrictionAdmission;
      this.#admissions.set(token, { productId: marker.productId, reasonCategory, observationDigest: restrictionDigest(evidence) });
      return token;
    } catch { return null; }
  }

  consume(value: unknown): RestrictionObservationBinding | null {
    if (!value || typeof value !== 'object') return null;
    const binding = this.#admissions.get(value);
    if (!binding) return null;
    this.#admissions.delete(value);
    return { ...binding };
  }
}
