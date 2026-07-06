import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { PlatformCommissionConfig, VendorSettlement, VendorSettlementStatus } from '@prisma/client';

import { VendorsRepository } from '../../vendors/repositories/vendors.repository';
import { CreateAdjustmentDto } from '../dto/create-adjustment.dto';
import { CreateCommissionRateDto } from '../dto/create-commission-rate.dto';
import { ListVendorSettlementsDto } from '../dto/list-vendor-settlements.dto';
import { AdjustmentResponseEntity } from '../entities/adjustment-response.entity';
import { CommissionRateResponseEntity } from '../entities/commission-rate-response.entity';
import { GenerateVendorSettlementsResultEntity } from '../entities/generate-vendor-settlements-result.entity';
import { PaginatedVendorSettlementsEntity } from '../entities/paginated-vendor-settlements.entity';
import { VendorSettlementResponseEntity } from '../entities/vendor-settlement-response.entity';
import { CommissionRateConfigsRepository } from '../repositories/commission-rate-configs.repository';
import { VendorSettlementAdjustmentsRepository } from '../repositories/vendor-settlement-adjustments.repository';
import { VendorSettlementsRepository } from '../repositories/vendor-settlements.repository';

const ALLOWED_STATUS_TRANSITIONS: Record<VendorSettlementStatus, VendorSettlementStatus[]> = {
  PENDING: ['APPROVED', 'FAILED'],
  APPROVED: ['PAID', 'FAILED'],
  PAID: [],
  FAILED: [],
};

@Injectable()
export class VendorSettlementsService {
  constructor(
    private readonly vendorSettlementsRepository: VendorSettlementsRepository,
    private readonly adjustmentsRepository: VendorSettlementAdjustmentsRepository,
    private readonly commissionRateConfigsRepository: CommissionRateConfigsRepository,
    private readonly vendorsRepository: VendorsRepository,
  ) {}

  async generateSettlements(): Promise<GenerateVendorSettlementsResultEntity> {
    const rateConfig = await this.commissionRateConfigsRepository.findCurrent();
    if (!rateConfig) {
      throw new InternalServerErrorException('No commission rate configuration exists');
    }

    const eligibleVendorOrders = await this.vendorSettlementsRepository.findEligibleVendorOrders();
    const commissionRate = rateConfig.commissionRate.toNumber();

    for (const vendorOrder of eligibleVendorOrders) {
      const grossAmount = vendorOrder.subtotal.toNumber();
      const platformFee = grossAmount * commissionRate;
      const netAmount = grossAmount - platformFee;

      await this.vendorSettlementsRepository.create({
        vendorId: vendorOrder.vendorId,
        vendorOrderId: vendorOrder.id,
        grossAmount,
        platformFee,
        netAmount,
      });
    }

    return { settlementsCreated: eligibleVendorOrders.length };
  }

  async getMine(
    userId: string,
    page: { page: number; pageSize: number },
  ): Promise<PaginatedVendorSettlementsEntity> {
    const vendor = await this.vendorsRepository.findByUserId(userId);
    if (!vendor) {
      throw new NotFoundException('No vendor profile exists for this account');
    }

    const { items, total } = await this.vendorSettlementsRepository.findManyByVendor(vendor.id, {
      skip: (page.page - 1) * page.pageSize,
      take: page.pageSize,
    });

    return {
      items: await Promise.all(items.map((item) => this.toResponse(item))),
      total,
      page: page.page,
      pageSize: page.pageSize,
    };
  }

  async list(dto: ListVendorSettlementsDto): Promise<PaginatedVendorSettlementsEntity> {
    const { items, total } = await this.vendorSettlementsRepository.findMany(
      { vendorId: dto.vendorId, status: dto.status },
      { skip: (dto.page - 1) * dto.pageSize, take: dto.pageSize },
    );

    return {
      items: await Promise.all(items.map((item) => this.toResponse(item))),
      total,
      page: dto.page,
      pageSize: dto.pageSize,
    };
  }

  async updateStatus(
    id: string,
    status: VendorSettlementStatus,
    notes?: string,
  ): Promise<VendorSettlementResponseEntity> {
    const settlement = await this.vendorSettlementsRepository.findById(id);
    if (!settlement) {
      throw new NotFoundException('Settlement not found');
    }
    if (!ALLOWED_STATUS_TRANSITIONS[settlement.status].includes(status)) {
      throw new BadRequestException(`Cannot move a ${settlement.status} settlement to ${status}`);
    }

    const updated = await this.vendorSettlementsRepository.updateStatus(id, status, {
      paymentDate: status === 'PAID' ? new Date() : undefined,
      notes,
    });

    return this.toResponse(updated);
  }

  async createAdjustment(
    settlementId: string,
    dto: CreateAdjustmentDto,
  ): Promise<AdjustmentResponseEntity> {
    const settlement = await this.vendorSettlementsRepository.findById(settlementId);
    if (!settlement) {
      throw new NotFoundException('Settlement not found');
    }
    if (dto.amount === 0) {
      throw new BadRequestException('Adjustment amount cannot be zero');
    }

    const adjustment = await this.adjustmentsRepository.create({
      settlementId,
      amount: dto.amount,
      reason: dto.reason,
    });

    return VendorSettlementsService.toAdjustmentResponse(adjustment);
  }

  async getCurrentCommissionRate(): Promise<CommissionRateResponseEntity> {
    const rateConfig = await this.commissionRateConfigsRepository.findCurrent();
    if (!rateConfig) {
      throw new InternalServerErrorException('No commission rate configuration exists');
    }
    return VendorSettlementsService.toCommissionRateResponse(rateConfig);
  }

  async createCommissionRate(dto: CreateCommissionRateDto): Promise<CommissionRateResponseEntity> {
    const rateConfig = await this.commissionRateConfigsRepository.create(dto.commissionRate);
    return VendorSettlementsService.toCommissionRateResponse(rateConfig);
  }

  private async toResponse(settlement: VendorSettlement): Promise<VendorSettlementResponseEntity> {
    const adjustmentsSum = await this.adjustmentsRepository.sumBySettlementId(settlement.id);
    const adjustedNetAmount = settlement.netAmount.toNumber() + adjustmentsSum;

    return {
      id: settlement.id,
      vendorId: settlement.vendorId,
      vendorOrderId: settlement.vendorOrderId,
      grossAmount: settlement.grossAmount.toString(),
      platformFee: settlement.platformFee.toString(),
      netAmount: settlement.netAmount.toString(),
      adjustedNetAmount: adjustedNetAmount.toString(),
      status: settlement.status,
      paymentDate: settlement.paymentDate,
      notes: settlement.notes,
      createdAt: settlement.createdAt,
    };
  }

  private static toAdjustmentResponse(adjustment: {
    id: string;
    settlementId: string;
    amount: { toString(): string };
    reason: string;
    createdAt: Date;
  }): AdjustmentResponseEntity {
    return {
      id: adjustment.id,
      settlementId: adjustment.settlementId,
      amount: adjustment.amount.toString(),
      reason: adjustment.reason,
      createdAt: adjustment.createdAt,
    };
  }

  private static toCommissionRateResponse(
    rateConfig: PlatformCommissionConfig,
  ): CommissionRateResponseEntity {
    return {
      id: rateConfig.id,
      commissionRate: rateConfig.commissionRate.toString(),
      createdAt: rateConfig.createdAt,
    };
  }
}
