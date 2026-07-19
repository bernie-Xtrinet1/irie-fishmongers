import { Injectable } from '@nestjs/common';
import { RegulatoryAuthority } from '@prisma/client';

import { CreateRegulatoryAuthorityDto } from '../dto/create-regulatory-authority.dto';
import { RegulatoryAuthorityResponseEntity } from '../entities/regulatory-authority-response.entity';
import { RegulatoryAuthoritiesRepository } from '../repositories/regulatory-authorities.repository';

@Injectable()
export class RegulatoryAuthoritiesService {
  constructor(private readonly authoritiesRepository: RegulatoryAuthoritiesRepository) {}

  async create(dto: CreateRegulatoryAuthorityDto): Promise<RegulatoryAuthorityResponseEntity> {
    const authority = await this.authoritiesRepository.create(dto);
    return RegulatoryAuthoritiesService.toResponse(authority);
  }

  async list(): Promise<RegulatoryAuthorityResponseEntity[]> {
    const authorities = await this.authoritiesRepository.findAll();
    return authorities.map((authority) => RegulatoryAuthoritiesService.toResponse(authority));
  }

  private static toResponse(authority: RegulatoryAuthority): RegulatoryAuthorityResponseEntity {
    return {
      id: authority.id,
      name: authority.name,
      country: authority.country,
      contactEmail: authority.contactEmail,
      contactPhone: authority.contactPhone,
      website: authority.website,
      createdAt: authority.createdAt,
    };
  }
}
