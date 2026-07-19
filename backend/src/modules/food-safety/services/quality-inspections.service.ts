import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { FreshnessGrade, InspectionResult, QualityInspection } from '@prisma/client';

import { QualityInspectionRecordedEvent } from '../../../common/events/quality-inspection-recorded.event';
import { RequestUser } from '../../../common/guards/jwt-auth.guard';
import { CreateQualityInspectionDto } from '../dto/create-quality-inspection.dto';
import { PaginatedQualityInspectionsEntity } from '../entities/paginated-quality-inspections.entity';
import { QualityInspectionResponseEntity } from '../entities/quality-inspection-response.entity';
import { CustodyEventsRepository } from '../repositories/custody-events.repository';
import { QualityInspectionsRepository } from '../repositories/quality-inspections.repository';
import { SeafoodLotsRepository } from '../repositories/seafood-lots.repository';
import { ComplianceAuditLogService } from './compliance-audit-log.service';
import { SeafoodLotsService } from './seafood-lots.service';

const RESULT_TO_LOT_STATUS: Record<InspectionResult, 'SAFE' | 'UNDER_REVIEW' | 'REJECTED' | 'QUARANTINED'> = {
  PASSED: 'SAFE',
  CONDITIONAL: 'UNDER_REVIEW',
  REJECTED: 'REJECTED',
  QUARANTINED: 'QUARANTINED',
};

@Injectable()
export class QualityInspectionsService {
  constructor(
    private readonly inspectionsRepository: QualityInspectionsRepository,
    private readonly lotsRepository: SeafoodLotsRepository,
    private readonly seafoodLotsService: SeafoodLotsService,
    private readonly auditLogService: ComplianceAuditLogService,
    private readonly custodyEventsRepository: CustodyEventsRepository,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  async inspect(
    inspectorId: string,
    dto: CreateQualityInspectionDto,
    ipAddress?: string,
  ): Promise<QualityInspectionResponseEntity> {
    const lot = await this.lotsRepository.findById(dto.lotId);
    if (!lot) {
      throw new NotFoundException('Seafood lot not found');
    }

    QualityInspectionsService.assertGradingConsistent(dto.result, dto.freshnessGrade, dto.qualityScore);

    const inspection = await this.inspectionsRepository.create({
      lotId: dto.lotId,
      inspectorId,
      result: dto.result,
      freshnessGrade: dto.freshnessGrade,
      qualityScore: dto.qualityScore,
      notes: dto.notes,
      photoUrl: dto.photoUrl,
    });

    await this.lotsRepository.updateGrading(dto.lotId, {
      freshnessGrade: dto.freshnessGrade,
      qualityScore: dto.qualityScore,
    });

    // A recall is only ever cleared through a deliberate admin action on the
    // lot itself (per recall-management.md: "No recalled product may
    // re-enter the marketplace without compliance approval") - a routine
    // inspection must never silently lift a RECALLED status.
    if (lot.foodSafetyStatus !== 'RECALLED') {
      await this.lotsRepository.updateStatus(
        dto.lotId,
        RESULT_TO_LOT_STATUS[dto.result],
        `Updated from quality inspection result: ${dto.result}`,
      );
    }

    await this.auditLogService.record({
      userId: inspectorId,
      action: 'QUALITY_INSPECTION_RECORDED',
      entityType: 'SeafoodLot',
      entityId: dto.lotId,
      beforeValue: { freshnessGrade: lot.freshnessGrade, qualityScore: lot.qualityScore },
      afterValue: { freshnessGrade: dto.freshnessGrade, qualityScore: dto.qualityScore, result: dto.result },
      ipAddress,
      reason: dto.notes,
    });

    // INSPECTION is a checkpoint, not a custody transfer - both sides are
    // the inspector, per the chain-of-custody design (fromUserId ===
    // toUserId represents "held by, verified by").
    await this.custodyEventsRepository.create({
      lotId: dto.lotId,
      eventType: 'INSPECTION',
      fromUserId: inspectorId,
      toUserId: inspectorId,
    });

    // A failed/conditional inspection feeds the owning vendor's compliance
    // score (Phase 13C); emitted only after every write above has committed.
    await this.eventEmitter.emitAsync(
      QualityInspectionRecordedEvent.eventName,
      new QualityInspectionRecordedEvent(lot.vendorId, dto.lotId, dto.result),
    );

    return QualityInspectionsService.toResponse(inspection);
  }

  async getForLot(
    user: RequestUser,
    lotId: string,
    page: { page: number; pageSize: number },
  ): Promise<PaginatedQualityInspectionsEntity> {
    await this.seafoodLotsService.assertOwnedByRequester(user, lotId);

    const { items, total } = await this.inspectionsRepository.findByLotId(lotId, {
      skip: (page.page - 1) * page.pageSize,
      take: page.pageSize,
    });

    return {
      items: items.map((item) => QualityInspectionsService.toResponse(item)),
      total,
      page: page.page,
      pageSize: page.pageSize,
    };
  }

  // seafood-compliance-rules.md's freshness-grading / quality-scoring
  // sections describe two independently-submitted fields that must stay
  // internally consistent with each other and with the inspection result -
  // e.g. a PASSED inspection cannot grade a lot Rejected, and a Grade A
  // lot needs a score in the Premium/Excellent band (90-100/80-89), not a
  // Limited-Sale-or-below score.
  private static assertGradingConsistent(
    result: InspectionResult,
    freshnessGrade: FreshnessGrade,
    qualityScore: number,
  ): void {
    if (result === 'PASSED' && (freshnessGrade === 'GRADE_C' || freshnessGrade === 'REJECTED')) {
      throw new BadRequestException('A PASSED inspection cannot grade the lot Grade C or Rejected');
    }
    if ((result === 'REJECTED' || result === 'QUARANTINED') && freshnessGrade !== 'REJECTED') {
      throw new BadRequestException(`A ${result} inspection must grade the lot as Rejected`);
    }
    if (freshnessGrade === 'GRADE_A' && qualityScore < 80) {
      throw new BadRequestException('Grade A requires a quality score of at least 80');
    }
    if (freshnessGrade === 'GRADE_B' && qualityScore < 60) {
      throw new BadRequestException('Grade B requires a quality score of at least 60');
    }
    if (freshnessGrade === 'REJECTED' && qualityScore >= 60) {
      throw new BadRequestException('A Rejected grade requires a quality score below 60');
    }
  }

  private static toResponse(inspection: QualityInspection): QualityInspectionResponseEntity {
    return {
      id: inspection.id,
      lotId: inspection.lotId,
      inspectorId: inspection.inspectorId,
      result: inspection.result,
      freshnessGrade: inspection.freshnessGrade,
      qualityScore: inspection.qualityScore,
      notes: inspection.notes,
      photoUrl: inspection.photoUrl,
      inspectedAt: inspection.inspectedAt,
    };
  }
}
