import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { RoleName, WasteDisposalRecord } from '@prisma/client';

import { RequestUser } from '../../../common/guards/jwt-auth.guard';
import { ProductsService } from '../../products/services/products.service';
import { VendorsRepository } from '../../vendors/repositories/vendors.repository';
import { CreateWasteDisposalRecordDto } from '../dto/create-waste-disposal-record.dto';
import { WasteDisposalRecordResponseEntity } from '../entities/waste-disposal-record-response.entity';
import { CustodyEventsRepository } from '../repositories/custody-events.repository';
import { SeafoodLotsRepository } from '../repositories/seafood-lots.repository';
import { WasteDisposalRecordsRepository } from '../repositories/waste-disposal-records.repository';

@Injectable()
export class WasteDisposalRecordsService {
  constructor(
    private readonly wasteDisposalRecordsRepository: WasteDisposalRecordsRepository,
    private readonly lotsRepository: SeafoodLotsRepository,
    private readonly vendorsRepository: VendorsRepository,
    private readonly productsService: ProductsService,
    private readonly custodyEventsRepository: CustodyEventsRepository,
  ) {}

  async create(
    user: RequestUser,
    dto: CreateWasteDisposalRecordDto,
  ): Promise<WasteDisposalRecordResponseEntity> {
    const lot = await this.lotsRepository.findById(dto.lotId);
    if (!lot) {
      throw new NotFoundException('Seafood lot not found');
    }

    if (!user.roles.includes(RoleName.ADMINISTRATOR)) {
      const vendor = await this.vendorsRepository.findByUserId(user.id);
      if (!vendor || vendor.id !== lot.vendorId) {
        throw new ForbiddenException('You do not own this lot');
      }
    }

    // Regulator-facing destruction evidence bar (food-safety.md's Product
    // Recall section) - the recording vendor/admin's own accountability is
    // sufficient for the other five reasons.
    if (dto.reason === 'RECALL_DESTRUCTION' && !dto.witnessName) {
      throw new BadRequestException('witnessName is required when reason is RECALL_DESTRUCTION');
    }

    if (dto.productId) {
      await this.productsService.adjustStockForDisposal(dto.productId, -Math.abs(dto.quantity), user.id);
    }

    const record = await this.wasteDisposalRecordsRepository.create({
      lotId: dto.lotId,
      productId: dto.productId,
      recallId: dto.recallId,
      quantity: dto.quantity,
      weightUnit: dto.weightUnit,
      reason: dto.reason,
      disposalMethod: dto.disposalMethod,
      evidencePhotoUrls: dto.evidencePhotoUrls,
      witnessName: dto.witnessName,
      witnessTitle: dto.witnessTitle,
      witnessSignatureUrl: dto.witnessSignatureUrl,
      recordedById: user.id,
    });

    // The lot's custody chain gets an explicit end-state instead of
    // silently stopping - DISPOSAL sets only fromUserId (whoever disposed
    // of it; there is no downstream recipient).
    await this.custodyEventsRepository.create({
      lotId: dto.lotId,
      eventType: 'DISPOSAL',
      fromUserId: user.id,
    });

    return WasteDisposalRecordsService.toResponse(record);
  }

  async list(filters: { lotId?: string; recallId?: string }): Promise<WasteDisposalRecordResponseEntity[]> {
    const records = await this.wasteDisposalRecordsRepository.findMany(filters);
    return records.map((record) => WasteDisposalRecordsService.toResponse(record));
  }

  private static toResponse(record: WasteDisposalRecord): WasteDisposalRecordResponseEntity {
    return {
      id: record.id,
      lotId: record.lotId,
      productId: record.productId,
      recallId: record.recallId,
      quantity: record.quantity.toString(),
      weightUnit: record.weightUnit,
      reason: record.reason,
      disposalMethod: record.disposalMethod,
      evidencePhotoUrls: record.evidencePhotoUrls,
      witnessName: record.witnessName,
      witnessTitle: record.witnessTitle,
      witnessSignatureUrl: record.witnessSignatureUrl,
      recordedById: record.recordedById,
      disposedAt: record.disposedAt,
      createdAt: record.createdAt,
    };
  }
}
