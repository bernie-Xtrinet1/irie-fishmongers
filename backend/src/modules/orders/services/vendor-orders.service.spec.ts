import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Prisma } from '@prisma/client';

import { InventoryEventsRepository } from '../../inventory/repositories/inventory-events.repository';
import { PaymentsService } from '../../payments/services/payments.service';
import { ProductsRepository } from '../../products/repositories/products.repository';
import { VendorsRepository } from '../../vendors/repositories/vendors.repository';
import { PrismaService } from '../../../database/prisma.service';
import {
  VendorOrderWithItems,
  VendorOrdersRepository,
} from '../repositories/vendor-orders.repository';
import { VendorOrdersService } from './vendor-orders.service';

function buildVendorOrder(overrides: Partial<VendorOrderWithItems> = {}): VendorOrderWithItems {
  return {
    id: 'vo-1',
    orderId: 'order-1',
    vendorId: 'vendor-1',
    status: 'PENDING',
    subtotal: new Prisma.Decimal(500),
    createdAt: new Date(),
    updatedAt: new Date(),
    items: [
      {
        id: 'item-1',
        vendorOrderId: 'vo-1',
        productId: 'product-1',
        productName: 'Fresh Snapper',
        unitPrice: new Prisma.Decimal(500),
        unit: 'PER_POUND',
        quantity: 2,
        subtotal: new Prisma.Decimal(1000),
        createdAt: new Date(),
      },
    ],
    order: {
      id: 'order-1',
      customerId: 'user-1',
      deliveryAddressLine1: '1 Test Street',
      deliveryAddressLine2: null,
      deliveryParish: 'KINGSTON',
      deliveryPhone: '+18765551234',
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    ...overrides,
  };
}

describe('VendorOrdersService', () => {
  let prisma: { $transaction: jest.Mock };
  let vendorOrdersRepository: jest.Mocked<
    Pick<VendorOrdersRepository, 'findById' | 'updateStatus' | 'findManyByVendor'>
  >;
  let vendorsRepository: jest.Mocked<Pick<VendorsRepository, 'findByUserId' | 'findById'>>;
  let productsRepository: jest.Mocked<Pick<ProductsRepository, 'adjustStock'>>;
  let paymentsService: jest.Mocked<
    Pick<PaymentsService, 'assertReadyForFulfillment' | 'refundForOrder'>
  >;
  let inventoryEventsRepository: jest.Mocked<Pick<InventoryEventsRepository, 'create'>>;
  let eventEmitter: jest.Mocked<Pick<EventEmitter2, 'emitAsync'>>;
  let service: VendorOrdersService;

  beforeEach(() => {
    prisma = {
      $transaction: jest.fn().mockImplementation((callback: (tx: unknown) => unknown) =>
        callback({}),
      ),
    };
    vendorOrdersRepository = {
      findById: jest.fn(),
      updateStatus: jest.fn(),
      findManyByVendor: jest.fn(),
    };
    vendorsRepository = { findByUserId: jest.fn(), findById: jest.fn() };
    productsRepository = { adjustStock: jest.fn() };
    paymentsService = {
      assertReadyForFulfillment: jest.fn().mockResolvedValue(undefined),
      refundForOrder: jest.fn().mockResolvedValue(null),
    };
    inventoryEventsRepository = { create: jest.fn().mockResolvedValue(undefined) };
    eventEmitter = { emitAsync: jest.fn().mockResolvedValue([]) };

    service = new VendorOrdersService(
      prisma as unknown as PrismaService,
      vendorOrdersRepository as unknown as VendorOrdersRepository,
      vendorsRepository as unknown as VendorsRepository,
      productsRepository as unknown as ProductsRepository,
      paymentsService as unknown as PaymentsService,
      inventoryEventsRepository as unknown as InventoryEventsRepository,
      eventEmitter as unknown as EventEmitter2,
    );
  });

  function mockOwnedVendorOrder(vendorOrder = buildVendorOrder()): void {
    vendorsRepository.findByUserId.mockResolvedValue({
      id: vendorOrder.vendorId,
      userId: 'user-1',
      businessName: 'Test Vendor',
      description: null,
      phone: null,
      parish: 'KINGSTON',
      logoUrl: null,
      status: 'APPROVED',
      tier: 'COMMUNITY_FISHER',
      complianceScore: null,
      termsAcceptedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    vendorOrdersRepository.findById.mockResolvedValue(vendorOrder);
  }

  describe('accept', () => {
    it('accepts a pending vendor order', async () => {
      mockOwnedVendorOrder();
      vendorOrdersRepository.updateStatus.mockResolvedValue(
        buildVendorOrder({ status: 'ACCEPTED' }),
      );
      vendorsRepository.findById.mockResolvedValue({
        id: 'vendor-1',
        userId: 'vendor-user-1',
        businessName: 'Test Vendor',
        description: null,
        phone: null,
        parish: 'KINGSTON',
        logoUrl: null,
        status: 'APPROVED',
        tier: 'COMMUNITY_FISHER',
        complianceScore: null,
        termsAcceptedAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const result = await service.accept('user-1', 'vo-1');
      expect(result.status).toBe('ACCEPTED');
      expect(vendorOrdersRepository.updateStatus).toHaveBeenCalledWith('vo-1', 'ACCEPTED');
      expect(paymentsService.assertReadyForFulfillment).toHaveBeenCalledWith('order-1');
      expect(eventEmitter.emitAsync).toHaveBeenCalledWith(
        'order.accepted',
        expect.objectContaining({
          customerId: 'user-1',
          orderId: 'order-1',
          vendorBusinessName: 'Test Vendor',
        }),
      );
    });

    it('blocks acceptance when payment is not yet completed', async () => {
      mockOwnedVendorOrder();
      paymentsService.assertReadyForFulfillment.mockRejectedValue(
        new ForbiddenException('Payment must be completed before the vendor can accept this order'),
      );

      await expect(service.accept('user-1', 'vo-1')).rejects.toBeInstanceOf(ForbiddenException);
      expect(vendorOrdersRepository.updateStatus).not.toHaveBeenCalled();
    });

    it('throws when the vendor does not own the order', async () => {
      vendorsRepository.findByUserId.mockResolvedValue({
        id: 'someone-elses-vendor',
        userId: 'user-1',
        businessName: 'Test Vendor',
        description: null,
        phone: null,
        parish: 'KINGSTON',
        logoUrl: null,
        status: 'APPROVED',
        tier: 'COMMUNITY_FISHER',
        complianceScore: null,
        termsAcceptedAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      vendorOrdersRepository.findById.mockResolvedValue(buildVendorOrder());

      await expect(service.accept('user-1', 'vo-1')).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('throws when the vendor order does not exist', async () => {
      vendorsRepository.findByUserId.mockResolvedValue({
        id: 'vendor-1',
        userId: 'user-1',
        businessName: 'Test Vendor',
        description: null,
        phone: null,
        parish: 'KINGSTON',
        logoUrl: null,
        status: 'APPROVED',
        tier: 'COMMUNITY_FISHER',
        complianceScore: null,
        termsAcceptedAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      vendorOrdersRepository.findById.mockResolvedValue(null);

      await expect(service.accept('user-1', 'missing')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('throws when the user has no vendor profile', async () => {
      vendorsRepository.findByUserId.mockResolvedValue(null);
      await expect(service.accept('user-1', 'vo-1')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('rejects an illegal transition', async () => {
      mockOwnedVendorOrder(buildVendorOrder({ status: 'DELIVERED' }));
      await expect(service.accept('user-1', 'vo-1')).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('reject', () => {
    it('rejects a pending vendor order and restores stock atomically with a RESTOCKED event', async () => {
      mockOwnedVendorOrder();
      vendorOrdersRepository.updateStatus.mockResolvedValue(
        buildVendorOrder({ status: 'REJECTED' }),
      );

      const result = await service.reject('user-1', 'vo-1');

      expect(result.status).toBe('REJECTED');
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(productsRepository.adjustStock).toHaveBeenCalledWith('product-1', 2, {});
      expect(inventoryEventsRepository.create).toHaveBeenCalledWith(
        {
          productId: 'product-1',
          eventType: 'RESTOCKED',
          quantityDelta: 2,
          vendorOrderId: 'vo-1',
        },
        {},
      );
      expect(vendorOrdersRepository.updateStatus).toHaveBeenCalledWith('vo-1', 'REJECTED', {});
      expect(paymentsService.refundForOrder).toHaveBeenCalledWith(
        'order-1',
        500,
        'Vendor rejected order',
      );
    });

    it('rejects rejecting an already-accepted order', async () => {
      mockOwnedVendorOrder(buildVendorOrder({ status: 'ACCEPTED' }));
      await expect(service.reject('user-1', 'vo-1')).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('markPreparing / markReadyForPickup', () => {
    it('moves an accepted order to preparing', async () => {
      mockOwnedVendorOrder(buildVendorOrder({ status: 'ACCEPTED' }));
      vendorOrdersRepository.updateStatus.mockResolvedValue(
        buildVendorOrder({ status: 'PREPARING' }),
      );

      const result = await service.markPreparing('user-1', 'vo-1');
      expect(result.status).toBe('PREPARING');
    });

    it('rejects moving a pending order straight to preparing', async () => {
      mockOwnedVendorOrder(buildVendorOrder({ status: 'PENDING' }));
      await expect(service.markPreparing('user-1', 'vo-1')).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('moves a preparing order to ready for pickup', async () => {
      mockOwnedVendorOrder(buildVendorOrder({ status: 'PREPARING' }));
      vendorOrdersRepository.updateStatus.mockResolvedValue(
        buildVendorOrder({ status: 'READY_FOR_PICKUP' }),
      );

      const result = await service.markReadyForPickup('user-1', 'vo-1');
      expect(result.status).toBe('READY_FOR_PICKUP');
    });
  });

  describe('getIncomingOrders', () => {
    it('paginates a vendor incoming orders', async () => {
      vendorsRepository.findByUserId.mockResolvedValue({
        id: 'vendor-1',
        userId: 'user-1',
        businessName: 'Test Vendor',
        description: null,
        phone: null,
        parish: 'KINGSTON',
        logoUrl: null,
        status: 'APPROVED',
        tier: 'COMMUNITY_FISHER',
        complianceScore: null,
        termsAcceptedAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      vendorOrdersRepository.findManyByVendor.mockResolvedValue({
        items: [buildVendorOrder()],
        total: 1,
      });

      const result = await service.getIncomingOrders('user-1', undefined, {
        page: 1,
        pageSize: 20,
      });

      expect(result.total).toBe(1);
      expect(vendorOrdersRepository.findManyByVendor).toHaveBeenCalledWith('vendor-1', undefined, {
        skip: 0,
        take: 20,
      });
    });
  });
});
