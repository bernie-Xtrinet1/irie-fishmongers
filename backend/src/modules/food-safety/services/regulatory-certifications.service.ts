import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { CertificationStatus, RegulatoryCertification } from '@prisma/client';

import { FishermenRepository } from '../../catches/repositories/fishermen.repository';
import { LandingSitesRepository } from '../../catches/repositories/landing-sites.repository';
import { VendorsRepository } from '../../vendors/repositories/vendors.repository';
import { CreateRegulatoryCertificationDto } from '../dto/create-regulatory-certification.dto';
import { ListRegulatoryCertificationsDto } from '../dto/list-regulatory-certifications.dto';
import { UpdateRegulatoryCertificationDto } from '../dto/update-regulatory-certification.dto';
import { PaginatedRegulatoryCertificationsEntity } from '../entities/paginated-regulatory-certifications.entity';
import { RegulatoryCertificationResponseEntity } from '../entities/regulatory-certification-response.entity';
import { RegulatoryAuthoritiesRepository } from '../repositories/regulatory-authorities.repository';
import { RegulatoryCertificationsRepository } from '../repositories/regulatory-certifications.repository';

// PENDING is only reachable from create(); PENDING -> ACTIVE only through
// the explicit activate() action (never through update()). EXPIRED ->
// ACTIVE is a renewal and requires a new, future expiryDate.
const ALLOWED_STATUS_TRANSITIONS: Record<CertificationStatus, CertificationStatus[]> = {
  PENDING: [],
  ACTIVE: ['SUSPENDED', 'REVOKED'],
  SUSPENDED: ['ACTIVE', 'REVOKED'],
  EXPIRED: ['ACTIVE', 'REVOKED'],
  REVOKED: [],
};

@Injectable()
export class RegulatoryCertificationsService {
  constructor(
    private readonly certificationsRepository: RegulatoryCertificationsRepository,
    private readonly authoritiesRepository: RegulatoryAuthoritiesRepository,
    private readonly vendorsRepository: VendorsRepository,
    private readonly fishermenRepository: FishermenRepository,
    private readonly landingSitesRepository: LandingSitesRepository,
  ) {}

  async create(dto: CreateRegulatoryCertificationDto): Promise<RegulatoryCertificationResponseEntity> {
    const subjectCount = [dto.vendorId, dto.fishermanId, dto.landingSiteId].filter(Boolean).length;
    if (subjectCount !== 1) {
      throw new BadRequestException('Exactly one of vendorId, fishermanId, or landingSiteId must be set');
    }

    const authority = await this.authoritiesRepository.findById(dto.issuingAuthorityId);
    if (!authority) {
      throw new NotFoundException('Regulatory authority not found');
    }

    if (dto.vendorId && !(await this.vendorsRepository.findById(dto.vendorId))) {
      throw new NotFoundException('Vendor not found');
    }
    if (dto.fishermanId && !(await this.fishermenRepository.findById(dto.fishermanId))) {
      throw new NotFoundException('Fisherman not found');
    }
    if (dto.landingSiteId && !(await this.landingSitesRepository.findById(dto.landingSiteId))) {
      throw new NotFoundException('Landing site not found');
    }

    const certification = await this.certificationsRepository.create({
      vendorId: dto.vendorId,
      fishermanId: dto.fishermanId,
      landingSiteId: dto.landingSiteId,
      certificateType: dto.certificateType,
      certificateNumber: dto.certificateNumber,
      issuingAuthorityId: dto.issuingAuthorityId,
      issuedDate: new Date(dto.issuedDate),
      expiryDate: dto.expiryDate ? new Date(dto.expiryDate) : undefined,
      documentUrl: dto.documentUrl,
    });

    return RegulatoryCertificationsService.toResponse(certification);
  }

  async activate(id: string): Promise<RegulatoryCertificationResponseEntity> {
    const certification = await this.certificationsRepository.findById(id);
    if (!certification) {
      throw new NotFoundException('Certification not found');
    }
    if (certification.status !== 'PENDING') {
      throw new BadRequestException('Only a PENDING certification can be activated');
    }

    const updated = await this.certificationsRepository.update(id, { status: 'ACTIVE' });
    return RegulatoryCertificationsService.toResponse(updated);
  }

  async update(id: string, dto: UpdateRegulatoryCertificationDto): Promise<RegulatoryCertificationResponseEntity> {
    const certification = await this.certificationsRepository.findById(id);
    if (!certification) {
      throw new NotFoundException('Certification not found');
    }

    if (dto.status) {
      if (!ALLOWED_STATUS_TRANSITIONS[certification.status].includes(dto.status)) {
        throw new BadRequestException(`Cannot move a ${certification.status} certification to ${dto.status}`);
      }
      if (certification.status === 'EXPIRED' && dto.status === 'ACTIVE') {
        if (!dto.expiryDate) {
          throw new BadRequestException('Renewing an EXPIRED certification requires a new expiryDate');
        }
        if (new Date(dto.expiryDate) <= new Date()) {
          throw new BadRequestException('The renewed expiryDate must be in the future');
        }
      }
    }

    const updated = await this.certificationsRepository.update(id, {
      status: dto.status,
      expiryDate: dto.expiryDate ? new Date(dto.expiryDate) : undefined,
      documentUrl: dto.documentUrl,
    });

    return RegulatoryCertificationsService.toResponse(updated);
  }

  async list(dto: ListRegulatoryCertificationsDto): Promise<PaginatedRegulatoryCertificationsEntity> {
    await this.syncExpiredStatuses();

    const { items, total } = await this.certificationsRepository.findMany(
      { vendorId: dto.vendorId, fishermanId: dto.fishermanId, landingSiteId: dto.landingSiteId },
      { skip: (dto.page - 1) * dto.pageSize, take: dto.pageSize },
    );

    return {
      items: items.map((item) => RegulatoryCertificationsService.toResponse(item)),
      total,
      page: dto.page,
      pageSize: dto.pageSize,
    };
  }

  // Computed-on-read, matching VendorDocumentsService.syncExpiredStatuses -
  // no scheduler exists in this codebase, so detection happens lazily
  // whenever certifications are actually listed.
  private async syncExpiredStatuses(): Promise<void> {
    const expired = await this.certificationsRepository.findActiveButExpired(new Date());
    await Promise.all(
      expired.map((certification) =>
        this.certificationsRepository.update(certification.id, { status: 'EXPIRED' }),
      ),
    );
  }

  private static toResponse(certification: RegulatoryCertification): RegulatoryCertificationResponseEntity {
    return {
      id: certification.id,
      vendorId: certification.vendorId,
      fishermanId: certification.fishermanId,
      landingSiteId: certification.landingSiteId,
      certificateType: certification.certificateType,
      certificateNumber: certification.certificateNumber,
      issuingAuthorityId: certification.issuingAuthorityId,
      issuedDate: certification.issuedDate,
      expiryDate: certification.expiryDate,
      status: certification.status,
      documentUrl: certification.documentUrl,
      createdAt: certification.createdAt,
    };
  }
}
