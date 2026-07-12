import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Prisma, SeafoodLot, Vendor } from '@prisma/client';

import { CartRepository, CartWithItems } from '../../cart/repositories/cart.repository';
import { InventoryEventsRepository } from '../../inventory/repositories/inventory-events.repository';
import { InventoryReservationsService } from '../../inventory/services/inventory-reservations.service';
import { PaymentsService } from '../../payments/services/payments.service';
import { ProductsRepository, ProductWithLot } from '../../products/repositories/products.repository';
import { VendorPermissionsService } from '../../vendor-tiers/services/vendor-permissions.service';
import { VendorsRepository } from '../../vendors/repositories/vendors.repository';
import { PrismaService } from '../../../database/prisma.service';
import { OrdersRepository, OrderWithDetails } from '../repositories/orders.repository';
import { VendorOrdersRepository } from '../repositories/vendor-orders.repository';
import { OrdersService } from './orders.service';

function buildProduct(overrides: Partial<ProductWithLot> = {}): ProductWithLot {
  return {
    id: 'product-1',
    vendorId: 'vendor-1',
    categoryId: 'cat-1',
    lotId: null,
    lot: null,
    name: 'Fresh Snapper',
    description: 'Caught this morning.',
    unit: 'PER_POUND',
    price: new Prisma.Decimal(500),
    currency: 'JMD',
    quantityAvailable: 20,
    imageUrl: 'https://cdn.example.com/snapper.jpg',
    weightLbs: null,
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

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
    weight: new Prisma.Decimal(20),
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
    tier: 'COMMUNITY_FISHER',
    complianceScore: null,
    termsAcceptedAt: new Date(),
    primaryZoneId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function buildCart(overrides: Partial<CartWithItems> = {}): CartWithItems {
  return {
    id: 'cart-1',
    customerId: 'user-1',
    createdAt: new Date(),
    updatedAt: new Date(),
    items: [],
    ...overrides,
  };
}

function buildOrder(overrides: Partial<OrderWithDetails> = {}): OrderWithDetails {
  return {
    id: 'order-1',
    customerId: 'user-1',
    deliveryAddressLine1: '1 Test Street',
    deliveryAddressLine2: null,
    deliveryParish: 'KINGSTON',
    deliveryPhone: '+18765551234',
    deliveryZoneId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    vendorOrders: [],
    ...overrides,
  };
}

const checkoutDto = {
  deliveryAddressLine1: '1 Test Street',
  deliveryParish: 'KINGSTON' as const,
  deliveryPhone: '+18765551234',
  paymentMethod: 'CASH_ON_DELIVERY' as const,
};

function buildPaymentResponse(): {
  id: string;
  orderId: string;
  provider: 'CASH_ON_DELIVERY';
  status: 'PENDING';
  amount: string;
  currency: string;
  paidAt: Date | null;
  createdAt: Date;
} {
  return {
    id: 'payment-1',
    orderId: 'order-1',
    provider: 'CASH_ON_DELIVERY',
    status: 'PENDING',
    amount: '1000',
    currency: 'JMD',
    paidAt: null,
    createdAt: new Date(),
  };
}

describe('OrdersService', () => {
  let prisma: { $transaction: jest.Mock; deliveryZoneParish: { findUnique: jest.Mock } };
  let ordersRepository: jest.Mocked<Pick<OrdersRepository, 'create' | 'findById' | 'findManyByCustomer'>>;
  let vendorOrdersRepository: jest.Mocked<Pick<VendorOrdersRepository, 'updateStatus'>>;
  let cartRepository: jest.Mocked<Pick<CartRepository, 'findOrCreateByCustomerId' | 'clear'>>;
  let productsRepository: jest.Mocked<Pick<ProductsRepository, 'adjustStock'>>;
  let vendorsRepository: jest.Mocked<Pick<VendorsRepository, 'findById'>>;
  let paymentsService: jest.Mocked<Pick<PaymentsService, 'initiatePayment' | 'getByOrderId'>>;
  let vendorPermissionsService: jest.Mocked<Pick<VendorPermissionsService, 'assertSalesLimitNotExceeded'>>;
  let inventoryEventsRepository: jest.Mocked<Pick<InventoryEventsRepository, 'create'>>;
  let inventoryReservations: jest.Mocked<Pick<InventoryReservationsService, 'release'>>;
  let eventEmitter: jest.Mocked<Pick<EventEmitter2, 'emitAsync'>>;
  let service: OrdersService;

  beforeEach(() => {
    prisma = {
      $transaction: jest.fn().mockImplementation((callback: (tx: unknown) => unknown) =>
        callback({}),
      ),
      deliveryZoneParish: { findUnique: jest.fn().mockResolvedValue(null) },
    };
    ordersRepository = { create: jest.fn(), findById: jest.fn(), findManyByCustomer: jest.fn() };
    vendorOrdersRepository = { updateStatus: jest.fn() };
    cartRepository = { findOrCreateByCustomerId: jest.fn(), clear: jest.fn() };
    productsRepository = { adjustStock: jest.fn() };
    vendorsRepository = { findById: jest.fn() };
    paymentsService = {
      initiatePayment: jest.fn().mockResolvedValue({ payment: buildPaymentResponse(), redirectUrl: undefined }),
      getByOrderId: jest.fn().mockResolvedValue(buildPaymentResponse()),
    };
    vendorPermissionsService = { assertSalesLimitNotExceeded: jest.fn().mockResolvedValue(undefined) };
    inventoryEventsRepository = { create: jest.fn().mockResolvedValue(undefined) };
    inventoryReservations = { release: jest.fn().mockResolvedValue(undefined) };
    eventEmitter = { emitAsync: jest.fn().mockResolvedValue([]) };

    service = new OrdersService(
      prisma as unknown as PrismaService,
      ordersRepository as unknown as OrdersRepository,
      vendorOrdersRepository as unknown as VendorOrdersRepository,
      cartRepository as unknown as CartRepository,
      productsRepository as unknown as ProductsRepository,
      vendorsRepository as unknown as VendorsRepository,
      paymentsService as unknown as PaymentsService,
      vendorPermissionsService as unknown as VendorPermissionsService,
      inventoryEventsRepository as unknown as InventoryEventsRepository,
      inventoryReservations as unknown as InventoryReservationsService,
      eventEmitter as unknown as EventEmitter2,
    );
  });

  describe('checkout', () => {
    it('rejects checkout with an empty cart', async () => {
      cartRepository.findOrCreateByCustomerId.mockResolvedValue(buildCart());
      await expect(service.checkout('user-1', checkoutDto)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('rejects checkout when a cart item is inactive', async () => {
      cartRepository.findOrCreateByCustomerId.mockResolvedValue(
        buildCart({
          items: [
            {
              id: 'item-1',
              cartId: 'cart-1',
              productId: 'product-1',
              quantity: 1,
              createdAt: new Date(),
              updatedAt: new Date(),
              product: buildProduct({ isActive: false }),
            },
          ],
        }),
      );
      await expect(service.checkout('user-1', checkoutDto)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('rejects checkout when a cart item is linked to a lot that is not SAFE', async () => {
      cartRepository.findOrCreateByCustomerId.mockResolvedValue(
        buildCart({
          items: [
            {
              id: 'item-1',
              cartId: 'cart-1',
              productId: 'product-1',
              quantity: 1,
              createdAt: new Date(),
              updatedAt: new Date(),
              product: buildProduct({
                lotId: 'lot-1',
                lot: buildLot({ foodSafetyStatus: 'RECALLED' }),
              }),
            },
          ],
        }),
      );
      await expect(service.checkout('user-1', checkoutDto)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('rejects checkout when the vendor is not approved', async () => {
      cartRepository.findOrCreateByCustomerId.mockResolvedValue(
        buildCart({
          items: [
            {
              id: 'item-1',
              cartId: 'cart-1',
              productId: 'product-1',
              quantity: 1,
              createdAt: new Date(),
              updatedAt: new Date(),
              product: buildProduct(),
            },
          ],
        }),
      );
      vendorsRepository.findById.mockResolvedValue(buildVendor({ status: 'SUSPENDED' }));

      await expect(service.checkout('user-1', checkoutDto)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('splits a multi-vendor cart into separate vendor orders and clears the cart', async () => {
      const cart = buildCart({
        items: [
          {
            id: 'item-1',
            cartId: 'cart-1',
            productId: 'product-1',
            quantity: 2,
            createdAt: new Date(),
            updatedAt: new Date(),
            product: buildProduct({ vendorId: 'vendor-1', price: new Prisma.Decimal(500) }),
          },
          {
            id: 'item-2',
            cartId: 'cart-1',
            productId: 'product-2',
            quantity: 1,
            createdAt: new Date(),
            updatedAt: new Date(),
            product: buildProduct({
              id: 'product-2',
              vendorId: 'vendor-2',
              price: new Prisma.Decimal(800),
            }),
          },
        ],
      });
      cartRepository.findOrCreateByCustomerId.mockResolvedValue(cart);
      vendorsRepository.findById.mockResolvedValue(buildVendor());
      productsRepository.adjustStock.mockResolvedValue(buildProduct());
      ordersRepository.create.mockResolvedValue(
        buildOrder({
          vendorOrders: [
            {
              id: 'vo-1',
              orderId: 'order-1',
              vendorId: 'vendor-1',
              status: 'PENDING',
              subtotal: new Prisma.Decimal(1000),
              createdAt: new Date(),
              updatedAt: new Date(),
              items: [
                {
                  id: 'oi-1',
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
            },
            {
              id: 'vo-2',
              orderId: 'order-1',
              vendorId: 'vendor-2',
              status: 'PENDING',
              subtotal: new Prisma.Decimal(800),
              createdAt: new Date(),
              updatedAt: new Date(),
              items: [
                {
                  id: 'oi-2',
                  vendorOrderId: 'vo-2',
                  productId: 'product-2',
                  productName: 'Fresh Snapper',
                  unitPrice: new Prisma.Decimal(800),
                  unit: 'PER_POUND',
                  quantity: 1,
                  subtotal: new Prisma.Decimal(800),
                  createdAt: new Date(),
                },
              ],
            },
          ],
        }),
      );

      const result = await service.checkout('user-1', checkoutDto);

      expect(result.vendorOrders).toHaveLength(2);
      expect(productsRepository.adjustStock).toHaveBeenCalledWith('product-1', -2, {});
      expect(productsRepository.adjustStock).toHaveBeenCalledWith('product-2', -1, {});
      expect(cartRepository.clear).toHaveBeenCalledWith('cart-1', {});
      const createArg = ordersRepository.create.mock.calls[0]?.[0];
      expect(createArg?.vendorOrders).toHaveLength(2);
      expect(eventEmitter.emitAsync).toHaveBeenCalledWith(
        'order.placed',
        expect.objectContaining({ customerId: 'user-1', orderId: 'order-1' }),
      );
    });

    it('writes a DECREMENTED inventory event per order item during checkout', async () => {
      const cart = buildCart({
        items: [
          {
            id: 'item-1',
            cartId: 'cart-1',
            productId: 'product-1',
            quantity: 2,
            createdAt: new Date(),
            updatedAt: new Date(),
            product: buildProduct(),
          },
        ],
      });
      cartRepository.findOrCreateByCustomerId.mockResolvedValue(cart);
      vendorsRepository.findById.mockResolvedValue(buildVendor());
      productsRepository.adjustStock.mockResolvedValue(buildProduct());
      ordersRepository.create.mockResolvedValue(
        buildOrder({
          vendorOrders: [
            {
              id: 'vo-1',
              orderId: 'order-1',
              vendorId: 'vendor-1',
              status: 'PENDING',
              subtotal: new Prisma.Decimal(1000),
              createdAt: new Date(),
              updatedAt: new Date(),
              items: [
                {
                  id: 'oi-1',
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
            },
          ],
        }),
      );

      await service.checkout('user-1', checkoutDto);

      expect(inventoryEventsRepository.create).toHaveBeenCalledWith(
        {
          productId: 'product-1',
          eventType: 'DECREMENTED',
          quantityDelta: -2,
          vendorOrderId: 'vo-1',
        },
        {},
      );
    });

    it('releases the reservation for each purchased product after a successful checkout', async () => {
      const cart = buildCart({
        items: [
          {
            id: 'item-1',
            cartId: 'cart-1',
            productId: 'product-1',
            quantity: 2,
            createdAt: new Date(),
            updatedAt: new Date(),
            product: buildProduct(),
          },
        ],
      });
      cartRepository.findOrCreateByCustomerId.mockResolvedValue(cart);
      vendorsRepository.findById.mockResolvedValue(buildVendor());
      productsRepository.adjustStock.mockResolvedValue(buildProduct());
      ordersRepository.create.mockResolvedValue(
        buildOrder({
          vendorOrders: [
            {
              id: 'vo-1',
              orderId: 'order-1',
              vendorId: 'vendor-1',
              status: 'PENDING',
              subtotal: new Prisma.Decimal(1000),
              createdAt: new Date(),
              updatedAt: new Date(),
              items: [],
            },
          ],
        }),
      );

      await service.checkout('user-1', checkoutDto);

      expect(inventoryReservations.release).toHaveBeenCalledWith('product-1', 'cart-1');
    });

    it('resolves deliveryZoneId from the parish->zone mapping and stores it on the order', async () => {
      const cart = buildCart({
        items: [
          {
            id: 'item-1',
            cartId: 'cart-1',
            productId: 'product-1',
            quantity: 1,
            createdAt: new Date(),
            updatedAt: new Date(),
            product: buildProduct(),
          },
        ],
      });
      cartRepository.findOrCreateByCustomerId.mockResolvedValue(cart);
      vendorsRepository.findById.mockResolvedValue(buildVendor());
      productsRepository.adjustStock.mockResolvedValue(buildProduct());
      prisma.deliveryZoneParish.findUnique.mockResolvedValue({ zoneId: 'zone-1' });
      ordersRepository.create.mockResolvedValue(buildOrder({ deliveryZoneId: 'zone-1' }));

      await service.checkout('user-1', checkoutDto);

      expect(prisma.deliveryZoneParish.findUnique).toHaveBeenCalledWith({
        where: { parish: 'KINGSTON' },
        select: { zoneId: true },
      });
      const createArg = ordersRepository.create.mock.calls[0]?.[0];
      expect(createArg?.deliveryZoneId).toBe('zone-1');
    });

    it('stores a null deliveryZoneId when the parish has no zone mapping', async () => {
      const cart = buildCart({
        items: [
          {
            id: 'item-1',
            cartId: 'cart-1',
            productId: 'product-1',
            quantity: 1,
            createdAt: new Date(),
            updatedAt: new Date(),
            product: buildProduct(),
          },
        ],
      });
      cartRepository.findOrCreateByCustomerId.mockResolvedValue(cart);
      vendorsRepository.findById.mockResolvedValue(buildVendor());
      productsRepository.adjustStock.mockResolvedValue(buildProduct());
      prisma.deliveryZoneParish.findUnique.mockResolvedValue(null);
      ordersRepository.create.mockResolvedValue(buildOrder());

      await service.checkout('user-1', checkoutDto);

      const createArg = ordersRepository.create.mock.calls[0]?.[0];
      expect(createArg?.deliveryZoneId).toBeNull();
    });
  });

  describe('getCustomerOrders', () => {
    it('paginates the customer order list', async () => {
      ordersRepository.findManyByCustomer.mockResolvedValue({ items: [buildOrder()], total: 1 });
      const result = await service.getCustomerOrders('user-1', { page: 1, pageSize: 20 });
      expect(result.total).toBe(1);
    });
  });

  describe('getCustomerOrderById', () => {
    it('returns an order owned by the customer', async () => {
      ordersRepository.findById.mockResolvedValue(buildOrder());
      const result = await service.getCustomerOrderById('user-1', 'order-1');
      expect(result.id).toBe('order-1');
    });

    it('throws when the order belongs to a different customer', async () => {
      ordersRepository.findById.mockResolvedValue(buildOrder({ customerId: 'someone-else' }));
      await expect(service.getCustomerOrderById('user-1', 'order-1')).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('throws when the order does not exist', async () => {
      ordersRepository.findById.mockResolvedValue(null);
      await expect(service.getCustomerOrderById('user-1', 'missing')).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });
  });

  describe('cancelOrder', () => {
    it('cancels every pending vendor order and restores stock', async () => {
      const pendingVendorOrder = {
        id: 'vo-1',
        orderId: 'order-1',
        vendorId: 'vendor-1',
        status: 'PENDING' as const,
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
            unit: 'PER_POUND' as const,
            quantity: 2,
            subtotal: new Prisma.Decimal(1000),
            createdAt: new Date(),
          },
        ],
      };
      const acceptedVendorOrder = {
        ...pendingVendorOrder,
        id: 'vo-2',
        status: 'ACCEPTED' as const,
      };

      ordersRepository.findById.mockResolvedValue(
        buildOrder({ vendorOrders: [pendingVendorOrder, acceptedVendorOrder] }),
      );

      await service.cancelOrder('user-1', 'order-1');

      expect(productsRepository.adjustStock).toHaveBeenCalledWith('product-1', 2, {});
      expect(vendorOrdersRepository.updateStatus).toHaveBeenCalledWith('vo-1', 'CANCELLED');
      expect(vendorOrdersRepository.updateStatus).not.toHaveBeenCalledWith('vo-2', 'CANCELLED');
      expect(inventoryEventsRepository.create).toHaveBeenCalledWith(
        {
          productId: 'product-1',
          eventType: 'RESTOCKED',
          quantityDelta: 2,
          vendorOrderId: 'vo-1',
        },
        {},
      );
    });

    it('throws when nothing in the order is still pending', async () => {
      ordersRepository.findById.mockResolvedValue(
        buildOrder({
          vendorOrders: [
            {
              id: 'vo-1',
              orderId: 'order-1',
              vendorId: 'vendor-1',
              status: 'ACCEPTED',
              subtotal: new Prisma.Decimal(500),
              createdAt: new Date(),
              updatedAt: new Date(),
              items: [],
            },
          ],
        }),
      );

      await expect(service.cancelOrder('user-1', 'order-1')).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });
  });

  describe('cancelVendorOrder', () => {
    it('cancels a single pending vendor order and writes a RESTOCKED inventory event', async () => {
      const vendorOrder = {
        id: 'vo-1',
        orderId: 'order-1',
        vendorId: 'vendor-1',
        status: 'PENDING' as const,
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
            unit: 'PER_POUND' as const,
            quantity: 1,
            subtotal: new Prisma.Decimal(500),
            createdAt: new Date(),
          },
        ],
      };
      ordersRepository.findById.mockResolvedValue(buildOrder({ vendorOrders: [vendorOrder] }));

      await service.cancelVendorOrder('user-1', 'order-1', 'vo-1');

      expect(vendorOrdersRepository.updateStatus).toHaveBeenCalledWith('vo-1', 'CANCELLED');
      expect(inventoryEventsRepository.create).toHaveBeenCalledWith(
        {
          productId: 'product-1',
          eventType: 'RESTOCKED',
          quantityDelta: 1,
          vendorOrderId: 'vo-1',
        },
        {},
      );
    });

    it('throws when the vendor order is not found within the order', async () => {
      ordersRepository.findById.mockResolvedValue(buildOrder({ vendorOrders: [] }));
      await expect(
        service.cancelVendorOrder('user-1', 'order-1', 'missing'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('throws when the vendor order is no longer pending', async () => {
      ordersRepository.findById.mockResolvedValue(
        buildOrder({
          vendorOrders: [
            {
              id: 'vo-1',
              orderId: 'order-1',
              vendorId: 'vendor-1',
              status: 'ACCEPTED',
              subtotal: new Prisma.Decimal(500),
              createdAt: new Date(),
              updatedAt: new Date(),
              items: [],
            },
          ],
        }),
      );

      await expect(
        service.cancelVendorOrder('user-1', 'order-1', 'vo-1'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });
});
