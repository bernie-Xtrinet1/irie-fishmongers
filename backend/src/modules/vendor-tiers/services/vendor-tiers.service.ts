import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { VendorDowngradeEvent, VendorTier, VendorUpgradeRequest } from '@prisma/client';

import { VendorsRepository } from '../../vendors/repositories/vendors.repository';
import { DowngradeVendorDto } from '../dto/downgrade-vendor.dto';
import { ListUpgradeRequestsDto } from '../dto/list-upgrade-requests.dto';
import { RequestTierUpgradeDto } from '../dto/request-tier-upgrade.dto';
import { ReviewUpgradeRequestDto } from '../dto/review-upgrade-request.dto';
import { PaginatedDowngradeEventsEntity } from '../entities/paginated-downgrade-events.entity';
import { PaginatedUpgradeRequestsEntity } from '../entities/paginated-upgrade-requests.entity';
import { VendorDowngradeEventResponseEntity } from '../entities/vendor-downgrade-event-response.entity';
import { VendorUpgradeRequestResponseEntity } from '../entities/vendor-upgrade-request-response.entity';
import { VendorDowngradeEventsRepository } from '../repositories/vendor-downgrade-events.repository';
import { VendorUpgradeRequestsRepository } from '../repositories/vendor-upgrade-requests.repository';
import { TIER_RANK } from '../vendor-tier.constants';
import { VendorDocumentsService } from './vendor-documents.service';

@Injectable()
export class VendorTiersService {
  constructor(
    private readonly vendorsRepository: VendorsRepository,
    private readonly upgradeRequestsRepository: VendorUpgradeRequestsRepository,
    private readonly downgradeEventsRepository: VendorDowngradeEventsRepository,
    private readonly documentsService: VendorDocumentsService,
  ) {}

  async requestUpgrade(
    userId: string,
    dto: RequestTierUpgradeDto,
  ): Promise<VendorUpgradeRequestResponseEntity> {
    const vendor = await this.getOwnVendorProfile(userId);

    if (TIER_RANK[dto.requestedTier] <= TIER_RANK[vendor.tier]) {
      throw new BadRequestException('The requested tier must be higher than the current tier');
    }

    const existing = await this.upgradeRequestsRepository.findPendingByVendorId(vendor.id);
    if (existing) {
      throw new ConflictException('This vendor already has a pending upgrade request');
    }

    const created = await this.upgradeRequestsRepository.create({
      vendorId: vendor.id,
      requestedTier: dto.requestedTier,
      reason: dto.reason,
    });

    return VendorTiersService.toUpgradeRequestResponse(created);
  }

  async listUpgradeRequests(dto: ListUpgradeRequestsDto): Promise<PaginatedUpgradeRequestsEntity> {
    const { items, total } = await this.upgradeRequestsRepository.findMany(dto.status, {
      skip: (dto.page - 1) * dto.pageSize,
      take: dto.pageSize,
    });

    return {
      items: items.map((item) => VendorTiersService.toUpgradeRequestResponse(item)),
      total,
      page: dto.page,
      pageSize: dto.pageSize,
    };
  }

  async reviewUpgradeRequest(
    adminId: string,
    requestId: string,
    dto: ReviewUpgradeRequestDto,
  ): Promise<VendorUpgradeRequestResponseEntity> {
    const request = await this.upgradeRequestsRepository.findById(requestId);
    if (!request) {
      throw new NotFoundException('Upgrade request not found');
    }
    if (request.status !== 'PENDING') {
      throw new BadRequestException('This upgrade request has already been reviewed');
    }

    if (dto.decision === 'REJECTED') {
      const rejected = await this.upgradeRequestsRepository.updateStatus(requestId, 'REJECTED', {
        reviewedById: adminId,
        reviewedAt: new Date(),
        reviewNotes: dto.reviewNotes,
      });
      return VendorTiersService.toUpgradeRequestResponse(rejected);
    }

    const canSell = await this.documentsService.computeCanSell(request.vendorId, request.requestedTier);
    if (!canSell) {
      throw new BadRequestException(
        'This vendor is missing required, approved compliance documents for the requested tier',
      );
    }

    const approved = await this.upgradeRequestsRepository.updateStatus(requestId, 'APPROVED', {
      reviewedById: adminId,
      reviewedAt: new Date(),
      reviewNotes: dto.reviewNotes,
    });
    await this.vendorsRepository.updateTier(request.vendorId, request.requestedTier);

    return VendorTiersService.toUpgradeRequestResponse(approved);
  }

  async downgrade(
    adminId: string,
    vendorId: string,
    dto: DowngradeVendorDto,
  ): Promise<VendorDowngradeEventResponseEntity> {
    const vendor = await this.vendorsRepository.findById(vendorId);
    if (!vendor) {
      throw new NotFoundException('Vendor not found');
    }
    if (TIER_RANK[dto.toTier] >= TIER_RANK[vendor.tier]) {
      throw new BadRequestException('A downgrade must move the vendor to a strictly lower tier');
    }

    const event = await this.downgradeEventsRepository.create({
      vendorId,
      fromTier: vendor.tier,
      toTier: dto.toTier,
      reason: dto.reason,
      triggeredById: adminId,
      notes: dto.notes,
    });
    await this.vendorsRepository.updateTier(vendorId, dto.toTier);

    return VendorTiersService.toDowngradeEventResponse(event);
  }

  async listDowngradeEvents(
    vendorId: string,
    page: { page: number; pageSize: number },
  ): Promise<PaginatedDowngradeEventsEntity> {
    const { items, total } = await this.downgradeEventsRepository.findByVendorId(vendorId, {
      skip: (page.page - 1) * page.pageSize,
      take: page.pageSize,
    });

    return {
      items: items.map((item) => VendorTiersService.toDowngradeEventResponse(item)),
      total,
      page: page.page,
      pageSize: page.pageSize,
    };
  }

  private async getOwnVendorProfile(userId: string): Promise<{ id: string; tier: VendorTier }> {
    const vendor = await this.vendorsRepository.findByUserId(userId);
    if (!vendor) {
      throw new NotFoundException('No vendor profile exists for this account');
    }
    return vendor;
  }

  private static toUpgradeRequestResponse(
    request: VendorUpgradeRequest,
  ): VendorUpgradeRequestResponseEntity {
    return {
      id: request.id,
      vendorId: request.vendorId,
      requestedTier: request.requestedTier,
      status: request.status,
      reason: request.reason,
      reviewedById: request.reviewedById,
      reviewedAt: request.reviewedAt,
      reviewNotes: request.reviewNotes,
      createdAt: request.createdAt,
    };
  }

  private static toDowngradeEventResponse(
    event: VendorDowngradeEvent,
  ): VendorDowngradeEventResponseEntity {
    return {
      id: event.id,
      vendorId: event.vendorId,
      fromTier: event.fromTier,
      toTier: event.toTier,
      reason: event.reason,
      triggeredById: event.triggeredById,
      notes: event.notes,
      createdAt: event.createdAt,
    };
  }
}
