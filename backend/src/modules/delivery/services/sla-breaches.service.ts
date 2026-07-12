import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { SLABreach } from '@prisma/client';

import { ListSLABreachesDto } from '../dto/list-sla-breaches.dto';
import { SLABreachesRepository, ZoneBreachCounts } from '../repositories/sla-breaches.repository';

export interface PaginatedSLABreaches {
  items: SLABreach[];
  total: number;
  page: number;
  pageSize: number;
}

@Injectable()
export class SLABreachesService {
  constructor(private readonly slaBreachesRepository: SLABreachesRepository) {}

  async list(dto: ListSLABreachesDto): Promise<PaginatedSLABreaches> {
    const { items, total } = await this.slaBreachesRepository.findMany(
      { resolved: dto.resolved, type: dto.type },
      { skip: (dto.page - 1) * dto.pageSize, take: dto.pageSize },
    );

    return { items, total, page: dto.page, pageSize: dto.pageSize };
  }

  async resolve(id: string, resolvedById: string): Promise<SLABreach> {
    const breach = await this.slaBreachesRepository.findById(id);
    if (!breach) {
      throw new NotFoundException('SLA breach not found');
    }
    if (breach.resolved) {
      throw new BadRequestException('This SLA breach has already been resolved');
    }
    return this.slaBreachesRepository.resolve(id, resolvedById);
  }

  getZoneSummary(): Promise<ZoneBreachCounts[]> {
    return this.slaBreachesRepository.getBreachCountsByZone();
  }
}
