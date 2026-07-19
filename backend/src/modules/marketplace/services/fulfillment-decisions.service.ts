import { ForbiddenException, Injectable, InternalServerErrorException, NotFoundException } from '@nestjs/common';

import { VendorPermissionsService } from '../../vendor-tiers/services/vendor-permissions.service';
import { ResolveBestVendorDto } from '../dto/resolve-best-vendor.dto';
import { BestVendorResolutionEntity } from '../entities/best-vendor-resolution.entity';
import {
  FulfillmentCandidatesRepository,
  ProductCandidate,
} from '../repositories/fulfillment-candidates.repository';
import { CreateScoreInput, FulfillmentDecisionsRepository } from '../repositories/fulfillment-decisions.repository';
import { MarketplaceModeConfigsRepository } from '../repositories/marketplace-mode-configs.repository';
import { VendorSelectionWeightConfigsRepository } from '../repositories/vendor-selection-weight-configs.repository';
import {
  VendorCandidate,
  VendorCandidateScore,
  VendorSelectionEngineService,
} from './vendor-selection-engine.service';

@Injectable()
export class FulfillmentDecisionsService {
  constructor(
    private readonly candidatesRepository: FulfillmentCandidatesRepository,
    private readonly decisionsRepository: FulfillmentDecisionsRepository,
    private readonly modeConfigsRepository: MarketplaceModeConfigsRepository,
    private readonly weightConfigsRepository: VendorSelectionWeightConfigsRepository,
    private readonly engine: VendorSelectionEngineService,
    private readonly vendorPermissionsService: VendorPermissionsService,
  ) {}

  async resolveBestVendor(
    customerId: string,
    dto: ResolveBestVendorDto,
  ): Promise<BestVendorResolutionEntity> {
    const modeConfig = await this.modeConfigsRepository.findCurrent();
    if (!modeConfig) {
      throw new InternalServerErrorException('No marketplace mode configuration exists');
    }
    if (!modeConfig.bestAvailableEnabled) {
      throw new ForbiddenException('Best Available Vendor is not currently enabled');
    }

    const requestedProduct = await this.candidatesRepository.findById(dto.productId);
    if (!requestedProduct) {
      throw new NotFoundException('Product not found');
    }

    const weightConfig = await this.weightConfigsRepository.findCurrent();
    if (!weightConfig) {
      throw new InternalServerErrorException('No vendor selection weight configuration exists');
    }
    const weights = {
      inventoryWeight: weightConfig.inventoryWeight.toNumber(),
      freshnessWeight: weightConfig.freshnessWeight.toNumber(),
      complianceWeight: weightConfig.complianceWeight.toNumber(),
      distanceWeight: weightConfig.distanceWeight.toNumber(),
      ratingWeight: weightConfig.ratingWeight.toNumber(),
      deliveryCapacityWeight: weightConfig.deliveryCapacityWeight.toNumber(),
    };

    const candidates = await this.candidatesRepository.findMatchingCandidates(
      requestedProduct.name,
      requestedProduct.categoryId,
    );

    const scores = candidates.map((candidate) =>
      this.engine.scoreCandidate(
        FulfillmentDecisionsService.toEngineCandidate(candidate),
        dto.quantity,
        dto.deliveryParish,
        weights,
      ),
    );

    const winner = this.engine.pickWinner(scores);

    const decisionId = await this.decisionsRepository.createDecisionWithScores(
      {
        requestedProductId: dto.productId,
        quantity: dto.quantity,
        deliveryParish: dto.deliveryParish,
        customerId,
        decidedAt: new Date(),
      },
      scores.map((score) => FulfillmentDecisionsService.toScoreInput(score)),
      winner ? { vendorId: winner.vendorId, productId: winner.productId } : null,
    );

    if (!winner) {
      throw new NotFoundException(
        'No eligible vendor could fulfill this request right now',
      );
    }

    const winningCandidate = candidates.find(
      (candidate) => candidate.vendorId === winner.vendorId && candidate.id === winner.productId,
    );
    const permissions = await this.vendorPermissionsService.getPermissions(
      winningCandidate!.vendor.tier,
    );

    return {
      productId: winner.productId,
      vendorId: winner.vendorId,
      badge: permissions.badge,
      totalScore: winner.totalScore.toFixed(2),
      fulfillmentDecisionId: decisionId,
    };
  }

  private static toEngineCandidate(candidate: ProductCandidate): VendorCandidate {
    return {
      vendorId: candidate.vendorId,
      productId: candidate.id,
      vendorStatus: candidate.vendor.status,
      vendorParish: candidate.vendor.parish,
      vendorComplianceScore: candidate.vendor.complianceScore,
      productIsActive: candidate.isActive,
      quantityAvailable: candidate.quantityAvailable,
      lotFoodSafetyStatus: candidate.lot?.foodSafetyStatus ?? null,
      lotFreshnessGrade: candidate.lot?.freshnessGrade ?? null,
    };
  }

  private static toScoreInput(score: VendorCandidateScore): CreateScoreInput {
    return {
      vendorId: score.vendorId,
      productId: score.productId,
      inventoryScore: score.inventoryScore,
      freshnessScore: score.freshnessScore,
      complianceScore: score.complianceScore,
      distanceScore: score.distanceScore,
      ratingScore: score.ratingScore,
      deliveryCapacityScore: score.deliveryCapacityScore,
      totalScore: score.totalScore,
      eligible: score.eligible,
      ineligibilityReason: score.ineligibilityReason,
    };
  }
}
