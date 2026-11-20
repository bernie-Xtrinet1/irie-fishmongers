import { createHash, randomUUID } from 'crypto';

import { PrismaService } from '../../../database/prisma.service';

export function sha256Hex(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

export async function seedActiveAdminUser(
  db: PrismaService,
  status: 'ACTIVE' | 'SUSPENDED' = 'ACTIVE',
) {
  const role = await db.role.upsert({
    where: { name: 'ADMINISTRATOR' },
    update: {},
    create: { name: 'ADMINISTRATOR' },
  });
  const user = await db.user.create({
    data: {
      email: `recovery-admin-${randomUUID()}@example.com`,
      passwordHash: 'hashed',
      firstName: 'Ada',
      lastName: 'Min',
      status,
    },
  });
  await db.userRole.create({ data: { userId: user.id, roleId: role.id } });
  return user;
}

export function buildRecoveryRequestData(params: {
  productId: string;
  restrictionId: string | null;
  targetRestrictionRevision: number;
  clearedControlRevision: number;
  modeRevision: number;
  fenceTransitionId: string;
  incarnation: string;
  fenceEpoch: number;
  fenceRevision: number;
  requestedById: string;
  observationDigest?: string;
  requestReason?: string;
  priorStoredTotal?: number | null;
  targetReconciledTotal?: number;
  priorSuspectPresent?: boolean;
}) {
  return {
    id: randomUUID(),
    requestId: randomUUID(),
    productId: params.productId,
    restrictionId: params.restrictionId,
    targetRestrictionRevision: params.targetRestrictionRevision,
    clearedControlRevision: params.clearedControlRevision,
    modeRevision: params.modeRevision,
    fenceTransitionId: params.fenceTransitionId,
    incarnation: params.incarnation,
    fenceEpoch: params.fenceEpoch,
    fenceRevision: params.fenceRevision,
    authorizationPhase: 'OPEN' as const,
    requestedById: params.requestedById,
    requestReason: params.requestReason ?? 'AUDIT_PRODUCT_SUSPECT',
    observationDigest: params.observationDigest ?? 'c'.repeat(64),
    reconciliationSnapshot: { targetTotal: params.targetReconciledTotal ?? 2, driftAfter: 0 },
    reconciliationDigest: 'e'.repeat(64),
    priorStoredTotal: params.priorStoredTotal === undefined ? 1 : params.priorStoredTotal,
    targetReconciledTotal: params.targetReconciledTotal ?? 2,
    priorSuspectPresent: params.priorSuspectPresent ?? true,
  };
}
