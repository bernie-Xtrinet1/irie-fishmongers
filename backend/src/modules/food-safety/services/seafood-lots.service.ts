import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { FoodSafetyStatus, RoleName, SeafoodLot } from '@prisma/client';

import { RequestUser } from '../../../common/guards/jwt-auth.guard';
import { VendorsRepository } from '../../vendors/repositories/vendors.repository';
import { CreateSeafoodLotDto } from '../dto/create-seafood-lot.dto';
import { ListSeafoodLotsDto } from '../dto/list-seafood-lots.dto';
import { PaginatedSeafoodLotsEntity } from '../entities/paginated-seafood-lots.entity';
import { SeafoodLotPublicEntity } from '../entities/seafood-lot-public.entity';
import { SeafoodLotResponseEntity } from '../entities/seafood-lot-response.entity';
import { LotWithVendor, SeafoodLotsRepository } from '../repositories/seafood-lots.repository';
import { TemperatureAlertsRepository } from '../repositories/temperature-alerts.repository';

@Injectable()
export class SeafoodLotsService {
  constructor(
    private readonly lotsRepository: SeafoodLotsRepository,
    private readonly vendorsRepository: VendorsRepository,
    private readonly alertsRepository: TemperatureAlertsRepository,
  ) {}

  async register(userId: string, dto: CreateSeafoodLotDto): Promise<SeafoodLotResponseEntity> {
    const vendor = await this.vendorsRepository.findByUserId(userId);
    if (!vendor) {
      throw new NotFoundException('No vendor profile exists for this account');
    }
    if (vendor.status !== 'APPROVED') {
      throw new ForbiddenException('Only approved vendors can register seafood lots');
    }

    const lotNumber = await this.generateLotNumber();
    const lot = await this.lotsRepository.create({
      lotNumber,
      vendorId: vendor.id,
      species: dto.species,
      storageType: dto.storageType,
      catchDate: new Date(dto.catchDate),
      catchLocation: dto.catchLocation,
      landingSite: dto.landingSite,
      weight: dto.weight,
      weightUnit: dto.weightUnit,
    });

    return SeafoodLotsService.toResponse(lot);
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
    id: string,
    status: FoodSafetyStatus,
    reason?: string,
  ): Promise<SeafoodLotResponseEntity> {
    const lot = await this.lotsRepository.findById(id);
    if (!lot) {
      throw new NotFoundException('Seafood lot not found');
    }

    const updated = await this.lotsRepository.updateStatus(id, status, reason);
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
