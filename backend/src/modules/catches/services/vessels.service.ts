import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Vessel } from '@prisma/client';

import { ASSIGNABLE_VESSEL_STATUSES } from '../dto/update-vessel-status.dto';
import { RegisterVesselDto } from '../dto/register-vessel.dto';
import { FishermenRepository } from '../repositories/fishermen.repository';
import { VesselsRepository } from '../repositories/vessels.repository';

export interface PaginatedVessels {
  items: Vessel[];
  total: number;
  page: number;
  pageSize: number;
}

@Injectable()
export class VesselsService {
  constructor(
    private readonly vesselsRepository: VesselsRepository,
    private readonly fishermenRepository: FishermenRepository,
  ) {}

  async register(userId: string, dto: RegisterVesselDto): Promise<Vessel> {
    const fisherman = await this.fishermenRepository.findByUserId(userId);
    if (!fisherman) {
      throw new NotFoundException('No fisherman profile exists for this account');
    }
    if (fisherman.status !== 'APPROVED') {
      throw new ForbiddenException('Only approved fishermen can register a vessel');
    }

    const existing = await this.vesselsRepository.findByRegistrationNumber(dto.registrationNumber);
    if (existing) {
      throw new ConflictException('A vessel with this registration number already exists');
    }

    return this.vesselsRepository.create({ ownerFishermanId: fisherman.id, ...dto });
  }

  async getMine(userId: string, page: { page: number; pageSize: number }): Promise<PaginatedVessels> {
    const fisherman = await this.fishermenRepository.findByUserId(userId);
    if (!fisherman) {
      throw new NotFoundException('No fisherman profile exists for this account');
    }

    const { items, total } = await this.vesselsRepository.findMany(
      { ownerFishermanId: fisherman.id },
      { skip: (page.page - 1) * page.pageSize, take: page.pageSize },
    );

    return { items, total, page: page.page, pageSize: page.pageSize };
  }

  async list(page: { page: number; pageSize: number }): Promise<PaginatedVessels> {
    const { items, total } = await this.vesselsRepository.findMany(
      {},
      { skip: (page.page - 1) * page.pageSize, take: page.pageSize },
    );

    return { items, total, page: page.page, pageSize: page.pageSize };
  }

  async updateStatus(
    id: string,
    status: (typeof ASSIGNABLE_VESSEL_STATUSES)[number],
  ): Promise<Vessel> {
    const vessel = await this.vesselsRepository.findById(id);
    if (!vessel) {
      throw new NotFoundException('Vessel not found');
    }
    return this.vesselsRepository.updateStatus(id, status);
  }
}
