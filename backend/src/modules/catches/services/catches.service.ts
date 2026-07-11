import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Prisma } from '@prisma/client';

import { CatchRegisteredEvent } from '../../../common/events/catch-registered.event';
import { ListCatchesDto } from '../dto/list-catches.dto';
import { RegisterCatchDto } from '../dto/register-catch.dto';
import { CatchesRepository, CatchWithItems, CreateCatchItemInput } from '../repositories/catches.repository';
import { FishermenRepository } from '../repositories/fishermen.repository';
import { LandingSitesRepository } from '../repositories/landing-sites.repository';
import { SpeciesRepository } from '../repositories/species.repository';
import { VesselsRepository } from '../repositories/vessels.repository';
import { assertSpeciesInSeason, assertSpeciesSellable } from '../utils/species-validation.util';

export interface PaginatedCatches {
  items: CatchWithItems[];
  total: number;
  page: number;
  pageSize: number;
}

@Injectable()
export class CatchesService {
  constructor(
    private readonly catchesRepository: CatchesRepository,
    private readonly fishermenRepository: FishermenRepository,
    private readonly landingSitesRepository: LandingSitesRepository,
    private readonly speciesRepository: SpeciesRepository,
    private readonly vesselsRepository: VesselsRepository,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  async register(userId: string, dto: RegisterCatchDto): Promise<CatchWithItems> {
    const fisherman = await this.fishermenRepository.findByUserId(userId);
    if (!fisherman) {
      throw new NotFoundException('No fisherman profile exists for this account');
    }
    if (fisherman.status !== 'APPROVED') {
      throw new ForbiddenException('Only approved fishermen can register catches');
    }

    const landingSite = await this.landingSitesRepository.findById(dto.landingSiteId);
    if (!landingSite) {
      throw new NotFoundException('Landing site not found');
    }

    if (dto.vesselId) {
      const vessel = await this.vesselsRepository.findById(dto.vesselId);
      if (!vessel) {
        throw new NotFoundException('Vessel not found');
      }
      if (vessel.ownerFishermanId !== fisherman.id) {
        throw new ForbiddenException('You do not own this vessel');
      }
    }

    const catchDate = new Date(dto.catchDate);
    const items: CreateCatchItemInput[] = [];
    for (const itemDto of dto.items) {
      const species = await this.speciesRepository.findById(itemDto.speciesId);
      if (!species) {
        throw new NotFoundException(`Species not found: ${itemDto.speciesId}`);
      }
      assertSpeciesSellable(species);
      assertSpeciesInSeason(species, catchDate);
      items.push({
        speciesId: itemDto.speciesId,
        weight: itemDto.weight,
        weightUnit: itemDto.weightUnit,
        estimatedFreshness: itemDto.estimatedFreshness,
      });
    }

    const created = await this.createCatchWithUniqueCatchNumber(fisherman.id, dto, items, catchDate);

    await this.eventEmitter.emitAsync(
      CatchRegisteredEvent.eventName,
      new CatchRegisteredEvent(created.id, userId),
    );

    return created;
  }

  async getById(id: string): Promise<CatchWithItems> {
    const record = await this.catchesRepository.findById(id);
    if (!record) {
      throw new NotFoundException('Catch not found');
    }
    return record;
  }

  async getMine(userId: string, page: { page: number; pageSize: number }): Promise<PaginatedCatches> {
    const fisherman = await this.fishermenRepository.findByUserId(userId);
    if (!fisherman) {
      throw new NotFoundException('No fisherman profile exists for this account');
    }

    const { items, total } = await this.catchesRepository.findMany(
      { fishermanId: fisherman.id },
      { skip: (page.page - 1) * page.pageSize, take: page.pageSize },
    );

    return { items, total, page: page.page, pageSize: page.pageSize };
  }

  async list(dto: ListCatchesDto): Promise<PaginatedCatches> {
    const { items, total } = await this.catchesRepository.findMany(
      { fishermanId: dto.fishermanId },
      { skip: (dto.page - 1) * dto.pageSize, take: dto.pageSize },
    );

    return { items, total, page: dto.page, pageSize: dto.pageSize };
  }

  // Mirrors SeafoodLotsService's lotNumber generation: read-then-increment
  // is not atomic under concurrent registrations, so retry on a unique
  // violation (re-reading the count each time) rather than serializing
  // every catch registration behind a lock.
  private async createCatchWithUniqueCatchNumber(
    fishermanId: string,
    dto: RegisterCatchDto,
    items: CreateCatchItemInput[],
    catchDate: Date,
  ): Promise<CatchWithItems> {
    const MAX_ATTEMPTS = 5;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const catchNumber = await this.generateCatchNumber();
      try {
        return await this.catchesRepository.create({
          catchNumber,
          fishermanId,
          vesselId: dto.vesselId,
          landingSiteId: dto.landingSiteId,
          catchDate,
          latitude: dto.latitude,
          longitude: dto.longitude,
          fishingArea: dto.fishingArea,
          photos: dto.photos,
          items,
        });
      } catch (error) {
        const isCollision =
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === 'P2002' &&
          (error.meta?.target as string[] | undefined)?.includes('catchNumber');
        if (!isCollision || attempt === MAX_ATTEMPTS) {
          throw error;
        }
      }
    }
    throw new Error('Failed to generate a unique catch number');
  }

  private async generateCatchNumber(): Promise<string> {
    const year = new Date().getFullYear();
    const countThisYear = await this.catchesRepository.countCreatedThisYear(year);
    return `CATCH-${year}-${String(countThisYear + 1).padStart(6, '0')}`;
  }
}
