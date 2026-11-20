import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

export interface ParseMonetaryOptions {
  allowZero?: boolean;
  allowNegative?: boolean;
  onlyNegative?: boolean;
}

export interface HamiltonTargetInput {
  targetId: string;
  weight: Prisma.Decimal | number | string;
  maxCeiling: Prisma.Decimal | number | string;
}

export interface DistributeHamiltonInput {
  amount: Prisma.Decimal | number | string;
  targets: HamiltonTargetInput[];
  allowZeroAmount?: boolean;
  allowCeilingResidual?: boolean;
}

export interface HamiltonTargetAllocation {
  targetId: string;
  amountCents: bigint;
  amount: Prisma.Decimal;
}

export interface HamiltonDistributionResult {
  authorizedAmount: Prisma.Decimal;
  authorizedCents: bigint;
  allocatedAmount: Prisma.Decimal;
  allocatedCents: bigint;
  residualAmount: Prisma.Decimal;
  residualCents: bigint;
  allocations: HamiltonTargetAllocation[];
}

export function compareTargetIdsAsc(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

export function parseExactMonetary2dp(
  value: Prisma.Decimal | number | string,
  fieldName: string,
  options: ParseMonetaryOptions = {},
): Prisma.Decimal {
  const { allowZero = false, allowNegative = false, onlyNegative = false } = options;

  if (value === null || value === undefined) {
    throw new BadRequestException(`${fieldName} is required`);
  }

  let dec: Prisma.Decimal;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Number.isNaN(value)) {
      throw new BadRequestException(`${fieldName} must be a valid finite number`);
    }
    try {
      dec = new Prisma.Decimal(value);
    } catch {
      throw new BadRequestException(`${fieldName} must be a valid finite decimal`);
    }
  } else if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      throw new BadRequestException(`${fieldName} must not be empty`);
    }
    try {
      dec = new Prisma.Decimal(trimmed);
    } catch {
      throw new BadRequestException(`${fieldName} must be a valid decimal representation`);
    }
  } else if (Prisma.Decimal.isDecimal(value) || (typeof value === 'object' && 'toFixed' in (value as object))) {
    try {
      dec = new Prisma.Decimal(value);
    } catch {
      throw new BadRequestException(`${fieldName} must be a valid decimal representation`);
    }
  } else {
    throw new BadRequestException(`${fieldName} must be a valid decimal representation`);
  }

  if (!dec.isFinite()) {
    throw new BadRequestException(`${fieldName} must be a valid finite decimal`);
  }

  // Strictly reject any input carrying sub-cent fractional precision (> 2dp)
  if (!dec.mul(100).isInteger()) {
    throw new BadRequestException(
      `${fieldName} must have at most 2 decimal places (received "${dec.toString()}")`,
    );
  }

  if (onlyNegative) {
    if (dec.gte(0)) {
      throw new BadRequestException(`${fieldName} must be strictly negative`);
    }
  } else {
    if (!allowNegative && dec.lt(0)) {
      throw new BadRequestException(`${fieldName} cannot be negative`);
    }
    if (!allowZero && dec.isZero()) {
      throw new BadRequestException(`${fieldName} must be greater than zero`);
    }
  }

  return dec.toDecimalPlaces(2);
}

export function decimalToCentsBigInt(
  value: Prisma.Decimal | number | string,
  fieldName = 'amount',
  options: ParseMonetaryOptions = {},
): bigint {
  const exact = parseExactMonetary2dp(value, fieldName, options);
  return BigInt(exact.mul(100).toFixed(0));
}

export function centsBigIntToDecimal(cents: bigint): Prisma.Decimal {
  return new Prisma.Decimal(cents.toString()).div(100).toDecimalPlaces(2);
}

function parseNonNegativeWeightDecimal(
  value: Prisma.Decimal | number | string,
  targetId: string,
): Prisma.Decimal {
  if (value === null || value === undefined) {
    throw new BadRequestException(`Weight for target "${targetId}" is required`);
  }
  if (typeof value === 'number' && (!Number.isFinite(value) || Number.isNaN(value))) {
    throw new BadRequestException(`Weight for target "${targetId}" must be finite`);
  }
  let dec: Prisma.Decimal;
  try {
    dec = new Prisma.Decimal(typeof value === 'string' ? value.trim() : value);
  } catch {
    throw new BadRequestException(`Weight for target "${targetId}" is not a valid decimal`);
  }
  if (!dec.isFinite() || dec.lt(0)) {
    throw new BadRequestException(`Weight for target "${targetId}" must be a non-negative finite decimal`);
  }
  return dec;
}

export function distributeAmountHamilton(
  input: DistributeHamiltonInput,
): HamiltonDistributionResult {
  const authorizedAmount = parseExactMonetary2dp(input.amount, 'amount', {
    allowZero: input.allowZeroAmount ?? false,
    allowNegative: false,
  });
  const authorizedCents = BigInt(authorizedAmount.mul(100).toFixed(0));

  if (!Array.isArray(input.targets) || input.targets.length === 0) {
    throw new BadRequestException('At least one allocation target is required');
  }

  const seenIds = new Set<string>();
  const normalized = input.targets.map((t) => {
    if (!t.targetId || typeof t.targetId !== 'string' || t.targetId.trim().length === 0) {
      throw new BadRequestException('Every allocation target must provide a non-empty targetId');
    }
    if (seenIds.has(t.targetId)) {
      throw new BadRequestException(`Duplicate allocation target "${t.targetId}"`);
    }
    seenIds.add(t.targetId);

    const capCents = decimalToCentsBigInt(t.maxCeiling, `maxCeiling(${t.targetId})`, {
      allowZero: true,
      allowNegative: false,
    });
    const weightDec = parseNonNegativeWeightDecimal(t.weight, t.targetId);

    return {
      targetId: t.targetId,
      capCents,
      weightDec,
      weightInt: 0n,
      allocatedCents: 0n,
    };
  });

  // Sort strictly deterministically by targetId ASC BEFORE any division or remainder tie-break
  normalized.sort((a, b) => compareTargetIdsAsc(a.targetId, b.targetId));

  if (authorizedCents === 0n) {
    return {
      authorizedAmount,
      authorizedCents: 0n,
      allocatedAmount: new Prisma.Decimal('0.00'),
      allocatedCents: 0n,
      residualAmount: new Prisma.Decimal('0.00'),
      residualCents: 0n,
      allocations: normalized.map((n) => ({
        targetId: n.targetId,
        amountCents: 0n,
        amount: new Prisma.Decimal('0.00'),
      })),
    };
  }

  // Scale all Decimal weights cleanly to exact integer BigInts without floats
  const maxScale = normalized.reduce(
    (max, item) => Math.max(max, Math.max(0, item.weightDec.decimalPlaces())),
    0,
  );
  const scaleFactor = new Prisma.Decimal(10).pow(maxScale);

  let totalWeightInt = 0n;
  let totalCapEligibleCents = 0n;
  for (const item of normalized) {
    item.weightInt = BigInt(item.weightDec.mul(scaleFactor).toFixed(0));
    totalWeightInt += item.weightInt;
    if (item.weightInt > 0n && item.capCents > 0n) {
      totalCapEligibleCents += item.capCents;
    }
  }

  if (totalWeightInt <= 0n) {
    throw new BadRequestException('Total target allocation weight must be greater than zero');
  }

  if (authorizedCents > totalCapEligibleCents && !input.allowCeilingResidual) {
    const excessCents = authorizedCents - totalCapEligibleCents;
    throw new BadRequestException(
      `Authorized amount (${authorizedAmount.toFixed(2)}) exceeds aggregate target ceiling (${centsBigIntToDecimal(totalCapEligibleCents).toFixed(2)}) with unallocated residual ${centsBigIntToDecimal(excessCents).toFixed(2)}`,
    );
  }

  let remainingCents =
    authorizedCents <= totalCapEligibleCents ? authorizedCents : totalCapEligibleCents;

  // Iterative cap-constrained Hamilton distribution in exact BigInt rational arithmetic
  while (remainingCents > 0n) {
    const active = normalized.filter(
      (item) => item.weightInt > 0n && item.allocatedCents < item.capCents,
    );
    if (active.length === 0) {
      break;
    }

    const activeWeightSum = active.reduce((sum, item) => sum + item.weightInt, 0n);

    // Check if any active bucket would reach or exceed its remaining ceiling on exact floor
    const saturated = active.filter((item) => {
      const slack = item.capCents - item.allocatedCents;
      const quotaFloor = (remainingCents * item.weightInt) / activeWeightSum;
      return quotaFloor >= slack;
    });

    if (saturated.length > 0) {
      for (const item of saturated) {
        const slack = item.capCents - item.allocatedCents;
        item.allocatedCents += slack;
        remainingCents -= slack;
      }
      continue;
    }

    // All active buckets have strict headroom (quotaFloor < slack => slack - quotaFloor >= 1n)
    const remainderEntries: Array<{
      item: (typeof normalized)[number];
      remainderNum: bigint;
    }> = [];

    let allocatedInPass = 0n;
    for (const item of active) {
      const product = remainingCents * item.weightInt;
      const floorCents = product / activeWeightSum;
      const remainderNum = product % activeWeightSum;

      item.allocatedCents += floorCents;
      allocatedInPass += floorCents;
      remainderEntries.push({ item, remainderNum });
    }

    const leftoverCents = remainingCents - allocatedInPass;
    remainderEntries.sort((a, b) => {
      if (a.remainderNum > b.remainderNum) return -1;
      if (a.remainderNum < b.remainderNum) return 1;
      return compareTargetIdsAsc(a.item.targetId, b.item.targetId);
    });

    const bonusCount = Number(leftoverCents);
    for (let idx = 0; idx < bonusCount; idx++) {
      remainderEntries[idx]!.item.allocatedCents += 1n;
    }

    remainingCents = 0n;
  }

  let allocatedCents = 0n;
  const allocations: HamiltonTargetAllocation[] = normalized.map((item) => {
    if (item.allocatedCents < 0n || item.allocatedCents > item.capCents) {
      throw new Error(
        `Hamilton invariant violation on target "${item.targetId}": allocated=${item.allocatedCents}, cap=${item.capCents}`,
      );
    }
    allocatedCents += item.allocatedCents;
    return {
      targetId: item.targetId,
      amountCents: item.allocatedCents,
      amount: centsBigIntToDecimal(item.allocatedCents),
    };
  });

  const residualCents = authorizedCents - allocatedCents;
  if (!input.allowCeilingResidual && residualCents !== 0n) {
    throw new Error(
      `Hamilton conservation violation: allocated=${allocatedCents}, authorized=${authorizedCents}`,
    );
  }

  return {
    authorizedAmount,
    authorizedCents,
    allocatedAmount: centsBigIntToDecimal(allocatedCents),
    allocatedCents,
    residualAmount: centsBigIntToDecimal(residualCents),
    residualCents,
    allocations,
  };
}
