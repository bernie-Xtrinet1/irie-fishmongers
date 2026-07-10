import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { FoodSafetyStatus, Prisma, RoleName, SeafoodLot, WeightUnit } from '@prisma/client';

import { RequestUser } from '../../../common/guards/jwt-auth.guard';
import { CatchItemsRepository } from '../../catches/repositories/catch-items.repository';
import { LandingSitesRepository } from '../../catches/repositories/landing-sites.repository';
import { SpeciesRepository } from '../../catches/repositories/species.repository';
import { assertSpeciesInSeason, assertSpeciesSellable } from '../../catches/utils/species-validation.util';
import { VendorsRepository } from '../../vendors/repositories/vendors.repository';
import { CreateSeafoodLotDto } from '../dto/create-seafood-lot.dto';
import { ListSeafoodLotsDto } from '../dto/list-seafood-lots.dto';
import { PaginatedSeafoodLotsEntity } from '../entities/paginated-seafood-lots.entity';
import { SeafoodLotPublicEntity } from '../entities/seafood-lot-public.entity';
import { SeafoodLotResponseEntity } from '../entities/seafood-lot-response.entity';
import { LotWithVendor, SeafoodLotsRepository } from '../repositories/seafood-lots.repository';
import { TemperatureAlertsRepository } from '../repositories/temperature-alerts.repository';
import { ComplianceAuditLogService } from './compliance-audit-log.service';

interface ResolvedLotSourceFields {
  catchItemId?: string;
  speciesId?: string;
  species: string;
  catchDate: Date;
  weight: number;
  weightUnit: WeightUnit;
  catchLocation?: string;
  landingSite?: string;
}

@Injectable()
export class SeafoodLotsService {
  constructor(
    private readonly lotsRepository: SeafoodLotsRepository,
    private readonly vendorsRepository: VendorsRepository,
    private readonly alertsRepository: TemperatureAlertsRepository,
    private readonly catchItemsRepository: CatchItemsRepository,
    private readonly speciesRepository: SpeciesRepository,
    private readonly landingSitesRepository: LandingSitesRepository,
    private readonly auditLogService: ComplianceAuditLogService,
  ) {}

  async register(userId: string, dto: CreateSeafoodLotDto): Promise<SeafoodLotResponseEntity> {
    const vendor = await this.vendorsRepository.findByUserId(userId);
    if (!vendor) {
      throw new NotFoundException('No vendor profile exists for this account');
    }
    if (vendor.status !== 'APPROVED') {
      throw new ForbiddenException('Only approved vendors can register seafood lots');
    }

    const source = await this.resolveLotSourceFields(dto);
    const lot = await this.createLotWithUniqueLotNumber(vendor.id, dto, source);
    return SeafoodLotsService.toResponse(lot);
  }

  // A lot may be sourced three ways, in priority order: (1) linked to a
  // registered CatchItem - full traceability, every field derived from the
  // catchItem/catch/species/landing-site chain (a lot is species-
  // homogeneous, so it traces to one species-specific line item of a
  // catch, never the whole mixed-species catch); (2) linked to a Species
  // only - regulatory/seasonal rules enforced, everything else from the
  // DTO; (3) the original direct-entry path with no linkage at all,
  // unchanged for backward compatibility with vendors/tests that predate
  // this chain.
  private async resolveLotSourceFields(dto: CreateSeafoodLotDto): Promise<ResolvedLotSourceFields> {
    if (dto.catchItemId) {
      const catchItem = await this.catchItemsRepository.findById(dto.catchItemId);
      if (!catchItem) {
        throw new NotFoundException('Catch item not found');
      }

      const [species, landingSite] = await Promise.all([
        this.speciesRepository.findById(catchItem.speciesId),
        this.landingSitesRepository.findById(catchItem.catch.landingSiteId),
      ]);

      return {
        catchItemId: catchItem.id,
        speciesId: catchItem.speciesId,
        species: species?.commercialName ?? dto.species ?? 'Unknown species',
        catchDate: catchItem.catch.catchDate,
        weight: catchItem.weight.toNumber(),
        weightUnit: catchItem.weightUnit,
        catchLocation: dto.catchLocation ?? catchItem.catch.fishingArea ?? undefined,
        landingSite: landingSite?.name,
      };
    }

    if (dto.speciesId) {
      const species = await this.speciesRepository.findById(dto.speciesId);
      if (!species) {
        throw new NotFoundException('Species not found');
      }
      if (!dto.catchDate) {
        throw new BadRequestException('catchDate is required');
      }
      assertSpeciesSellable(species);
      assertSpeciesInSeason(species, new Date(dto.catchDate));

      if (dto.weight === undefined || !dto.weightUnit) {
        throw new BadRequestException('weight and weightUnit are required');
      }

      return {
        speciesId: species.id,
        species: species.commercialName,
        catchDate: new Date(dto.catchDate),
        weight: dto.weight,
        weightUnit: dto.weightUnit,
        catchLocation: dto.catchLocation,
        landingSite: dto.landingSite,
      };
    }

    if (!dto.species || !dto.catchDate || dto.weight === undefined || !dto.weightUnit) {
      throw new BadRequestException(
        'species, catchDate, weight, and weightUnit are required unless catchId or speciesId is provided',
      );
    }

    return {
      species: dto.species,
      catchDate: new Date(dto.catchDate),
      weight: dto.weight,
      weightUnit: dto.weightUnit,
      catchLocation: dto.catchLocation,
      landingSite: dto.landingSite,
    };
  }

  // generateLotNumber() reads a count then increments it, which is not
  // atomic under concurrent registrations - retry on a lotNumber unique
  // violation (re-reading the count each time) rather than serializing
  // every lot registration behind a lock for what is a rare collision.
  private async createLotWithUniqueLotNumber(
    vendorId: string,
    dto: CreateSeafoodLotDto,
    source: ResolvedLotSourceFields,
  ): Promise<SeafoodLot> {
    const MAX_ATTEMPTS = 5;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const lotNumber = await this.generateLotNumber();
      try {
        return await this.lotsRepository.create({
          lotNumber,
          vendorId,
          catchItemId: source.catchItemId,
          species: source.species,
          speciesId: source.speciesId,
          storageType: dto.storageType,
          catchDate: source.catchDate,
          catchLocation: source.catchLocation,
          landingSite: source.landingSite,
          weight: source.weight,
          weightUnit: source.weightUnit,
        });
      } catch (error) {
        const isLotNumberCollision =
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === 'P2002' &&
          (error.meta?.target as string[] | undefined)?.includes('lotNumber');
        if (!isLotNumberCollision || attempt === MAX_ATTEMPTS) {
          throw error;
        }
      }
    }
    throw new Error('Failed to generate a unique lot number');
  }

  async getMine(
    userId: string,
    page: { page: number; pageSize: number },
  ): Promise<PaginatedSeafoodLotsEntity> {
    const vendor = await this.vendorsRepository.findByUserId(userId);
    if (!vendor) {
      throw new NotFoundException('No vendor profile exists for this account');
    }

    const { items, total } = await this.lotsRepository.findManyByVendor(vendor.id, {
      skip: (page.page - 1) * page.pageSize,
      take: page.pageSize,
    });

    return {
      items: items.map((item) => SeafoodLotsService.toResponse(item)),
      total,
      page: page.page,
      pageSize: page.pageSize,
    };
  }

  async list(dto: ListSeafoodLotsDto): Promise<PaginatedSeafoodLotsEntity> {
    const { items, total } = await this.lotsRepository.findMany(
      { vendorId: dto.vendorId, status: dto.status },
      { skip: (dto.page - 1) * dto.pageSize, take: dto.pageSize },
    );

    return {
      items: items.map((item) => SeafoodLotsService.toResponse(item)),
      total,
      page: dto.page,
      pageSize: dto.pageSize,
    };
  }

  async getById(id: string): Promise<SeafoodLotResponseEntity> {
    const lot = await this.lotsRepository.findById(id);
    if (!lot) {
      throw new NotFoundException('Seafood lot not found');
    }
    return SeafoodLotsService.toResponse(lot);
  }

  async getPublicById(id: string): Promise<SeafoodLotPublicEntity> {
    const lot = await this.lotsRepository.findByIdWithVendor(id);
    if (!lot) {
      throw new NotFoundException('Seafood lot not found');
    }

    const activeAlertCount = await this.alertsRepository.countUnresolvedByLotId(id);

    return {
      lotNumber: lot.lotNumber,
      species: lot.species,
      storageType: lot.storageType,
      catchDate: lot.catchDate,
      catchLocation: lot.catchLocation,
      landingSite: lot.landingSite,
      freshnessGrade: lot.freshnessGrade,
      vendorBusinessName: lot.vendor.businessName,
      temperatureVerified: activeAlertCount === 0,
    };
  }

  async updateStatus(
    userId: string,
    id: string,
    status: FoodSafetyStatus,
    reason?: string,
    ipAddress?: string,
  ): Promise<SeafoodLotResponseEntity> {
    const lot = await this.lotsRepository.findById(id);
    if (!lot) {
      throw new NotFoundException('Seafood lot not found');
    }

    const updated = await this.lotsRepository.updateStatus(id, status, reason);

    await this.auditLogService.record({
      userId,
      action: 'SEAFOOD_LOT_STATUS_UPDATED',
      entityType: 'SeafoodLot',
      entityId: id,
      beforeValue: { foodSafetyStatus: lot.foodSafetyStatus },
      afterValue: { foodSafetyStatus: updated.foodSafetyStatus },
      ipAddress,
      reason,
    });

    return SeafoodLotsService.toResponse(updated);
  }

  async assertOwnedByRequester(user: RequestUser, lotId: string): Promise<LotWithVendor> {
    const lot = await this.lotsRepository.findByIdWithVendor(lotId);
    if (!lot) {
      throw new NotFoundException('Seafood lot not found');
    }
    if (user.roles.includes(RoleName.ADMINISTRATOR)) {
      return lot;
    }

    const vendor = await this.vendorsRepository.findByUserId(user.id);
    if (!vendor || lot.vendorId !== vendor.id) {
      throw new ForbiddenException('You do not have access to this lot');
    }
    return lot;
  }

  // seafood-compliance-rules.md's "Only Grade A and B may be sold" / "score
  // below 60 rejected" gate, shared by Products/Cart/Orders alongside the
  // existing foodSafetyStatus !== SAFE check.
  assertSellable(lot: {
    freshnessGrade: SeafoodLot['freshnessGrade'];
    qualityScore: SeafoodLot['qualityScore'];
  }): void {
    if (!SeafoodLotsService.isGradingSellable(lot)) {
      if (lot.freshnessGrade === 'GRADE_C' || lot.freshnessGrade === 'REJECTED') {
        throw new BadRequestException(
          'This seafood lot did not pass freshness grading (Grade A or B required)',
        );
      }
      throw new BadRequestException('This seafood lot did not pass the minimum quality score');
    }
  }

  // Non-throwing counterpart of assertSellable(), for display-only contexts
  // (e.g. deriving a product's listing availability) that need a boolean
  // rather than a rejection.
  static isGradingSellable(lot: {
    freshnessGrade: SeafoodLot['freshnessGrade'];
    qualityScore: SeafoodLot['qualityScore'];
  }): boolean {
    if (lot.freshnessGrade === 'GRADE_C' || lot.freshnessGrade === 'REJECTED') {
      return false;
    }
    return lot.qualityScore === null || lot.qualityScore >= 60;
  }

  private async generateLotNumber(): Promise<string> {
    const year = new Date().getFullYear();
    const countThisYear = await this.lotsRepository.countCreatedThisYear(year);
    return `LOT-${year}-${String(countThisYear + 1).padStart(6, '0')}`;
  }

  private static toResponse(lot: SeafoodLot): SeafoodLotResponseEntity {
    return {
      id: lot.id,
      lotNumber: lot.lotNumber,
      vendorId: lot.vendorId,
      species: lot.species,
      storageType: lot.storageType,
      catchDate: lot.catchDate,
      catchLocation: lot.catchLocation,
      landingSite: lot.landingSite,
      weight: lot.weight.toString(),
      weightUnit: lot.weightUnit,
      freshnessGrade: lot.freshnessGrade,
      qualityScore: lot.qualityScore,
      foodSafetyStatus: lot.foodSafetyStatus,
      statusNotes: lot.statusNotes,
      createdAt: lot.createdAt,
    };
  }
}
