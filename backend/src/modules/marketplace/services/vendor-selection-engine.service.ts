import { Injectable } from '@nestjs/common';
import { FoodSafetyStatus, FreshnessGrade, Parish, VendorStatus } from '@prisma/client';

// Neutral defaults for factors with no real backing data yet (see
// docs/database-design.md's Marketplace Selection Engine scope notes):
// no Review/Rating model exists (ratingScore), no fleet-capacity model
// exists (deliveryCapacityScore), and no vendor.complianceScore is
// computed for most vendors yet (complianceScore falls back here too).
// A neutral midpoint is used rather than a fabricated high/low value so
// these factors never unfairly help or penalize a vendor.
const NEUTRAL_SCORE = 50;
const MAX_SCORE = 100;

// Same-parish-first proxy for "Distance Score" - no geocoding/lat-lng
// infrastructure exists yet (Vendor.parish is the only location data).
const SAME_PARISH_SCORE = 100;
const DIFFERENT_PARISH_SCORE = 50;

const FRESHNESS_GRADE_SCORES: Record<FreshnessGrade, number> = {
  GRADE_A: 100,
  GRADE_B: 70,
  GRADE_C: 40,
  REJECTED: 0,
};

export interface VendorSelectionWeights {
  inventoryWeight: number;
  freshnessWeight: number;
  complianceWeight: number;
  distanceWeight: number;
  ratingWeight: number;
  deliveryCapacityWeight: number;
}

export interface VendorCandidate {
  vendorId: string;
  productId: string;
  vendorStatus: VendorStatus;
  vendorParish: Parish;
  vendorComplianceScore: number | null;
  productIsActive: boolean;
  quantityAvailable: number;
  lotFoodSafetyStatus: FoodSafetyStatus | null;
  lotFreshnessGrade: FreshnessGrade | null;
}

export interface VendorCandidateScore {
  vendorId: string;
  productId: string;
  inventoryScore: number;
  freshnessScore: number;
  complianceScore: number;
  distanceScore: number;
  ratingScore: number;
  deliveryCapacityScore: number;
  totalScore: number;
  eligible: boolean;
  ineligibilityReason: string | null;
}

/**
 * Pure scoring logic per .claude/marketplace/vendor-selection-engine.md -
 * mirrors DriverSettlementEngine's design: no I/O, no persistence, just
 * eligibility + weighted scoring math, so FulfillmentDecisionsService is
 * the only place that reads/writes the database.
 */
@Injectable()
export class VendorSelectionEngineService {
  scoreCandidate(
    candidate: VendorCandidate,
    requestedQuantity: number,
    deliveryParish: Parish,
    weights: VendorSelectionWeights,
  ): VendorCandidateScore {
    const ineligibilityReason = VendorSelectionEngineService.findIneligibilityReason(
      candidate,
      requestedQuantity,
    );

    if (ineligibilityReason) {
      return {
        vendorId: candidate.vendorId,
        productId: candidate.productId,
        inventoryScore: 0,
        freshnessScore: 0,
        complianceScore: 0,
        distanceScore: 0,
        ratingScore: 0,
        deliveryCapacityScore: 0,
        totalScore: 0,
        eligible: false,
        ineligibilityReason,
      };
    }

    const inventoryScore = Math.min(
      MAX_SCORE,
      (candidate.quantityAvailable / requestedQuantity) * MAX_SCORE,
    );
    const freshnessScore = candidate.lotFreshnessGrade
      ? FRESHNESS_GRADE_SCORES[candidate.lotFreshnessGrade]
      : NEUTRAL_SCORE;
    const complianceScore = candidate.vendorComplianceScore ?? NEUTRAL_SCORE;
    const distanceScore =
      candidate.vendorParish === deliveryParish ? SAME_PARISH_SCORE : DIFFERENT_PARISH_SCORE;
    const ratingScore = NEUTRAL_SCORE;
    const deliveryCapacityScore = NEUTRAL_SCORE;

    const totalScore =
      inventoryScore * weights.inventoryWeight +
      freshnessScore * weights.freshnessWeight +
      complianceScore * weights.complianceWeight +
      distanceScore * weights.distanceWeight +
      ratingScore * weights.ratingWeight +
      deliveryCapacityScore * weights.deliveryCapacityWeight;

    return {
      vendorId: candidate.vendorId,
      productId: candidate.productId,
      inventoryScore,
      freshnessScore,
      complianceScore,
      distanceScore,
      ratingScore,
      deliveryCapacityScore,
      totalScore,
      eligible: true,
      ineligibilityReason: null,
    };
  }

  /** Highest total score wins; ties broken deterministically by vendorId. */
  pickWinner(scores: VendorCandidateScore[]): VendorCandidateScore | null {
    const eligible = scores.filter((score) => score.eligible);
    if (eligible.length === 0) {
      return null;
    }

    return eligible.reduce((best, current) => {
      if (current.totalScore > best.totalScore) {
        return current;
      }
      if (current.totalScore === best.totalScore && current.vendorId < best.vendorId) {
        return current;
      }
      return best;
    });
  }

  private static findIneligibilityReason(
    candidate: VendorCandidate,
    requestedQuantity: number,
  ): string | null {
    if (candidate.vendorStatus !== 'APPROVED') {
      return 'Vendor is not approved';
    }
    if (!candidate.productIsActive) {
      return 'Product is not active';
    }
    if (candidate.quantityAvailable < requestedQuantity) {
      return 'Insufficient inventory to fulfill the requested quantity';
    }
    if (candidate.lotFoodSafetyStatus && candidate.lotFoodSafetyStatus !== 'SAFE') {
      return 'Product is not currently cleared for sale';
    }
    return null;
  }
}
