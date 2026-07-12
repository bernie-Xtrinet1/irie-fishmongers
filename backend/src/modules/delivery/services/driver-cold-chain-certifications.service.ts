import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DriverColdChainCertification } from '@prisma/client';

import { CreateDriverColdChainCertificationDto } from '../dto/create-driver-cold-chain-certification.dto';
import { DriversRepository } from '../repositories/drivers.repository';
import { DriverColdChainCertificationsRepository } from '../repositories/driver-cold-chain-certifications.repository';

export interface PaginatedDriverColdChainCertifications {
  items: DriverColdChainCertification[];
  total: number;
  page: number;
  pageSize: number;
}

@Injectable()
export class DriverColdChainCertificationsService {
  constructor(
    private readonly certificationsRepository: DriverColdChainCertificationsRepository,
    private readonly driversRepository: DriversRepository,
  ) {}

  async create(
    driverId: string,
    dto: CreateDriverColdChainCertificationDto,
  ): Promise<DriverColdChainCertification> {
    const driver = await this.driversRepository.findById(driverId);
    if (!driver) {
      throw new NotFoundException('Driver not found');
    }

    const issuedAt = new Date(dto.issuedAt);
    const expiresAt = new Date(dto.expiresAt);
    if (expiresAt <= issuedAt) {
      throw new BadRequestException('expiresAt must be after issuedAt');
    }

    return this.certificationsRepository.create({
      driverId,
      issuedBy: dto.issuedBy,
      issuedAt,
      expiresAt,
      documentUrl: dto.documentUrl,
    });
  }

  async findByDriverId(
    driverId: string,
    page: { page: number; pageSize: number },
  ): Promise<PaginatedDriverColdChainCertifications> {
    const driver = await this.driversRepository.findById(driverId);
    if (!driver) {
      throw new NotFoundException('Driver not found');
    }

    const { items, total } = await this.certificationsRepository.findByDriverId(driverId, {
      skip: (page.page - 1) * page.pageSize,
      take: page.pageSize,
    });

    return { items, total, page: page.page, pageSize: page.pageSize };
  }

  async revoke(id: string): Promise<DriverColdChainCertification> {
    const certification = await this.certificationsRepository.findById(id);
    if (!certification) {
      throw new NotFoundException('Certification not found');
    }
    if (certification.status === 'REVOKED') {
      throw new BadRequestException('This certification has already been revoked');
    }
    return this.certificationsRepository.revoke(id);
  }

  // Mirrors VendorDocumentsService.computeCanSell()'s "does this party
  // currently satisfy a compliance requirement" pattern.
  async computeIsCertified(driverId: string): Promise<boolean> {
    const active = await this.certificationsRepository.findActiveByDriverId(driverId, new Date());
    return active.length > 0;
  }
}
