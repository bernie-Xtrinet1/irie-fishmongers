import { Injectable, NotFoundException } from '@nestjs/common';
import { InspectionResult, QualityInspection } from '@prisma/client';

import { RequestUser } from '../../../common/guards/jwt-auth.guard';
import { CreateQualityInspectionDto } from '../dto/create-quality-inspection.dto';
import { PaginatedQualityInspectionsEntity } from '../entities/paginated-quality-inspections.entity';
import { QualityInspectionResponseEntity } from '../entities/quality-inspection-response.entity';
import { QualityInspectionsRepository } from '../repositories/quality-inspections.repository';
import { SeafoodLotsRepository } from '../repositories/seafood-lots.repository';
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
  ) {}

  async inspect(
    inspectorId: string,
    dto: CreateQualityInspectionDto,
  ): Promise<QualityInspectionResponseEntity> {
    const lot = await this.lotsRepository.findById(dto.lotId);
    if (!lot) {
      throw new NotFoundException('Seafood lot not found');
    }

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
