import { randomUUID } from 'crypto';
import { PrismaService } from '../../../database/prisma.service';
import { RedisService } from '../../../common/redis/redis.service';
import {
  findActiveProductRestriction,
  nextOddRestrictionRevision,
} from '../repositories/product-reservation-restriction.repository';
import { ReservationFenceRepository, transitionTuple } from '../repositories/reservation-fence.repository';
import { PRODUCT_CONTROL_INSTALL } from '../lua/product-reservation-restriction.lua';
import { RESERVATION_FENCE_KEY } from '../lua/reservation-fence-control.lua';
import { controlBytes, productControlKey, restrictionDigest } from '../types/product-reservation-restriction.types';
import { ProductReservationRestrictionAdmissionService } from './product-reservation-restriction-admission.service';
import { legalPair, UUID_PATTERN } from '../types/reservation-fence.types';

// Inactive; no module/provider/worker wiring or reopening API.
export class ProductReservationRestrictionService {
  private readonly fences: ReservationFenceRepository;
  constructor(private readonly prisma: PrismaService, private readonly redis: RedisService,
    private readonly admission: ProductReservationRestrictionAdmissionService) {
    this.fences = new ReservationFenceRepository(prisma);
  }

  async prepare(token: unknown) {
    let binding;
    try { binding = ProductReservationRestrictionAdmissionService.prototype.consume.call(this.admission, token); }
    catch { return null; }
    if (!binding) return null;
    const id = randomUUID();
    try {
      return await this.fences.locked(async tx => {
        await tx.product.findUniqueOrThrow({ where: { id: binding.productId }, select: { id: true } });
        const existing = await findActiveProductRestriction(tx, binding.productId);
        if (existing) return existing;
        const restrictionRevision = await nextOddRestrictionRevision(tx, binding.productId);
        return tx.productReservationRestriction.create({ data: { id, ...binding, restrictionRevision } });
      });
    } catch {
      // Reload only. Never create another identity after an ambiguous COMMIT.
      try { return await this.fences.locked(tx => findActiveProductRestriction(tx, binding.productId)); }
      catch { return null; }
    }
  }

  async install(id: string): Promise<'ENFORCED' | 'UNRESOLVED'> {
    if (!UUID_PATTERN.test(id)) return 'UNRESOLVED';
    try {
      return await this.fences.locked(async tx => {
        const restriction = await tx.productReservationRestriction.findUniqueOrThrow({ where: { id } });
        if (restriction.state !== 'PREPARED' && restriction.state !== 'ENFORCED') return 'UNRESOLVED';
        const latestCleared = await tx.productSuspectRecovery.findFirst({
          where: { productId: restriction.productId, status: 'COMPLETED' },
          orderBy: { clearedControlRevision: 'desc' },
          select: { clearedControlRevision: true },
        });
        if (latestCleared && restriction.restrictionRevision <= latestCleared.clearedControlRevision) {
          return 'UNRESOLVED';
        }
        const fence = await this.fences.latest(tx);
        const mode = await this.fences.mode(tx);
        if (!fence || fence.status !== 'ACKNOWLEDGED' || fence.protocol !== 1 ||
          fence.mode !== mode.mode || fence.modeRevision !== mode.modeRevision ||
          !legalPair(mode.mode, fence.phase, true)) return 'UNRESOLVED';
        const bytes = controlBytes({ version: 1, productId: restriction.productId, state: 'RESTRICTED',
          restrictionId: id, restrictionRevision: restriction.restrictionRevision, incarnation: fence.incarnation, epoch: fence.epoch });
        const raw = await this.redis.eval(PRODUCT_CONTROL_INSTALL, [RESERVATION_FENCE_KEY, productControlKey(restriction.productId)],
          [JSON.stringify(transitionTuple(fence)), bytes]);
        if (typeof raw !== 'string') return 'UNRESOLVED';
        const result: unknown = JSON.parse(raw);
        if (!result || typeof result !== 'object' || !('code' in result) || result.code !== 'ACCEPTED' ||
          !('value' in result) || result.value !== bytes) return 'UNRESOLVED';
        const key = { restrictionId: id, incarnation: fence.incarnation, epoch: fence.epoch, protocolVersion: 1 };
        const old = await tx.productReservationRestrictionInstallation.findUnique({ where: { restrictionId_incarnation_epoch_protocolVersion: key } });
        if (old && (old.acknowledgement !== bytes || old.acknowledgementHash !== restrictionDigest(bytes))) return 'UNRESOLVED';
        if (!old) await tx.productReservationRestrictionInstallation.create({ data: { ...key,
          acknowledgement: bytes, acknowledgementHash: restrictionDigest(bytes) } });
        if (restriction.state === 'PREPARED') await tx.productReservationRestriction.update({ where: { id },
          data: { state: 'ENFORCED', firstEnforcedAt: new Date() } });
        return 'ENFORCED';
      });
    } catch { return 'UNRESOLVED'; }
  }
}
