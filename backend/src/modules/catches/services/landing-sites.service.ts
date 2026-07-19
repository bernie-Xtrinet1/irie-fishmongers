import { Injectable, NotFoundException } from '@nestjs/common';
import { LandingSite } from '@prisma/client';

import { CreateLandingSiteDto } from '../dto/create-landing-site.dto';
import { UpdateLandingSiteDto } from '../dto/update-landing-site.dto';
import { LandingSitesRepository } from '../repositories/landing-sites.repository';

@Injectable()
export class LandingSitesService {
  constructor(private readonly landingSitesRepository: LandingSitesRepository) {}

  create(dto: CreateLandingSiteDto): Promise<LandingSite> {
    return this.landingSitesRepository.create(dto);
  }

  async update(id: string, dto: UpdateLandingSiteDto): Promise<LandingSite> {
    const site = await this.landingSitesRepository.findById(id);
    if (!site) {
      throw new NotFoundException('Landing site not found');
    }
    return this.landingSitesRepository.update(id, dto);
  }

  list(): Promise<LandingSite[]> {
    return this.landingSitesRepository.findAll();
  }

  async getById(id: string): Promise<LandingSite> {
    const site = await this.landingSitesRepository.findById(id);
    if (!site) {
      throw new NotFoundException('Landing site not found');
    }
    return site;
  }
}
