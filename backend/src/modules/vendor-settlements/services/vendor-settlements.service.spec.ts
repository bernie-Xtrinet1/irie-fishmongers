import { BadRequestException, InternalServerErrorException, NotFoundException } from '@nestjs/common';
import {
  PlatformCommissionConfig,
  Prisma,
  Vendor,
  VendorOrder,
  VendorSettlement,
  VendorSettlementAdjustment,
} from '@prisma/client';

import { VendorsRepository } from '../../vendors/repositories/vendors.repository';
import { CreateCommissionRateDto } from '../dto/create-commission-rate.dto';
import { CommissionRateConfigsRepository } from '../repositories/commission-rate-configs.repository';
import { VendorSettlementAdjustmentsRepository } from '../repositories/vendor-settlement-adjustments.repository';
import { VendorSettlementsRepository } from '../repositories/vendor-settlements.repository';
import { VendorSettlementsService } from './vendor-settlements.service';

function buildVendor(overrides: Partial<Vendor> = {}): Vendor {
  return {
    id: 'vendor-1',
    userId: 'vendor-user-1',
    businessName: "Vera's Catch",
    description: null,
    phone: null,
    parish: 'KINGSTON',
    logoUrl: null,
    status: 'APPROVED',
    termsAcceptedAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function buildVendorOrder(overrides: Partial<VendorOrder> = {}): VendorOrder {
  return {
    id: 'vo-1',
    orderId: 'order-1',
    vendorId: 'vendor-1',
    status: 'DELIVERED',
    subtotal: new Prisma.Decimal(1000),
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function buildRateConfig(overrides: Partial<PlatformCommissionConfig> = {}): PlatformCommissionConfig {
  return {
    id: 'rate-config-1',
    commissionRate: new Prisma.Decimal(0.1),
    createdAt: new Date(),
    ...overrides,
  };
}

function buildSettlement(overrides: Partial<VendorSettlement> = {}): VendorSettlement {
  return {
    id: 'settlement-1',
    vendorId: 'vendor-1',
    vendorOrderId: 'vo-1',
    grossAmount: new Prisma.Decimal(1000),
    platformFee: new Prisma.Decimal(100),
    netAmount: new Prisma.Decimal(900),
    status: 'PENDING',
    paymentDate: null,
    notes: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function buildAdjustment(overrides: Partial<VendorSettlementAdjustment> = {}): VendorSettlementAdjustment {
  return {
    id: 'adjustment-1',
    settlementId: 'settlement-1',
    amount: new Prisma.Decimal(-400),
    reason: 'Partial refund issued for damaged goods',
    createdAt: new Date(),
    ...overrides,
  };
}

describe('VendorSettlementsService', () => {
  let vendorSettlementsRepository: jest.Mocked<
    Pick<
      VendorSettlementsRepository,
      'findEligibleVendorOrders' | 'create' | 'findById' | 'updateStatus' | 'findManyByVendor' | 'findMany'
    >
  >;
  let adjustmentsRepository: jest.Mocked<
    Pick<VendorSettlementAdjustmentsRepository, 'create' | 'sumBySettlementId'>
  >;
  let commissionRateConfigsRepository: jest.Mocked<
    Pick<CommissionRateConfigsRepository, 'findCurrent' | 'create'>
  >;
  let vendorsRepository: jest.Mocked<Pick<VendorsRepository, 'findByUserId'>>;
  let service: VendorSettlementsService;

  beforeEach(() => {
    vendorSettlementsRepository = {
      findEligibleVendorOrders: jest.fn(),
      create: jest.fn(),
      findById: jest.fn(),
      updateStatus: jest.fn(),
      findManyByVendor: jest.fn(),
      findMany: jest.fn(),
    };
    adjustmentsRepository = { create: jest.fn(), sumBySettlementId: jest.fn().mockResolvedValue(0) };
    commissionRateConfigsRepository = { findCurrent: jest.fn(), create: jest.fn() };
    vendorsRepository = { findByUserId: jest.fn() };

    service = new VendorSettlementsService(
      vendorSettlementsRepository as unknown as VendorSettlementsRepository,
      adjustmentsRepository as unknown as VendorSettlementAdjustmentsRepository,
      commissionRateConfigsRepository as unknown as CommissionRateConfigsRepository,
      vendorsRepository as unknown as VendorsRepository,
    );
  });

  describe('generateSettlements', () => {
    it('creates a settlement for each eligible vendor order using the current rate', async () => {
      commissionRateConfigsRepository.findCurrent.mockResolvedValue(buildRateConfig());
      vendorSettlementsRepository.findEligibleVendorOrders.mockResolvedValue([buildVendorOrder()]);
      vendorSettlementsRepository.create.mockResolvedValue(buildSettlement());

      const result = await service.generateSettlements();

      expect(result.settlementsCreated).toBe(1);
      expect(vendorSettlementsRepository.create).toHaveBeenCalledWith({
        vendorId: 'vendor-1',
        vendorOrderId: 'vo-1',
        grossAmount: 1000,
        platformFee: 100,
        netAmount: 900,
      });
    });

    it('returns 0 when no vendor orders are eligible', async () => {
      commissionRateConfigsRepository.findCurrent.mockResolvedValue(buildRateConfig());
      vendorSettlementsRepository.findEligibleVendorOrders.mockResolvedValue([]);

      const result = await service.generateSettlements();
      expect(result.settlementsCreated).toBe(0);
      expect(vendorSettlementsRepository.create).not.toHaveBeenCalled();
    });

    it('throws when no commission rate configuration exists', async () => {
      commissionRateConfigsRepository.findCurrent.mockResolvedValue(null);
      await expect(service.generateSettlements()).rejects.toBeInstanceOf(
        InternalServerErrorException,
      );
    });
  });

  describe('getMine', () => {
    it("returns the vendor's own settlements with adjusted net amounts", async () => {
      vendorsRepository.findByUserId.mockResolvedValue(buildVendor());
      vendorSettlementsRepository.findManyByVendor.mockResolvedValue({
        items: [buildSettlement()],
        total: 1,
      });
      adjustmentsRepository.sumBySettlementId.mockResolvedValue(-300);

      const result = await service.getMine('vendor-user-1', { page: 1, pageSize: 20 });

      expect(result.total).toBe(1);
      expect(result.items[0]!.adjustedNetAmount).toBe('600');
    });

    it('throws when no vendor profile exists', async () => {
      vendorsRepository.findByUserId.mockResolvedValue(null);
      await expect(
        service.getMine('vendor-user-1', { page: 1, pageSize: 20 }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('list', () => {
    it('paginates settlements with filters', async () => {
      vendorSettlementsRepository.findMany.mockResolvedValue({ items: [buildSettlement()], total: 1 });
      const result = await service.list({ page: 1, pageSize: 20, status: 'PENDING' });
      expect(result.total).toBe(1);
      expect(vendorSettlementsRepository.findMany).toHaveBeenCalledWith(
        { vendorId: undefined, status: 'PENDING' },
        { skip: 0, take: 20 },
      );
    });
  });

  describe('updateStatus', () => {
    it('approves a pending settlement', async () => {
      vendorSettlementsRepository.findById.mockResolvedValue(buildSettlement());
      vendorSettlementsRepository.updateStatus.mockResolvedValue(
        buildSettlement({ status: 'APPROVED' }),
      );

      const result = await service.updateStatus('settlement-1', 'APPROVED');
      expect(result.status).toBe('APPROVED');
      expect(vendorSettlementsRepository.updateStatus).toHaveBeenCalledWith('settlement-1', 'APPROVED', {
        paymentDate: undefined,
        notes: undefined,
      });
    });

    it('sets a payment date when marking a settlement paid', async () => {
      vendorSettlementsRepository.findById.mockResolvedValue(
        buildSettlement({ status: 'APPROVED' }),
      );
      vendorSettlementsRepository.updateStatus.mockResolvedValue(
        buildSettlement({ status: 'PAID', paymentDate: new Date() }),
      );

      await service.updateStatus('settlement-1', 'PAID');

      expect(vendorSettlementsRepository.updateStatus).toHaveBeenCalledWith(
        'settlement-1',
        'PAID',
        expect.objectContaining({ paymentDate: expect.any(Date) as Date }),
      );
    });

    it('rejects skipping straight from PENDING to PAID', async () => {
      vendorSettlementsRepository.findById.mockResolvedValue(buildSettlement({ status: 'PENDING' }));
      await expect(service.updateStatus('settlement-1', 'PAID')).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('rejects any transition once a settlement is PAID', async () => {
      vendorSettlementsRepository.findById.mockResolvedValue(buildSettlement({ status: 'PAID' }));
      await expect(service.updateStatus('settlement-1', 'FAILED')).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('throws when the settlement does not exist', async () => {
      vendorSettlementsRepository.findById.mockResolvedValue(null);
      await expect(service.updateStatus('missing', 'APPROVED')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('createAdjustment', () => {
    const dto = { amount: -400, reason: 'Partial refund issued for damaged goods' };

    it('creates an adjustment for an existing settlement', async () => {
      vendorSettlementsRepository.findById.mockResolvedValue(buildSettlement());
      adjustmentsRepository.create.mockResolvedValue(buildAdjustment());

      const result = await service.createAdjustment('settlement-1', dto);
      expect(result.amount).toBe('-400');
      expect(adjustmentsRepository.create).toHaveBeenCalledWith({
        settlementId: 'settlement-1',
        amount: -400,
        reason: dto.reason,
      });
    });

    it('throws when the settlement does not exist', async () => {
      vendorSettlementsRepository.findById.mockResolvedValue(null);
      await expect(service.createAdjustment('missing', dto)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('rejects a zero-amount adjustment', async () => {
      vendorSettlementsRepository.findById.mockResolvedValue(buildSettlement());
      await expect(
        service.createAdjustment('settlement-1', { ...dto, amount: 0 }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('getCurrentCommissionRate', () => {
    it('returns the current commission rate', async () => {
      commissionRateConfigsRepository.findCurrent.mockResolvedValue(buildRateConfig());
      const result = await service.getCurrentCommissionRate();
      expect(result.commissionRate).toBe('0.1');
    });

    it('throws when no commission rate configuration exists', async () => {
      commissionRateConfigsRepository.findCurrent.mockResolvedValue(null);
      await expect(service.getCurrentCommissionRate()).rejects.toBeInstanceOf(
        InternalServerErrorException,
      );
    });
  });

  describe('createCommissionRate', () => {
    it('creates a new commission rate config', async () => {
      const dto: CreateCommissionRateDto = { commissionRate: 0.12 };
      commissionRateConfigsRepository.create.mockResolvedValue(
        buildRateConfig({ commissionRate: new Prisma.Decimal(0.12) }),
      );

      const result = await service.createCommissionRate(dto);
      expect(result.commissionRate).toBe('0.12');
      expect(commissionRateConfigsRepository.create).toHaveBeenCalledWith(0.12);
    });
  });
});
