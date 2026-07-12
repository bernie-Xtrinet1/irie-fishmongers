import { BadRequestException, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Prisma, SeafoodLot } from '@prisma/client';

import { RecallIssuedEvent } from '../../../common/events/recall-issued.event';
import { CreateRecallDto } from '../dto/create-recall.dto';
import { UpdateRecallStatusDto } from '../dto/update-recall-status.dto';
import { AffectedOrderItem, RecallsRepository, RecallWithLots } from '../repositories/recalls.repository';
import { SeafoodLotsRepository } from '../repositories/seafood-lots.repository';
import { ComplianceAuditLogService } from './compliance-audit-log.service';
import { RecallsService } from './recalls.service';

function buildLot(overrides: Partial<SeafoodLot> = {}): SeafoodLot {
  return {
    id: 'lot-1',
    lotNumber: 'LOT-2026-000001',
    publicTraceToken: 'trace-token-1',
    vendorId: 'vendor-1',
    catchItemId: null,
    species: 'Snapper',
    speciesId: null,
    storageType: 'FRESH',
    catchDate: new Date(),
    catchLocation: null,
    landingSite: null,
    weight: { toString: () => '20' } as unknown as SeafoodLot['weight'],
    weightUnit: 'POUNDS',
    freshnessGrade: null,
    qualityScore: null,
    foodSafetyStatus: 'SAFE',
    statusNotes: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function buildRecall(overrides: Partial<RecallWithLots> = {}): RecallWithLots {
  return {
    id: 'recall-1',
    severityClass: 'CLASS_II',
    status: 'DRAFT',
    reason: 'Elevated histamine levels detected in post-market sampling',
    rootCause: null,
    resolutionNotes: null,
    createdById: 'admin-1',
    createdAt: new Date(),
    updatedAt: new Date(),
    closedAt: null,
    lots: [{ id: 'recall-lot-1', recallId: 'recall-1', lotId: 'lot-1' }],
    ...overrides,
  };
}

function buildAffectedOrderItem(overrides: Partial<AffectedOrderItem> = {}): AffectedOrderItem {
  return {
    id: 'item-1',
    vendorOrderId: 'vo-1',
    productId: 'product-1',
    productName: 'Fresh Snapper',
    unitPrice: { toString: () => '500' } as Prisma.Decimal,
    unit: 'PER_POUND',
    quantity: 2,
    subtotal: { toString: () => '1000' } as unknown as Prisma.Decimal,
    createdAt: new Date(),
    product: {
      id: 'product-1',
      vendorId: 'vendor-1',
      categoryId: 'cat-1',
      lotId: 'lot-1',
      name: 'Fresh Snapper',
      description: 'Caught this morning',
      unit: 'PER_POUND',
      price: { toString: () => '500' } as unknown as Prisma.Decimal,
      currency: 'JMD',
      quantityAvailable: 10,
      imageUrl: 'https://cdn.example.com/snapper.jpg',
      weightLbs: null,
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    vendorOrder: {
      id: 'vo-1',
      orderId: 'order-1',
      vendorId: 'vendor-1',
      status: 'DELIVERED',
      subtotal: { toString: () => '1000' } as unknown as Prisma.Decimal,
      createdAt: new Date(),
      updatedAt: new Date(),
      order: {
        id: 'order-1',
        customerId: 'customer-1',
        deliveryAddressLine1: '1 Ocean View Road',
        deliveryAddressLine2: null,
        deliveryParish: 'KINGSTON',
        deliveryPhone: '+18765551234',
        deliveryZoneId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        customer: {
          id: 'customer-1',
          email: 'customer@example.com',
          passwordHash: 'hashed',
          firstName: 'Cara',
          lastName: 'Customer',
          phone: null,
          status: 'ACTIVE',
          emailVerifiedAt: new Date(),
          emailVerificationTokenHash: null,
          emailVerificationTokenExpiresAt: null,
          passwordResetTokenHash: null,
          passwordResetTokenExpiresAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      },
    },
    ...overrides,
  };
}

describe('RecallsService', () => {
  let recallsRepository: jest.Mocked<
    Pick<RecallsRepository, 'create' | 'updateStatus' | 'findMany' | 'findById' | 'findAffectedOrderItems'>
  >;
  let lotsRepository: jest.Mocked<Pick<SeafoodLotsRepository, 'findById' | 'updateStatus'>>;
  let auditLogService: jest.Mocked<Pick<ComplianceAuditLogService, 'record'>>;
  let eventEmitter: jest.Mocked<Pick<EventEmitter2, 'emitAsync'>>;
  let service: RecallsService;

  beforeEach(() => {
    recallsRepository = {
      create: jest.fn(),
      updateStatus: jest.fn(),
      findMany: jest.fn(),
      findById: jest.fn(),
      findAffectedOrderItems: jest.fn().mockResolvedValue([]),
    };
    lotsRepository = { findById: jest.fn(), updateStatus: jest.fn() };
    auditLogService = { record: jest.fn() };
    eventEmitter = { emitAsync: jest.fn() };

    service = new RecallsService(
      recallsRepository as unknown as RecallsRepository,
      lotsRepository as unknown as SeafoodLotsRepository,
      auditLogService as unknown as ComplianceAuditLogService,
      eventEmitter as unknown as EventEmitter2,
    );
  });

  describe('create', () => {
    const dto: CreateRecallDto = {
      severityClass: 'CLASS_II',
      reason: 'Elevated histamine levels detected in post-market sampling',
      lotIds: ['lot-1'],
    };

    it('creates a recall once every referenced lot exists', async () => {
      lotsRepository.findById.mockResolvedValue(buildLot());
      recallsRepository.create.mockResolvedValue(buildRecall());

      const result = await service.create('admin-1', dto);

      expect(result.id).toBe('recall-1');
      expect(result.lotIds).toEqual(['lot-1']);
    });

    it('throws NotFoundException when a referenced lot does not exist', async () => {
      lotsRepository.findById.mockResolvedValue(null);
      await expect(service.create('admin-1', dto)).rejects.toBeInstanceOf(NotFoundException);
      expect(recallsRepository.create).not.toHaveBeenCalled();
    });
  });

  describe('updateStatus', () => {
    it('throws NotFoundException when the recall does not exist', async () => {
      recallsRepository.findById.mockResolvedValue(null);
      const dto: UpdateRecallStatusDto = { status: 'ACTIVE' };
      await expect(service.updateStatus('admin-1', 'missing', dto)).rejects.toBeInstanceOf(NotFoundException);
    });

    it.each([
      ['DRAFT', 'ACTIVE'],
      ['ACTIVE', 'INVESTIGATING'],
      ['INVESTIGATING', 'RESOLVED'],
      ['RESOLVED', 'CLOSED'],
    ] as const)('allows the transition from %s to %s', async (from, to) => {
      recallsRepository.findById.mockResolvedValue(buildRecall({ status: from }));
      recallsRepository.updateStatus.mockResolvedValue(buildRecall({ status: to }));
      lotsRepository.updateStatus.mockResolvedValue(buildLot({ foodSafetyStatus: 'RECALLED' }));

      const result = await service.updateStatus('admin-1', 'recall-1', { status: to });
      expect(result.status).toBe(to);
    });

    it('cascades foodSafetyStatus = RECALLED onto every linked lot when transitioning to ACTIVE', async () => {
      recallsRepository.findById.mockResolvedValue(
        buildRecall({
          status: 'DRAFT',
          severityClass: 'CLASS_I',
          reason: 'Confirmed pathogenic contamination',
          lots: [
            { id: 'rl-1', recallId: 'recall-1', lotId: 'lot-1' },
            { id: 'rl-2', recallId: 'recall-1', lotId: 'lot-2' },
          ],
        }),
      );
      recallsRepository.updateStatus.mockResolvedValue(buildRecall({ status: 'ACTIVE' }));
      lotsRepository.updateStatus.mockResolvedValue(buildLot({ foodSafetyStatus: 'RECALLED' }));

      await service.updateStatus('admin-1', 'recall-1', { status: 'ACTIVE' });

      expect(lotsRepository.updateStatus).toHaveBeenCalledTimes(2);
      expect(lotsRepository.updateStatus).toHaveBeenCalledWith(
        'lot-1',
        'RECALLED',
        expect.stringContaining('Recalled (CLASS_I)'),
      );
      expect(lotsRepository.updateStatus).toHaveBeenCalledWith(
        'lot-2',
        'RECALLED',
        expect.stringContaining('Recalled (CLASS_I)'),
      );
    });

    it('does not cascade lot status when transitioning to a non-ACTIVE status', async () => {
      recallsRepository.findById.mockResolvedValue(buildRecall({ status: 'ACTIVE' }));
      recallsRepository.updateStatus.mockResolvedValue(buildRecall({ status: 'INVESTIGATING' }));

      await service.updateStatus('admin-1', 'recall-1', { status: 'INVESTIGATING' });

      expect(lotsRepository.updateStatus).not.toHaveBeenCalled();
      expect(eventEmitter.emitAsync).not.toHaveBeenCalled();
    });

    it('emits a RecallIssuedEvent per affected order when transitioning to ACTIVE', async () => {
      recallsRepository.findById.mockResolvedValue(
        buildRecall({ status: 'DRAFT', reason: 'Confirmed pathogenic contamination' }),
      );
      recallsRepository.updateStatus.mockResolvedValue(buildRecall({ status: 'ACTIVE' }));
      lotsRepository.updateStatus.mockResolvedValue(buildLot({ foodSafetyStatus: 'RECALLED' }));
      recallsRepository.findAffectedOrderItems.mockResolvedValue([buildAffectedOrderItem()]);
      lotsRepository.findById.mockResolvedValue(buildLot({ lotNumber: 'LOT-2026-000001' }));

      await service.updateStatus('admin-1', 'recall-1', { status: 'ACTIVE' });

      expect(eventEmitter.emitAsync).toHaveBeenCalledWith(
        RecallIssuedEvent.eventName,
        new RecallIssuedEvent('customer-1', 'order-1', 'LOT-2026-000001', 'Confirmed pathogenic contamination'),
      );
    });

    it('sets closedAt when transitioning to CLOSED', async () => {
      recallsRepository.findById.mockResolvedValue(buildRecall({ status: 'RESOLVED' }));
      recallsRepository.updateStatus.mockResolvedValue(buildRecall({ status: 'CLOSED', closedAt: new Date() }));

      await service.updateStatus('admin-1', 'recall-1', {
        status: 'CLOSED',
        resolutionNotes: 'All affected inventory destroyed and disposed',
      });

      expect(recallsRepository.updateStatus).toHaveBeenCalledWith('recall-1', 'CLOSED', {
        rootCause: undefined,
        resolutionNotes: 'All affected inventory destroyed and disposed',
        closedAt: expect.any(Date) as Date,
      });
    });

    it.each([
      ['DRAFT', 'INVESTIGATING'],
      ['DRAFT', 'RESOLVED'],
      ['DRAFT', 'CLOSED'],
      ['ACTIVE', 'RESOLVED'],
      ['ACTIVE', 'CLOSED'],
      ['INVESTIGATING', 'ACTIVE'],
      ['INVESTIGATING', 'CLOSED'],
      ['RESOLVED', 'ACTIVE'],
      ['RESOLVED', 'INVESTIGATING'],
      ['CLOSED', 'ACTIVE'],
    ] as const)('rejects the invalid transition from %s to %s', async (from, to) => {
      recallsRepository.findById.mockResolvedValue(buildRecall({ status: from }));

      await expect(service.updateStatus('admin-1', 'recall-1', { status: to })).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });
  });

  describe('list', () => {
    it('lists recalls with a status filter', async () => {
      recallsRepository.findMany.mockResolvedValue({ items: [buildRecall()], total: 1 });

      const result = await service.list({ page: 1, pageSize: 20, status: 'DRAFT' });

      expect(result.total).toBe(1);
      expect(recallsRepository.findMany).toHaveBeenCalledWith('DRAFT', { skip: 0, take: 20 });
    });
  });

  describe('getById', () => {
    it('returns a recall by id', async () => {
      recallsRepository.findById.mockResolvedValue(buildRecall());
      const result = await service.getById('recall-1');
      expect(result.id).toBe('recall-1');
    });

    it('computes retentionExpiresAt as createdAt + 7 years', async () => {
      recallsRepository.findById.mockResolvedValue(
        buildRecall({ createdAt: new Date('2026-01-15T00:00:00.000Z') }),
      );
      const result = await service.getById('recall-1');
      expect(result.retentionExpiresAt.toISOString()).toBe('2033-01-15T00:00:00.000Z');
    });

    it('throws when the recall does not exist', async () => {
      recallsRepository.findById.mockResolvedValue(null);
      await expect(service.getById('missing')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('getAffectedOrders', () => {
    it('returns affected orders for the lots linked to a recall', async () => {
      recallsRepository.findById.mockResolvedValue(buildRecall());
      recallsRepository.findAffectedOrderItems.mockResolvedValue([buildAffectedOrderItem()]);

      const result = await service.getAffectedOrders('recall-1');

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        orderId: 'order-1',
        vendorOrderId: 'vo-1',
        customerId: 'customer-1',
        customerEmail: 'customer@example.com',
        productId: 'product-1',
        productName: 'Fresh Snapper',
        quantity: 2,
        lotId: 'lot-1',
      });
      expect(recallsRepository.findAffectedOrderItems).toHaveBeenCalledWith(['lot-1']);
    });

    it('throws when the recall does not exist', async () => {
      recallsRepository.findById.mockResolvedValue(null);
      await expect(service.getAffectedOrders('missing')).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
