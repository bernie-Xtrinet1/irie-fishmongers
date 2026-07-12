import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';

import { DeliveryRunResponseEntity } from '../../delivery/entities/delivery-run-response.entity';
import {
  DeliveryRunsRepository,
  DeliveryRunWithDispatchContext,
} from '../../delivery/repositories/delivery-runs.repository';
import { DriversRepository } from '../../delivery/repositories/drivers.repository';
import { DeliveryRunsService } from '../../delivery/services/delivery-runs.service';
import { FleetAssetsRepository } from '../../fleet/repositories/fleet-assets.repository';
import { DispatchDecisionLogsRepository, ScoredCandidate } from '../repositories/dispatch-decision-logs.repository';
import { computeCapacityFitScore, isCapacityEligible } from './dispatch-scoring.util';

interface RunRequirements {
  requiresColdChain: boolean;
  totalWeightLbs: number;
}

@Injectable()
export class DispatchService {
  constructor(
    private readonly deliveryRunsRepository: DeliveryRunsRepository,
    private readonly deliveryRunsService: DeliveryRunsService,
    private readonly driversRepository: DriversRepository,
    private readonly fleetAssetsRepository: FleetAssetsRepository,
    private readonly dispatchDecisionLogsRepository: DispatchDecisionLogsRepository,
  ) {}

  // Automates the decision PATCH /delivery-runs/:id/assign previously
  // required a human to make with zero scoring - this method ranks
  // eligible candidates and calls that same assign() seam with the winner,
  // rather than duplicating its PLANNED-status/driver-exists checks or its
  // persistence logic. Manual assign() remains available as a fallback for
  // when the automated pool has no eligible candidate, or an operator
  // wants to override the algorithm's choice.
  async dispatch(deliveryRunId: string): Promise<DeliveryRunResponseEntity> {
    const context = await this.deliveryRunsRepository.findByIdWithDispatchContext(deliveryRunId);
    if (!context) {
      throw new NotFoundException('Delivery run not found');
    }
    if (context.status !== 'PLANNED') {
      throw new BadRequestException('Only a planned delivery run can be dispatched');
    }

    const { requiresColdChain, totalWeightLbs } = DispatchService.computeRunRequirements(context);

    const [candidateDrivers, candidateAssets] = await Promise.all([
      this.driversRepository.findDispatchCandidates(context.zoneId, requiresColdChain),
      this.fleetAssetsRepository.findDispatchCandidates(context.zoneId, requiresColdChain),
    ]);

    const scoredDrivers: (ScoredCandidate & { capacityLbs: number | null })[] = candidateDrivers.map((driver) => {
      const capacityLbs = driver.capacityLbs ? driver.capacityLbs.toNumber() : null;
      return {
        id: driver.id,
        capacityLbs,
        eligible: isCapacityEligible(capacityLbs, totalWeightLbs),
        score: computeCapacityFitScore(capacityLbs, totalWeightLbs),
      };
    });

    const scoredAssets: (ScoredCandidate & { capacityLbs: number | null })[] = candidateAssets.map((asset) => {
      const capacityLbs = asset.capacityLbs.toNumber();
      return {
        id: asset.id,
        capacityLbs,
        eligible: isCapacityEligible(capacityLbs, totalWeightLbs),
        score: computeCapacityFitScore(capacityLbs, totalWeightLbs),
      };
    });

    const winningDriver = scoredDrivers
      .filter((candidate) => candidate.eligible)
      .sort((a, b) => b.score - a.score)[0];

    const winningAsset = scoredAssets
      .filter((candidate) => candidate.eligible)
      .sort((a, b) => b.score - a.score)[0];

    if (!winningDriver) {
      await this.dispatchDecisionLogsRepository.create({
        deliveryRunId,
        requiresColdChain,
        totalWeightLbs,
        candidateDrivers: scoredDrivers,
        candidateAssets: scoredAssets,
        selectedDriverId: null,
        selectedAssetId: null,
        reason: `No eligible driver found among ${scoredDrivers.length} candidate(s) in zone - either none are online/approved/cold-chain-capable as required, or none has sufficient capacity for the run's ${totalWeightLbs}lb total weight`,
      });
      throw new ConflictException(
        'No eligible driver is currently available for this delivery run - use manual assignment or try again once a driver comes online',
      );
    }

    await this.dispatchDecisionLogsRepository.create({
      deliveryRunId,
      requiresColdChain,
      totalWeightLbs,
      candidateDrivers: scoredDrivers,
      candidateAssets: scoredAssets,
      selectedDriverId: winningDriver.id,
      selectedAssetId: winningAsset?.id ?? null,
      reason: `Selected driver ${winningDriver.id} (capacity-fit score ${winningDriver.score}/100) among ${scoredDrivers.length} candidate(s)${
        winningAsset
          ? ` and fleet asset ${winningAsset.id} (score ${winningAsset.score}/100) among ${scoredAssets.length} candidate(s)`
          : ' - no eligible fleet asset was available in this zone'
      }`,
    });

    return this.deliveryRunsService.assign(deliveryRunId, {
      driverId: winningDriver.id,
      fleetAssetId: winningAsset?.id,
    });
  }

  private static computeRunRequirements(context: DeliveryRunWithDispatchContext): RunRequirements {
    let requiresColdChain = false;
    let totalWeightLbs = 0;

    for (const stop of context.stops) {
      for (const item of stop.delivery.vendorOrder.items) {
        if (item.product.lotId !== null) {
          requiresColdChain = true;
        }
        if (item.product.weightLbs) {
          totalWeightLbs += item.product.weightLbs.toNumber() * item.quantity;
        }
      }
    }

    return { requiresColdChain, totalWeightLbs };
  }
}
