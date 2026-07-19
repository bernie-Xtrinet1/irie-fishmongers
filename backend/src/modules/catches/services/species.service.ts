import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Species } from '@prisma/client';

import { CreateSpeciesDto } from '../dto/create-species.dto';
import { UpdateSpeciesDto } from '../dto/update-species.dto';
import { SpeciesRepository } from '../repositories/species.repository';

@Injectable()
export class SpeciesService {
  constructor(private readonly speciesRepository: SpeciesRepository) {}

  async create(dto: CreateSpeciesDto): Promise<Species> {
    const existing = await this.speciesRepository.findByScientificName(dto.scientificName);
    if (existing) {
      throw new ConflictException(`Species "${dto.scientificName}" already exists`);
    }
    return this.speciesRepository.create(dto);
  }

  async update(id: string, dto: UpdateSpeciesDto): Promise<Species> {
    await this.getById(id);
    return this.speciesRepository.update(id, dto);
  }

  list(): Promise<Species[]> {
    return this.speciesRepository.findAll();
  }

  async getById(id: string): Promise<Species> {
    const species = await this.speciesRepository.findById(id);
    if (!species) {
      throw new NotFoundException('Species not found');
    }
    return species;
  }
}
