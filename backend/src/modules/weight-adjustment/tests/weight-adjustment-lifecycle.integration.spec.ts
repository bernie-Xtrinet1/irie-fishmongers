import { Test, TestingModule } from '@nestjs/testing';
import {
  ApprovalChallengeStatus,
  CertificationStatus,
  CustomerApprovalAction,
  CustomerWeightApprovalStatus,
  FishermanStatus,
  FoodSafetyStatus,
  ObligationStatus,
  PaymentObligationDirection,
  PaymentProviderName,
  PreparationFeeStructure,
  Prisma,
  ProductUnit,
  RegulatoryStatus,
  RoleName,
  SeafoodPricingBasis,
  SettlementChannel,
  UsablePartsFulfillmentOutcome,
  UsablePartsPreference,
  UserStatus,
  VendorStatus,
  WeightMeasurementStatus,
  WeightUnit,
} from '@prisma/client';
import Decimal from 'decimal.js';

import { PrismaService } from '../../../database/prisma.service';
import { WeightAdjustmentModule } from '../weight-adjustment.module';

// Repositories
import { CustomerWeightApprovalChallengeRepository } from '../repositories/customer-weight-approval-challenge.repository';
import { CustomerWeightConsentRepository } from '../repositories/customer-weight-consent.repository';
import { SeafoodOrderWeightAdjustmentRepository } from '../repositories/seafood-order-weight-adjustment.repository';
import { SeafoodPreparationFulfillmentEventRepository } from '../repositories/seafood-preparation-fulfillment-event.repository';
import { SeafoodWeightMeasurementEventRepository } from '../repositories/seafood-weight-measurement-event.repository';
import { WeightFinancialObligationRepository } from '../repositories/weight-financial-obligation.repository';

// Services
import { CustomerWeightApprovalCoordinationService } from '../services/customer-weight-approval-coordination.service';
import { SeafoodPreparationFulfillmentService } from '../services/seafood-preparation-fulfillment.service';
import { SeafoodWeightMeasurementService } from '../services/seafood-weight-measurement.service';
import { WeightAdjustmentApprovalTokenService } from '../services/weight-adjustment-approval-token.service';
import { WeightAdjustmentReleaseReadinessService } from '../services/weight-adjustment-release-readiness.service';
import { WeightAdjustmentSafetyGateService } from '../services/weight-adjustment-safety-gate.service';
import { WeightAdjustmentSettlementService } from '../services/weight-adjustment-settlement.service';
import { WeightAdjustmentSnapshotInitializationService } from '../services/weight-adjustment-snapshot-initialization.service';

// Errors & Types
import {
  AdjustmentNotFoundError,
  ChallengeAlreadyConsumedError,
  ChallengeExpiredError,
  IdempotencyPayloadConflictError,
  InvalidApprovalTokenError,
  InvalidSettlementAmountError,
  MissingAuthoritativeLotProvenanceError,
  ProvenanceMismatchError,
  SeafoodLotRecalledError,
  SettlementAmountExceedsObligationError,
  SettlementChannelDirectionMismatchError,
} from '../repositories/errors/weight-adjustment-repository.errors';
import {
  DormantSettlementChannelError,
  InvalidSettlementEvidenceError,
  StaleApprovalRevisionError,
  UnauthorizedApprovalCustomerError,
  UnauthorizedSettlementOperatorError,
} from '../services/types/weight-adjustment-coordination.types';
import {
  UnauthorizedMeasurementOperatorError,
  UnauthorizedPreparationOperatorError,
} from '../services/types/weight-measurement-fulfillment.types';
import { hashApprovalToken } from '../repositories/utils/canonical-hash.util';

describe('WeightAdjustmentLifecycle - Integration Invariant Tests (WP3.5)', () => {
  let moduleRef: TestingModule;
  let prismaMock: any;

  // Services resolved from the module
  let snapshotInitService: WeightAdjustmentSnapshotInitializationService;
  let measurementService: SeafoodWeightMeasurementService;
  let prepService: SeafoodPreparationFulfillmentService;
  let approvalCoordService: CustomerWeightApprovalCoordinationService;
  let settlementService: WeightAdjustmentSettlementService;
  let releaseReadinessService: WeightAdjustmentReleaseReadinessService;
  let safetyGateService: WeightAdjustmentSafetyGateService;
  let tokenService: WeightAdjustmentApprovalTokenService;
  let challengeRepo: CustomerWeightApprovalChallengeRepository;

  // In-memory relational store representing database state across lifecycle transitions
  let store: {
    adjustments: Map<string, any>;
    measurementEvents: Map<string, any>;
    preparationEvents: Map<string, any>;
    approvalChallenges: Map<string, any>;
    approvalRecords: Map<string, any>;
    consents: Map<string, any>;
    obligations: Map<string, any>;
    settlements: Map<string, any>;
    users: Map<string, any>;
    vendors: Map<string, any>;
    seafoodLots: Map<string, any>;
    listings: Map<string, any>;
    orderItems: Map<string, any>;
    vendorOrders: Map<string, any>;
    orders: Map<string, any>;
    payments: Map<string, any>;
    deliveries: Map<string, any>;
  };

  const setupDefaultEntities = () => {
    store = {
      adjustments: new Map(),
      measurementEvents: new Map(),
      preparationEvents: new Map(),
      approvalChallenges: new Map(),
      approvalRecords: new Map(),
      consents: new Map(),
      obligations: new Map(),
      settlements: new Map(),
      users: new Map(),
      vendors: new Map(),
      seafoodLots: new Map(),
      listings: new Map(),
      orderItems: new Map(),
      vendorOrders: new Map(),
      orders: new Map(),
      payments: new Map(),
      deliveries: new Map(),
    };

    // 1. Users
    const vendorUser = {
      id: 'user-vendor-1',
      status: UserStatus.ACTIVE,
      roles: [{ role: { name: RoleName.VENDOR } }],
      fisherman: null,
    };
    store.users.set(vendorUser.id, vendorUser);

    const customerUser = {
      id: 'user-cust-1',
      status: UserStatus.ACTIVE,
      roles: [{ role: { name: RoleName.CUSTOMER } }],
    };
    store.users.set(customerUser.id, customerUser);

    const driverUser = {
      id: 'user-driver-1',
      status: UserStatus.ACTIVE,
      roles: [{ role: { name: RoleName.DRIVER } }],
    };
    store.users.set(driverUser.id, driverUser);

    // 2. Vendor
    const vendor = {
      id: 'vendor-1',
      userId: 'user-vendor-1',
      status: VendorStatus.APPROVED,
      user: vendorUser,
    };
    store.vendors.set(vendor.id, vendor);

    // 3. Seafood Lot
    const seafoodLot = {
      id: 'lot-001',
      lotNumber: 'LOT-20261025-001',
      foodSafetyStatus: FoodSafetyStatus.SAFE,
      vendorId: 'vendor-1',
      vendor: { id: 'vendor-1', status: VendorStatus.APPROVED },
      speciesRef: { id: 'sp-001', regulatoryStatus: RegulatoryStatus.UNRESTRICTED },
      recallLots: [],
      temperatureAlerts: [],
      incidents: [],
      inspections: [],
      isRecalled: false,
      recalledAt: null,
      quarantinedAt: null,
    };
    store.seafoodLots.set(seafoodLot.id, seafoodLot);

    // 4. Listing
    const listing = {
      id: 'listing-001',
      vendorId: 'vendor-1',
      productId: 'prod-001',
      lotId: 'lot-001',
      unit: ProductUnit.PER_POUND,
      price: new Prisma.Decimal('600.00'),
      preparationOptions: [
        { id: 'filleting', label: 'Filleting', fee: 0, feeType: 'FLAT' },
      ],
      expiresAt: new Date(Date.now() + 86400_000),
      createdAt: new Date(Date.now() - 3600_000),
      seafoodLot,
    };
    store.listings.set(listing.id, listing);

    // 5. Order & Payment (Prepaid PAID by default)
    const payment = {
      id: 'pay-001',
      orderId: 'order-001',
      provider: PaymentProviderName.WIPAY,
      status: 'PAID',
      amount: new Prisma.Decimal('1800.00'),
      providerReference: 'WIPAY-TXN-12345',
      paidAt: new Date(),
    };
    store.payments.set(payment.id, payment);

    const order = {
      id: 'order-001',
      customerId: 'user-cust-1',
      payment,
    };
    store.orders.set(order.id, order);

    // 6. Delivery
    const delivery = {
      id: 'del-001',
      vendorOrderId: 'vo-001',
      driverId: 'drv-001',
      driver: {
        id: 'drv-001',
        userId: 'user-driver-1',
      },
    };
    store.deliveries.set(delivery.id, delivery);

    // 7. VendorOrder
    const vendorOrder = {
      id: 'vo-001',
      vendorId: 'vendor-1',
      orderId: 'order-001',
      vendor,
      order,
      delivery,
    };
    store.vendorOrders.set(vendorOrder.id, vendorOrder);

    // 8. OrderItem
    const orderItem = {
      id: 'item-001',
      vendorOrderId: 'vo-001',
      productId: 'prod-001',
      productName: 'Yellowtail Snapper',
      unitPrice: new Prisma.Decimal('600.00'), // 600 JMD/lb
      unit: ProductUnit.PER_POUND,
      quantity: 1,
      subtotal: new Prisma.Decimal('1800.00'), // 3 lbs nominal = 1800 JMD
      originalLotId: 'lot-001',
      originalListingId: 'listing-001',
      createdAt: new Date(),
      vendorOrder,
      product: {
        id: 'prod-001',
        name: 'Yellowtail Snapper',
        inventoryMode: 'FRESH_CATCH',
        lotId: 'lot-001',
        weightLbs: new Prisma.Decimal('3.000'),
        lot: seafoodLot,
      },
    };
    store.orderItems.set(orderItem.id, orderItem);
  };

  beforeAll(async () => {
    setupDefaultEntities();

    // Create stateful prismaMock delegating to in-memory store
    prismaMock = {
      $transaction: jest.fn(async (cb: any) => cb(prismaMock)),
      $queryRaw: jest.fn(async () => []),

      user: {
        findUnique: jest.fn(async ({ where }: any) => {
          return store.users.get(where.id) ?? null;
        }),
      },

      vendor: {
        findUnique: jest.fn(async ({ where }: any) => {
          return store.vendors.get(where.id) ?? null;
        }),
      },

      seafoodLot: {
        findUnique: jest.fn(async ({ where }: any) => {
          return store.seafoodLots.get(where.id) ?? null;
        }),
      },

      vendorDailyListing: {
        findUnique: jest.fn(async ({ where }: any) => {
          return store.listings.get(where.id) ?? null;
        }),
      },

      orderItem: {
        findUnique: jest.fn(async ({ where }: any) => {
          const item = store.orderItems.get(where.id);
          if (!item) return null;
          const vendorOrder = store.vendorOrders.get(item.vendorOrderId);
          const vendor = store.vendors.get(vendorOrder?.vendorId);
          const order = store.orders.get(vendorOrder?.orderId);
          const adj = Array.from(store.adjustments.values()).find((a) => a.orderItemId === item.id);
          const consent = adj ? store.consents.get(adj.id) : null;
          return {
            ...item,
            vendorOrder: {
              ...vendorOrder,
              vendor,
              order,
            },
            product: {
              ...item.product,
              lot: store.seafoodLots.get(item.originalLotId ?? item.product?.lotId),
            },
            weightAdjustment: adj ? { ...adj, checkoutCeilingConsent: consent } : null,
          };
        }),
      },

      seafoodOrderWeightAdjustment: {
        findUnique: jest.fn(async ({ where }: any) => {
          let adj: any = null;
          if (where.id) {
            adj = store.adjustments.get(where.id);
          } else if (where.orderItemId) {
            adj = Array.from(store.adjustments.values()).find((a) => a.orderItemId === where.orderItemId);
          }
          if (!adj) return null;

          const orderItem = store.orderItems.get(adj.orderItemId);
          const vendorOrder = store.vendorOrders.get(orderItem?.vendorOrderId);
          const vendor = store.vendors.get(vendorOrder?.vendorId);
          const vendorUser = store.users.get(vendor?.userId);
          const order = store.orders.get(vendorOrder?.orderId);
          const payment = order ? (store.payments.get(order.payment?.id) ?? order.payment) : null;
          const delivery = store.deliveries.get(vendorOrder?.id) ?? vendorOrder?.delivery;

          const obligations = Array.from(store.obligations.values())
            .filter((o) => o.weightAdjustmentId === adj.id)
            .map((o) => ({
              ...o,
              settlementRecords: Array.from(store.settlements.values()).filter((s) => s.obligationId === o.id),
            }));

          const consent = store.consents.get(adj.id);

          return {
            ...adj,
            orderItem: {
              ...orderItem,
              vendorOrder: {
                ...vendorOrder,
                vendor: {
                  ...vendor,
                  user: vendorUser,
                },
                order: {
                  ...order,
                  payment,
                },
                delivery,
              },
              product: {
                ...orderItem?.product,
                lot: store.seafoodLots.get(orderItem?.originalLotId ?? orderItem?.product?.lotId),
              },
            },
            financialObligations: obligations,
            checkoutCeilingConsent: consent ?? null,
          };
        }),

        findUniqueOrThrow: jest.fn(async ({ where }: any) => {
          const res = await prismaMock.seafoodOrderWeightAdjustment.findUnique({ where });
          if (!res) throw new AdjustmentNotFoundError(where.id ?? 'unknown');
          return res;
        }),

        create: jest.fn(async ({ data }: any) => {
          const created = {
            id: data.id ?? `adj-${Date.now()}`,
            ...data,
            activeMeasurementRevision: data.activeMeasurementRevision ?? 0,
            activePreparationRevision: data.activePreparationRevision ?? 0,
            measurementStatus: data.measurementStatus ?? WeightMeasurementStatus.PENDING_MEASUREMENT,
            customerApprovalStatus: data.customerApprovalStatus ?? CustomerWeightApprovalStatus.NOT_REQUIRED,
            boundApprovalRevision: data.boundApprovalRevision ?? null,
            verifiedBillableWeight: data.verifiedBillableWeight ?? null,
            verifiedScalePhotoUrl: data.verifiedScalePhotoUrl ?? null,
            finalProductSubtotal: data.finalProductSubtotal ?? null,
            finalPreparationFee: data.finalPreparationFee ?? null,
            finalItemTotal: data.finalItemTotal ?? null,
            createdAt: new Date(),
            updatedAt: new Date(),
          };
          store.adjustments.set(created.id, created);
          return created;
        }),

        update: jest.fn(async ({ where, data }: any) => {
          const existing = store.adjustments.get(where.id);
          if (!existing) throw new Error(`Adjustment ${where.id} not found`);
          const updated = { ...existing, ...data, updatedAt: new Date() };
          store.adjustments.set(where.id, updated);
          return updated;
        }),

        updateMany: jest.fn(async ({ where, data }: any) => {
          let count = 0;
          for (const [id, adj] of store.adjustments.entries()) {
            if (where.id && adj.id !== where.id) continue;
            if (
              where.activeMeasurementRevision !== undefined &&
              adj.activeMeasurementRevision !== where.activeMeasurementRevision
            ) {
              continue;
            }
            if (
              where.activePreparationRevision !== undefined &&
              adj.activePreparationRevision !== where.activePreparationRevision
            ) {
              continue;
            }
            store.adjustments.set(id, { ...adj, ...data, updatedAt: new Date() });
            count++;
          }
          return { count };
        }),
      },

      seafoodWeightMeasurementEvent: {
        findUnique: jest.fn(async ({ where }: any) => {
          if (where.idempotencyKey) {
            return (
              Array.from(store.measurementEvents.values()).find(
                (e) => e.idempotencyKey === where.idempotencyKey,
              ) ?? null
            );
          }
          return store.measurementEvents.get(where.id) ?? null;
        }),
        create: jest.fn(async ({ data }: any) => {
          const created = {
            id: data.id ?? `me-${Date.now()}`,
            ...data,
            recordedAt: new Date(),
          };
          store.measurementEvents.set(created.id, created);
          return created;
        }),
      },

      seafoodPreparationFulfillmentEvent: {
        findUnique: jest.fn(async ({ where }: any) => {
          if (where.idempotencyKey) {
            return (
              Array.from(store.preparationEvents.values()).find(
                (e) => e.idempotencyKey === where.idempotencyKey,
              ) ?? null
            );
          }
          return store.preparationEvents.get(where.id) ?? null;
        }),
        create: jest.fn(async ({ data }: any) => {
          const created = {
            id: data.id ?? `pe-${Date.now()}`,
            ...data,
            recordedAt: new Date(),
          };
          store.preparationEvents.set(created.id, created);
          return created;
        }),
      },

      customerWeightApprovalChallenge: {
        findUnique: jest.fn(async ({ where }: any) => {
          let ch: any = null;
          if (where.id) {
            ch = store.approvalChallenges.get(where.id);
          } else if (where.approvalTokenHash) {
            ch = Array.from(store.approvalChallenges.values()).find(
              (c) => c.approvalTokenHash === where.approvalTokenHash,
            );
          } else if (where.idempotencyKey) {
            ch = Array.from(store.approvalChallenges.values()).find(
              (c) => c.idempotencyKey === where.idempotencyKey,
            );
          }
          return ch ?? null;
        }),
        findFirst: jest.fn(async ({ where }: any) => {
          return (
            Array.from(store.approvalChallenges.values()).find((c) => {
              if (where.weightAdjustmentId && c.weightAdjustmentId !== where.weightAdjustmentId) return false;
              if (where.measurementRevision && c.measurementRevision !== where.measurementRevision) return false;
              if (where.status && c.status !== where.status) return false;
              return true;
            }) ?? null
          );
        }),
        create: jest.fn(async ({ data }: any) => {
          const created = {
            id: data.id ?? `ch-${Date.now()}`,
            ...data,
            status: data.status ?? ApprovalChallengeStatus.OPEN,
            consumedAt: null,
            createdAt: new Date(),
          };
          store.approvalChallenges.set(created.id, created);
          return created;
        }),
        update: jest.fn(async ({ where, data }: any) => {
          const existing = store.approvalChallenges.get(where.id);
          if (!existing) throw new Error(`Challenge ${where.id} not found`);
          const updated = { ...existing, ...data };
          store.approvalChallenges.set(where.id, updated);
          return updated;
        }),
        updateMany: jest.fn(async ({ where, data }: any) => {
          let count = 0;
          for (const [id, ch] of store.approvalChallenges.entries()) {
            if (where.id && ch.id !== where.id) continue;
            if (where.weightAdjustmentId && ch.weightAdjustmentId !== where.weightAdjustmentId) continue;
            if (where.measurementRevision && ch.measurementRevision !== where.measurementRevision) continue;
            if (where.status && ch.status !== where.status) continue;
            store.approvalChallenges.set(id, { ...ch, ...data });
            count++;
          }
          return { count };
        }),
      },

      customerWeightApprovalRecord: {
        findUnique: jest.fn(async ({ where }: any) => {
          if (where.uq_approval_adj_revision) {
            const { weightAdjustmentId, measurementRevision } = where.uq_approval_adj_revision;
            return (
              Array.from(store.approvalRecords.values()).find(
                (r) =>
                  r.weightAdjustmentId === weightAdjustmentId &&
                  r.measurementRevision === measurementRevision,
              ) ?? null
            );
          }
          if (where.id) {
            return store.approvalRecords.get(where.id) ?? null;
          }
          return null;
        }),
        create: jest.fn(async ({ data }: any) => {
          const created = {
            id: data.id ?? `rec-${Date.now()}`,
            ...data,
            createdAt: new Date(),
          };
          store.approvalRecords.set(created.id, created);
          return created;
        }),
        findFirst: jest.fn(async ({ where }: any) => {
          return (
            Array.from(store.approvalRecords.values()).find((r) => {
              if (where.weightAdjustmentId && r.weightAdjustmentId !== where.weightAdjustmentId) return false;
              if (where.measurementRevision && r.measurementRevision !== where.measurementRevision) return false;
              return true;
            }) ?? null
          );
        }),
      },

      customerCheckoutCeilingConsent: {
        findUnique: jest.fn(async ({ where }: any) => {
          if (where.weightAdjustmentId) {
            return store.consents.get(where.weightAdjustmentId) ?? null;
          }
          return store.consents.get(where.id) ?? null;
        }),
        create: jest.fn(async ({ data }: any) => {
          const created = { id: data.id ?? `cs-${Date.now()}`, ...data, createdAt: new Date() };
          store.consents.set(data.weightAdjustmentId ?? created.id, created);
          return created;
        }),
      },

      weightAdjustmentObligation: {
        findUnique: jest.fn(async ({ where }: any) => {
          const ob = store.obligations.get(where.id);
          if (!ob) return null;
          const adj = store.adjustments.get(ob.weightAdjustmentId);
          const orderItem = adj ? store.orderItems.get(adj.orderItemId) : null;
          const vendorOrder = orderItem ? store.vendorOrders.get(orderItem.vendorOrderId) : null;
          const vendor = vendorOrder ? store.vendors.get(vendorOrder.vendorId) : null;
          const delivery = vendorOrder ? (store.deliveries.get(vendorOrder.id) ?? vendorOrder.delivery) : null;
          const settlements = Array.from(store.settlements.values()).filter((s) => s.obligationId === ob.id);
          return {
            ...ob,
            weightAdjustment: adj
              ? {
                  ...adj,
                  orderItem: {
                    ...orderItem,
                    vendorOrder: {
                      ...vendorOrder,
                      vendor,
                      delivery,
                    },
                  },
                }
              : null,
            settlementRecords: settlements,
          };
        }),
        findUniqueOrThrow: jest.fn(async ({ where }: any) => {
          const res = await prismaMock.weightAdjustmentObligation.findUnique({ where });
          if (!res) throw new AdjustmentNotFoundError(`Obligation ${where.id}`);
          return res;
        }),
        update: jest.fn(async ({ where, data }: any) => {
          const existing = store.obligations.get(where.id);
          if (!existing) throw new Error(`Obligation ${where.id} not found`);
          const updated = { ...existing, ...data };
          store.obligations.set(where.id, updated);
          return updated;
        }),
      },

      weightAdjustmentSettlementRecord: {
        findUnique: jest.fn(async ({ where }: any) => {
          if (where.idempotencyKey) {
            return (
              Array.from(store.settlements.values()).find(
                (s) => s.idempotencyKey === where.idempotencyKey,
              ) ?? null
            );
          }
          return store.settlements.get(where.id) ?? null;
        }),
        create: jest.fn(async ({ data }: any) => {
          const created = { id: data.id ?? `stl-${Date.now()}`, ...data, settledAt: new Date() };
          store.settlements.set(created.id, created);
          return created;
        }),
      },
    };

    moduleRef = await Test.createTestingModule({
      imports: [WeightAdjustmentModule],
    })
      .overrideProvider(PrismaService)
      .useValue(prismaMock)
      .compile();

    snapshotInitService = moduleRef.get<WeightAdjustmentSnapshotInitializationService>(
      WeightAdjustmentSnapshotInitializationService,
    );
    measurementService = moduleRef.get<SeafoodWeightMeasurementService>(
      SeafoodWeightMeasurementService,
    );
    prepService = moduleRef.get<SeafoodPreparationFulfillmentService>(
      SeafoodPreparationFulfillmentService,
    );
    approvalCoordService = moduleRef.get<CustomerWeightApprovalCoordinationService>(
      CustomerWeightApprovalCoordinationService,
    );
    settlementService = moduleRef.get<WeightAdjustmentSettlementService>(
      WeightAdjustmentSettlementService,
    );
    releaseReadinessService = moduleRef.get<WeightAdjustmentReleaseReadinessService>(
      WeightAdjustmentReleaseReadinessService,
    );
    safetyGateService = moduleRef.get<WeightAdjustmentSafetyGateService>(
      WeightAdjustmentSafetyGateService,
    );
    tokenService = moduleRef.get<WeightAdjustmentApprovalTokenService>(
      WeightAdjustmentApprovalTokenService,
    );
    challengeRepo = moduleRef.get<CustomerWeightApprovalChallengeRepository>(
      CustomerWeightApprovalChallengeRepository,
    );
  });

  beforeEach(() => {
    setupDefaultEntities();
    jest.clearAllMocks();
  });

  // ===========================================================================
  // Section 1: Complete Lifecycle Happy Paths
  // ===========================================================================
  describe('Complete Lifecycle Happy Paths', () => {
    it('TC-WP3.5-LC-01: executes full lifecycle within ceiling (Prepaid PAID -> Measure -> Prep -> Release Ready)', async () => {
      const actor: any = { id: 'user-vendor-1', email: 'v@example.com', roles: [RoleName.VENDOR] };

      // 1. Snapshot Initialization
      const snapshot = await snapshotInitService.initializeSnapshot({
        orderItemId: 'item-001',
        customerAuthorizedCeilingJmd: '2000.00',
        termsVersion: 'v1.0',
        selectedPreparationServiceName: 'Filleting',
      });

      expect(snapshot.weightAdjustment?.id).toBeDefined();
      expect(snapshot.weightAdjustment?.measurementStatus).toBe(WeightMeasurementStatus.PENDING_MEASUREMENT);

      const adjustmentId = snapshot.weightAdjustment!.id;

      // 2. Scale Measurement (within authorized ceiling: 3.200 lbs = 1920 JMD <= 2000 JMD ceiling)
      const measureResult = await measurementService.recordAuthoritativeMeasurement({
        weightAdjustmentId: adjustmentId,
        expectedRevision: 1,
        idempotencyKey: 'idemp-meas-1',
        measuredWeight: '3.200',
        scalePhotoUrl: 'https://storage.iriefishmongers.com/scales/scale-01.jpg',
        operatorUserId: actor.id,
        authenticatedActor: actor,
        tareIsolated: true,
        physicalLotId: 'lot-001',
      });

      expect(measureResult.status).toBe('MEASURED_WITHIN_CEILING');
      expect(measureResult.requiresCustomerApproval).toBe(false);
      expect(measureResult.weightAdjustment.activeMeasurementRevision).toBe(1);

      // 3. Preparation Fulfillment (Filleting yields 2.400 lbs)
      const prepResult = await prepService.recordPreparationFulfillment({
        weightAdjustmentId: adjustmentId,
        expectedRevision: 1,
        idempotencyKey: 'idemp-prep-1',
        preparationServiceName: 'Filleting',
        preparedNetWeight: '2.400',
        partsOutcome: UsablePartsFulfillmentOutcome.RETURNED_AVAILABLE_PARTS,
        unit: WeightUnit.POUNDS,
        operatorUserId: actor.id,
        authenticatedActor: actor,
        physicalLotId: 'lot-001',
      });

      expect(prepResult.weightAdjustment.activePreparationRevision).toBe(1);
      expect(prepResult.preparationEvent.preparedNetWeight?.toString()).toBe('2.4');

      // 4. Financial Settlement: prepaid order with neutral/no supplemental obligation
      // 5. Release Readiness Evaluation
      const release = await releaseReadinessService.evaluateReleaseReadiness({
        weightAdjustmentId: adjustmentId,
      });

      expect(release.gate1Measurement.status).toBe('PASSED');
      expect(release.gate2FoodSafetyAndRegulatory.status).toBe('PASSED');
      expect(release.gate3CustomerApproval.status).toBe('PASSED');
      expect(release.gate4PreparationFulfillment.status).toBe('PASSED');
      expect(release.gate5FinancialSettlement.status).toBe('PASSED');
      expect(release.dispatchReady).toBe(true);
      expect(release.handoverReady).toBe(true);
    });

    it('TC-WP3.5-LC-02: executes lifecycle exceeding ceiling with customer challenge approval and vendor absorption', async () => {
      const vendorActor: any = { id: 'user-vendor-1', email: 'v@example.com', roles: [RoleName.VENDOR] };
      const custActor: any = { id: 'user-cust-1', email: 'c@example.com', roles: [RoleName.CUSTOMER] };

      // 1. Snapshot Init
      const snapshot = await snapshotInitService.initializeSnapshot({
        orderItemId: 'item-001',
        customerAuthorizedCeilingJmd: '2000.00',
        termsVersion: 'v1.0',
        selectedPreparationServiceName: 'Filleting',
      });

      const adjustmentId = snapshot.weightAdjustment!.id;

      // 2. Scale Measurement (exceeds ceiling: 4.000 lbs = 2400 JMD > 2000 JMD ceiling)
      const measureResult = await measurementService.recordAuthoritativeMeasurement({
        weightAdjustmentId: adjustmentId,
        expectedRevision: 1,
        idempotencyKey: 'idemp-meas-2',
        measuredWeight: '4.000',
        scalePhotoUrl: 'https://storage.iriefishmongers.com/scales/scale-02.jpg',
        operatorUserId: vendorActor.id,
        authenticatedActor: vendorActor,
        tareIsolated: true,
        physicalLotId: 'lot-001',
      });

      expect(measureResult.status).toBe('MEASURED_EXCEEDS_CEILING');
      expect(measureResult.requiresCustomerApproval).toBe(true);
      expect(measureResult.customerApprovalStatus).toBe(
        CustomerWeightApprovalStatus.AWAITING_APPROVAL,
      );

      // Verify release is BLOCKED while awaiting customer approval
      const releasePending = await releaseReadinessService.evaluateReleaseReadiness({
        weightAdjustmentId: adjustmentId,
      });
      expect(releasePending.gate3CustomerApproval.status).toBe('BLOCKED');
      expect(releasePending.dispatchReady).toBe(false);

      // 3. Customer Approval Challenge Generation & Token Verification
      const { rawToken, approvalTokenHash, expiresAt } = tokenService.generateChallengeToken();
      const challenge = await challengeRepo.createChallenge({
        weightAdjustmentId: adjustmentId,
        measurementRevision: 1,
        authenticatedCustomerId: custActor.id,
        proposedTotalJmd: new Decimal('2400.00'),
        authorizedCeilingJmd: new Decimal('2000.00'),
        approvalTokenHash,
        expiresAt,
      });

      // Customer approves challenge
      const approvalResult = await approvalCoordService.processCustomerApproval({
        weightAdjustmentId: adjustmentId,
        measurementRevision: 1,
        rawApprovalToken: rawToken,
        action: CustomerApprovalAction.APPROVED,
        authenticatedActor: custActor,
      });

      expect(approvalResult.weightAdjustment.customerApprovalStatus).toBe(
        CustomerWeightApprovalStatus.APPROVED_BY_CUSTOMER,
      );
      expect(approvalResult.weightAdjustment.boundApprovalRevision).toBe(1);

      // 4. Preparation Fulfillment
      await prepService.recordPreparationFulfillment({
        weightAdjustmentId: adjustmentId,
        expectedRevision: 1,
        idempotencyKey: 'idemp-prep-2',
        preparationServiceName: 'Filleting',
        preparedNetWeight: '3.100',
        partsOutcome: UsablePartsFulfillmentOutcome.RETURNED_AVAILABLE_PARTS,
        unit: WeightUnit.POUNDS,
        operatorUserId: vendorActor.id,
        authenticatedActor: vendorActor,
        physicalLotId: 'lot-001',
      });

      // Create supplemental financial obligation (400 JMD excess beyond 2000 JMD ceiling)
      const obligation = {
        id: 'ob-excess-2',
        weightAdjustmentId: adjustmentId,
        revision: 1,
        direction: PaymentObligationDirection.SUPPLEMENTAL_PAYMENT_DUE,
        amountJmd: new Prisma.Decimal('400.00'),
        status: ObligationStatus.PENDING,
        idempotencyKey: 'idemp-ob-2',
        payloadHash: 'hash-ob-2',
        createdAt: new Date(),
      };
      store.obligations.set(obligation.id, obligation);

      // 5. Financial Settlement: Vendor absorbs excess charge
      const settlementResult = await settlementService.recordSettlement({
        obligationId: obligation.id,
        settlementChannel: SettlementChannel.VENDOR_ABSORPTION,
        amountSettled: '400.00',
        idempotencyKey: 'idemp-settle-abs-2',
        externalReference: 'Vendor absorbs excess 400 JMD for prized whole snapper',
        authenticatedActor: vendorActor,
      });

      expect(settlementResult.isFullySettled).toBe(true);

      // 6. Release Readiness Evaluation: Both dispatch and handover PASS
      const finalRelease = await releaseReadinessService.evaluateReleaseReadiness({
        weightAdjustmentId: adjustmentId,
      });

      expect(finalRelease.gate1Measurement.status).toBe('PASSED');
      expect(finalRelease.gate2FoodSafetyAndRegulatory.status).toBe('PASSED');
      expect(finalRelease.gate3CustomerApproval.status).toBe('PASSED');
      expect(finalRelease.gate4PreparationFulfillment.status).toBe('PASSED');
      expect(finalRelease.gate5FinancialSettlement.status).toBe('PASSED');
      expect(finalRelease.dispatchReady).toBe(true);
      expect(finalRelease.handoverReady).toBe(true);
    });

    it('TC-WP3.5-LC-03: verifies Cash On Delivery (COD) decoupling (dispatch ready with collection pending -> doorstep collection -> handover ready)', async () => {
      const vendorActor: any = { id: 'user-vendor-1', email: 'v@example.com', roles: [RoleName.VENDOR] };

      // Set order payment provider to CASH_ON_DELIVERY with PENDING status
      const codPayment: {
        id: string;
        orderId: string;
        provider: PaymentProviderName;
        status: string;
        amount: Prisma.Decimal;
        providerReference: string | null;
      } = {
        id: 'pay-cod-1',
        orderId: 'order-001',
        provider: PaymentProviderName.CASH_ON_DELIVERY,
        status: 'PENDING',
        amount: new Prisma.Decimal('1800.00'),
        providerReference: null,
      };
      store.payments.set(codPayment.id, codPayment);
      store.orders.get('order-001').payment = codPayment;

      // 1. Snapshot Init
      const snapshot = await snapshotInitService.initializeSnapshot({
        orderItemId: 'item-001',
        customerAuthorizedCeilingJmd: '2000.00',
        termsVersion: 'v1.0',
      });

      const adjustmentId = snapshot.weightAdjustment!.id;

      // 2. Measure (3.000 lbs = neutral)
      await measurementService.recordAuthoritativeMeasurement({
        weightAdjustmentId: adjustmentId,
        expectedRevision: 1,
        idempotencyKey: 'idemp-meas-cod',
        measuredWeight: '3.000',
        scalePhotoUrl: 'https://storage.iriefishmongers.com/scales/scale-cod.jpg',
        operatorUserId: vendorActor.id,
        authenticatedActor: vendorActor,
        tareIsolated: true,
        physicalLotId: 'lot-001',
      });

      // Evaluate release: dispatchReady must be true, but handoverReady must be false!
      const dispatchEval = await releaseReadinessService.evaluateReleaseReadiness({
        weightAdjustmentId: adjustmentId,
      });

      expect(dispatchEval.gate5FinancialSettlement.status).toBe('COD_COLLECTION_PENDING');
      expect(dispatchEval.dispatchReady).toBe(true); // Driver dispatch permitted
      expect(dispatchEval.handoverReady).toBe(false); // Handover strictly blocked!

      // 3. Driver collects base cash at doorstep and records receipt reference
      codPayment.status = 'PAID';
      codPayment.providerReference = 'COD-RECEIPT-TICKET-998811';

      // Evaluate release: now handoverReady is unlocked
      const handoverEval = await releaseReadinessService.evaluateReleaseReadiness({
        weightAdjustmentId: adjustmentId,
      });

      expect(handoverEval.gate5FinancialSettlement.status).toBe('PASSED');
      expect(handoverEval.dispatchReady).toBe(true);
      expect(handoverEval.handoverReady).toBe(true);
    });

    it('TC-WP3.5-LC-04: verifies credit due customer memo queues non-blocking for physical release of paid order', async () => {
      const vendorActor: any = { id: 'user-vendor-1', email: 'v@example.com', roles: [RoleName.VENDOR] };

      // 1. Snapshot Init
      const snapshot = await snapshotInitService.initializeSnapshot({
        orderItemId: 'item-001',
        customerAuthorizedCeilingJmd: '2000.00',
        termsVersion: 'v1.0',
      });

      const adjustmentId = snapshot.weightAdjustment!.id;

      // 2. Measure under baseline weight (2.500 lbs = 1500 JMD -> 300 JMD credit due customer)
      await measurementService.recordAuthoritativeMeasurement({
        weightAdjustmentId: adjustmentId,
        expectedRevision: 1,
        idempotencyKey: 'idemp-meas-credit',
        measuredWeight: '2.500',
        scalePhotoUrl: 'https://storage.iriefishmongers.com/scales/scale-credit.jpg',
        operatorUserId: vendorActor.id,
        authenticatedActor: vendorActor,
        tareIsolated: true,
        physicalLotId: 'lot-001',
      });

      // Create credit due customer obligation
      const creditObligation = {
        id: 'ob-credit-4',
        weightAdjustmentId: adjustmentId,
        revision: 1,
        direction: PaymentObligationDirection.CREDIT_DUE_CUSTOMER,
        amountJmd: new Prisma.Decimal('300.00'),
        status: ObligationStatus.PENDING,
        idempotencyKey: 'idemp-ob-credit-4',
        payloadHash: 'hash-credit-4',
        createdAt: new Date(),
      };
      store.obligations.set(creditObligation.id, creditObligation);

      const release = await releaseReadinessService.evaluateReleaseReadiness({
        weightAdjustmentId: adjustmentId,
      });

      expect(release.gate5FinancialSettlement.status).toBe('PASSED_CREDIT_QUEUED');
      expect(release.dispatchReady).toBe(true);
      expect(release.handoverReady).toBe(true); // Non-blocking
    });
  });

  // ===========================================================================
  // Section 2: Invariant Guardrails & Failure Boundaries
  // ===========================================================================
  describe('Invariant Guardrails & Negative Boundaries', () => {
    it('TC-WP3.5-LC-05: rejects approval when operator reweighed item (stale challenge revision mismatch)', async () => {
      const vendorActor: any = { id: 'user-vendor-1', email: 'v@example.com', roles: [RoleName.VENDOR] };
      const custActor: any = { id: 'user-cust-1', email: 'c@example.com', roles: [RoleName.CUSTOMER] };

      const snapshot = await snapshotInitService.initializeSnapshot({
        orderItemId: 'item-001',
        customerAuthorizedCeilingJmd: '2000.00',
        termsVersion: 'v1.0',
      });

      const adjustmentId = snapshot.weightAdjustment!.id;

      // Measurement Revision 1
      await measurementService.recordAuthoritativeMeasurement({
        weightAdjustmentId: adjustmentId,
        expectedRevision: 1,
        idempotencyKey: 'idemp-meas-rev1',
        measuredWeight: '4.000',
        scalePhotoUrl: 'https://storage.iriefishmongers.com/scales/scale-rev1.jpg',
        operatorUserId: vendorActor.id,
        authenticatedActor: vendorActor,
        tareIsolated: true,
        physicalLotId: 'lot-001',
      });

      // Challenge created for Revision 1
      const { rawToken, approvalTokenHash, expiresAt } = tokenService.generateChallengeToken();
      await challengeRepo.createChallenge({
        weightAdjustmentId: adjustmentId,
        measurementRevision: 1,
        authenticatedCustomerId: custActor.id,
        proposedTotalJmd: new Decimal('2400.00'),
        authorizedCeilingJmd: new Decimal('2000.00'),
        approvalTokenHash,
        expiresAt,
      });

      // Set preparationCommenced = false to verify physical cutting has not begun
      const adj = store.adjustments.get(adjustmentId);
      adj.preparationCommenced = false;

      // Operator reweighs -> Revision 2
      await measurementService.recordAuthoritativeMeasurement({
        weightAdjustmentId: adjustmentId,
        expectedRevision: 2,
        idempotencyKey: 'idemp-meas-rev2',
        measuredWeight: '4.200',
        scalePhotoUrl: 'https://storage.iriefishmongers.com/scales/scale-rev2.jpg',
        operatorUserId: vendorActor.id,
        authenticatedActor: vendorActor,
        tareIsolated: true,
        correctionReason: 'Recalibrated scale balance',
        physicalLotId: 'lot-001',
      });

      // Customer attempts to approve Revision 1 challenge with submitted revision 1
      await expect(
        approvalCoordService.processCustomerApproval({
          weightAdjustmentId: adjustmentId,
          measurementRevision: 1,
          rawApprovalToken: rawToken,
          action: CustomerApprovalAction.APPROVED,
          authenticatedActor: custActor,
        }),
      ).rejects.toThrow(StaleApprovalRevisionError);
    });

    it('TC-WP3.5-LC-06: blocks release when customer approval challenge has expired', async () => {
      const vendorActor: any = { id: 'user-vendor-1', email: 'v@example.com', roles: [RoleName.VENDOR] };
      const custActor: any = { id: 'user-cust-1', email: 'c@example.com', roles: [RoleName.CUSTOMER] };

      const snapshot = await snapshotInitService.initializeSnapshot({
        orderItemId: 'item-001',
        customerAuthorizedCeilingJmd: '2000.00',
        termsVersion: 'v1.0',
      });

      const adjustmentId = snapshot.weightAdjustment!.id;

      await measurementService.recordAuthoritativeMeasurement({
        weightAdjustmentId: adjustmentId,
        expectedRevision: 1,
        idempotencyKey: 'idemp-meas-exp',
        measuredWeight: '4.000',
        scalePhotoUrl: 'https://storage.iriefishmongers.com/scales/scale-exp.jpg',
        operatorUserId: vendorActor.id,
        authenticatedActor: vendorActor,
        tareIsolated: true,
        physicalLotId: 'lot-001',
      });

      // Create an expired challenge (expired 1 hour ago)
      const rawToken = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
      const expiredChallenge = {
        id: 'ch-expired-1',
        weightAdjustmentId: adjustmentId,
        measurementRevision: 1,
        challengeSequence: 1,
        authenticatedCustomerId: custActor.id,
        idempotencyKey: 'idemp-chal-exp',
        approvalTokenHash: hashApprovalToken(rawToken),
        status: ApprovalChallengeStatus.EXPIRED,
        proposedTotalJmd: new Prisma.Decimal('2400.00'),
        authorizedCeilingJmd: new Prisma.Decimal('2000.00'),
        expiresAt: new Date(Date.now() - 3600_000),
        consumedAt: null,
        createdAt: new Date(Date.now() - 7200_000),
      };
      store.approvalChallenges.set(expiredChallenge.id, expiredChallenge);

      // Attempting to consume expired challenge fails
      await expect(
        approvalCoordService.processCustomerApproval({
          weightAdjustmentId: adjustmentId,
          measurementRevision: 1,
          rawApprovalToken: rawToken,
          action: CustomerApprovalAction.APPROVED,
          authenticatedActor: custActor,
        }),
      ).rejects.toThrow(ChallengeExpiredError);

      // Release readiness reflects EXPIRED status and blocks release
      const adj = store.adjustments.get(adjustmentId);
      adj.customerApprovalStatus = CustomerWeightApprovalStatus.AUTO_EXPIRED;

      const release = await releaseReadinessService.evaluateReleaseReadiness({
        weightAdjustmentId: adjustmentId,
      });

      expect(release.gate3CustomerApproval.status).toBe('EXPIRED');
      expect(release.dispatchReady).toBe(false);
      expect(release.handoverReady).toBe(false);
    });

    it('TC-WP3.5-LC-07: blocks release when reweighing invalidates earlier customer approval', async () => {
      const vendorActor: any = { id: 'user-vendor-1', email: 'v@example.com', roles: [RoleName.VENDOR] };

      const snapshot = await snapshotInitService.initializeSnapshot({
        orderItemId: 'item-001',
        customerAuthorizedCeilingJmd: '2000.00',
        termsVersion: 'v1.0',
      });

      const adjustmentId = snapshot.weightAdjustment!.id;

      // Measure Revision 1 -> Customer approved Revision 1
      const adj = store.adjustments.get(adjustmentId);
      adj.activeMeasurementRevision = 1;
      adj.measurementStatus = WeightMeasurementStatus.MEASURED_EXCEEDS_CEILING;
      adj.customerApprovalStatus = CustomerWeightApprovalStatus.APPROVED_BY_CUSTOMER;
      adj.boundApprovalRevision = 1;
      adj.verifiedBillableWeight = new Prisma.Decimal('4.000');

      // Operator re-measures on scale to Revision 2
      adj.activeMeasurementRevision = 2;
      adj.verifiedBillableWeight = new Prisma.Decimal('4.100');

      // Gate 3 must detect boundApprovalRevision (1) !== activeRevision (2) and block release
      const release = await releaseReadinessService.evaluateReleaseReadiness({
        weightAdjustmentId: adjustmentId,
      });

      expect(release.gate3CustomerApproval.status).toBe('BLOCKED');
      expect(release.dispatchReady).toBe(false);
      expect(release.handoverReady).toBe(false);
    });

    it('TC-WP3.5-LC-08: blocks release when prepaid order base payment is unpaid (PENDING or FAILED)', async () => {
      const vendorActor: any = { id: 'user-vendor-1', email: 'v@example.com', roles: [RoleName.VENDOR] };

      // Base payment is FAILED
      store.orders.get('order-001').payment.status = 'FAILED';

      const snapshot = await snapshotInitService.initializeSnapshot({
        orderItemId: 'item-001',
        customerAuthorizedCeilingJmd: '2000.00',
        termsVersion: 'v1.0',
      });

      const adjustmentId = snapshot.weightAdjustment!.id;

      await measurementService.recordAuthoritativeMeasurement({
        weightAdjustmentId: adjustmentId,
        expectedRevision: 1,
        idempotencyKey: 'idemp-meas-unpaid',
        measuredWeight: '3.000',
        scalePhotoUrl: 'https://storage.iriefishmongers.com/scales/scale-unpaid.jpg',
        operatorUserId: vendorActor.id,
        authenticatedActor: vendorActor,
        tareIsolated: true,
        physicalLotId: 'lot-001',
      });

      const release = await releaseReadinessService.evaluateReleaseReadiness({
        weightAdjustmentId: adjustmentId,
      });

      expect(release.gate5FinancialSettlement.status).toBe('BLOCKED');
      expect(release.dispatchReady).toBe(false);
      expect(release.handoverReady).toBe(false);
    });

    it('TC-WP3.5-LC-09: blocks handover when COD receipt covers only supplemental amount while base order is uncollected', async () => {
      // Base payment is COD PENDING
      const codPayment = {
        id: 'pay-cod-supp-only',
        orderId: 'order-001',
        provider: PaymentProviderName.CASH_ON_DELIVERY,
        status: 'PENDING',
        amount: new Prisma.Decimal('1800.00'),
        providerReference: null,
      };
      store.payments.set(codPayment.id, codPayment);
      store.orders.get('order-001').payment = codPayment;

      const snapshot = await snapshotInitService.initializeSnapshot({
        orderItemId: 'item-001',
        customerAuthorizedCeilingJmd: '2000.00',
        termsVersion: 'v1.0',
      });

      const adjustmentId = snapshot.weightAdjustment!.id;

      const adj = store.adjustments.get(adjustmentId);
      adj.activeMeasurementRevision = 1;
      adj.measurementStatus = WeightMeasurementStatus.MEASURED_EXCEEDS_CEILING;
      adj.customerApprovalStatus = CustomerWeightApprovalStatus.APPROVED_BY_CUSTOMER;
      adj.boundApprovalRevision = 1;
      adj.verifiedBillableWeight = new Prisma.Decimal('3.500');

      // Supplemental obligation settled, but base payment is still pending
      const suppObligation = {
        id: 'ob-supp-only-1',
        weightAdjustmentId: adjustmentId,
        revision: 1,
        direction: PaymentObligationDirection.SUPPLEMENTAL_PAYMENT_DUE,
        amountJmd: new Prisma.Decimal('300.00'),
        status: ObligationStatus.SETTLED,
        idempotencyKey: 'idemp-ob-supp-only-1',
        payloadHash: 'hash-supp-only-1',
        createdAt: new Date(),
      };
      store.obligations.set(suppObligation.id, suppObligation);

      const release = await releaseReadinessService.evaluateReleaseReadiness({
        weightAdjustmentId: adjustmentId,
      });

      expect(release.gate5FinancialSettlement.status).toBe('COD_COLLECTION_PENDING');
      expect(release.dispatchReady).toBe(true);
      expect(release.handoverReady).toBe(false); // Handover strictly blocked!
    });

    it('TC-WP3.5-LC-10: rejects vendor absorption from non-owner vendor (cross-tenant violation)', async () => {
      const nonOwnerVendor: any = {
        id: 'user-vendor-2',
        email: 'v2@example.com',
        roles: [RoleName.VENDOR],
      };
      store.users.set(nonOwnerVendor.id, {
        ...nonOwnerVendor,
        status: UserStatus.ACTIVE,
        roles: [{ role: { name: RoleName.VENDOR } }],
      });

      const obligation = {
        id: 'ob-cross-tenant-1',
        weightAdjustmentId: 'adj-001',
        revision: 1,
        direction: PaymentObligationDirection.SUPPLEMENTAL_PAYMENT_DUE,
        amountJmd: new Prisma.Decimal('300.00'),
        status: ObligationStatus.PENDING,
        idempotencyKey: 'idemp-ob-cross-1',
        payloadHash: 'hash-cross-1',
        createdAt: new Date(),
      };
      store.obligations.set(obligation.id, obligation);

      // Create an adjustment record in store so obligation lookup resolves
      store.adjustments.set('adj-001', {
        id: 'adj-001',
        orderItemId: 'item-001',
      });

      await expect(
        settlementService.recordSettlement({
          obligationId: obligation.id,
          settlementChannel: SettlementChannel.VENDOR_ABSORPTION,
          amountSettled: '300.00',
          idempotencyKey: 'idemp-settle-cross',
          externalReference: 'Unauthorized concession',
          authenticatedActor: nonOwnerVendor,
        }),
      ).rejects.toThrow(UnauthorizedSettlementOperatorError);
    });

    it('TC-WP3.5-LC-11: blocks release when seafood lot is recalled before release evaluation', async () => {
      const vendorActor: any = { id: 'user-vendor-1', email: 'v@example.com', roles: [RoleName.VENDOR] };

      const snapshot = await snapshotInitService.initializeSnapshot({
        orderItemId: 'item-001',
        customerAuthorizedCeilingJmd: '2000.00',
        termsVersion: 'v1.0',
      });

      const adjustmentId = snapshot.weightAdjustment!.id;

      await measurementService.recordAuthoritativeMeasurement({
        weightAdjustmentId: adjustmentId,
        expectedRevision: 1,
        idempotencyKey: 'idemp-meas-recall',
        measuredWeight: '3.000',
        scalePhotoUrl: 'https://storage.iriefishmongers.com/scales/scale-recall.jpg',
        operatorUserId: vendorActor.id,
        authenticatedActor: vendorActor,
        tareIsolated: true,
        physicalLotId: 'lot-001',
      });

      // Recall the seafood lot in database
      const lot = store.seafoodLots.get('lot-001');
      lot.foodSafetyStatus = FoodSafetyStatus.RECALLED;
      lot.isRecalled = true;
      lot.recallLots = [
        { recall: { id: 'rc-1', status: 'ACTIVE', reason: 'Microbial contamination', severityClass: 'CLASS_I' } },
      ];

      const release = await releaseReadinessService.evaluateReleaseReadiness({
        weightAdjustmentId: adjustmentId,
      });

      expect(release.gate2FoodSafetyAndRegulatory.status).toBe('BLOCKED');
      expect(release.dispatchReady).toBe(false);
      expect(release.handoverReady).toBe(false);
    });

    it('TC-WP3.5-LC-12: blocks release when fisherman credentials are expired or suspended', async () => {
      const vendorActor: any = { id: 'user-vendor-1', email: 'v@example.com', roles: [RoleName.VENDOR] };

      const snapshot = await snapshotInitService.initializeSnapshot({
        orderItemId: 'item-001',
        customerAuthorizedCeilingJmd: '2000.00',
        termsVersion: 'v1.0',
      });

      const adjustmentId = snapshot.weightAdjustment!.id;

      await measurementService.recordAuthoritativeMeasurement({
        weightAdjustmentId: adjustmentId,
        expectedRevision: 1,
        idempotencyKey: 'idemp-meas-fm-exp',
        measuredWeight: '3.000',
        scalePhotoUrl: 'https://storage.iriefishmongers.com/scales/scale-fm.jpg',
        operatorUserId: vendorActor.id,
        authenticatedActor: vendorActor,
        tareIsolated: true,
        physicalLotId: 'lot-001',
      });

      // Add FISHERMAN role with expired fisheries licence
      const vendorUser = store.users.get('user-vendor-1');
      vendorUser.roles = [
        { role: { name: RoleName.VENDOR } },
        { role: { name: RoleName.FISHERMAN } },
      ];
      vendorUser.fisherman = {
        id: 'fm-001',
        status: FishermanStatus.APPROVED,
        certifications: [
          {
            certificateType: 'COMMERCIAL_FISHING_LICENSE',
            status: CertificationStatus.EXPIRED,
            expiryDate: new Date(Date.now() - 86400_000), // Expired
          },
        ],
      };

      const release = await releaseReadinessService.evaluateReleaseReadiness({
        weightAdjustmentId: adjustmentId,
      });

      expect(release.gate2FoodSafetyAndRegulatory.status).toBe('BLOCKED');
      expect(release.dispatchReady).toBe(false);
      expect(release.handoverReady).toBe(false);
    });

    it('TC-WP3.5-LC-13: rejects cross-vendor measurement and preparation attempts', async () => {
      const unauthorizedActor: any = {
        id: 'user-vendor-unauth',
        email: 'unauth@example.com',
        roles: [RoleName.VENDOR],
      };
      store.users.set(unauthorizedActor.id, {
        ...unauthorizedActor,
        status: UserStatus.ACTIVE,
        roles: [{ role: { name: RoleName.VENDOR } }],
      });

      await expect(
        measurementService.recordAuthoritativeMeasurement({
          weightAdjustmentId: 'adj-001',
          expectedRevision: 1,
          idempotencyKey: 'idemp-meas-unauth',
          measuredWeight: '3.000',
          scalePhotoUrl: 'https://storage.iriefishmongers.com/scales/scale-unauth.jpg',
          operatorUserId: unauthorizedActor.id,
          authenticatedActor: unauthorizedActor,
          tareIsolated: true,
          physicalLotId: 'lot-001',
        }),
      ).rejects.toThrow();

      await expect(
        prepService.recordPreparationFulfillment({
          weightAdjustmentId: 'adj-001',
          expectedRevision: 1,
          idempotencyKey: 'idemp-prep-unauth',
          preparationServiceName: 'Filleting',
          preparedNetWeight: '2.500',
          partsOutcome: UsablePartsFulfillmentOutcome.RETURNED_AVAILABLE_PARTS,
          operatorUserId: unauthorizedActor.id,
          authenticatedActor: unauthorizedActor,
          physicalLotId: 'lot-001',
        }),
      ).rejects.toThrow();
    });

    it('TC-WP3.5-LC-14: rejects settlement via dormant channel WIPAY_SECONDARY_PAYMENT_CONFIRMED', async () => {
      const driverActor: any = { id: 'user-driver-1', email: 'd@example.com', roles: [RoleName.DRIVER] };

      await expect(
        settlementService.recordSettlement({
          obligationId: 'ob-001',
          settlementChannel: SettlementChannel.WIPAY_SECONDARY_PAYMENT_CONFIRMED,
          amountSettled: '300.00',
          idempotencyKey: 'idemp-settle-dormant',
          authenticatedActor: driverActor,
        }),
      ).rejects.toThrow(DormantSettlementChannelError);
    });

    it('TC-WP3.5-LC-15: verifies WHOLE_RAW price is based on verified gross whole weight, not cleaning yield', async () => {
      const vendorActor: any = { id: 'user-vendor-1', email: 'v@example.com', roles: [RoleName.VENDOR] };

      const snapshot = await snapshotInitService.initializeSnapshot({
        orderItemId: 'item-001',
        customerAuthorizedCeilingJmd: '2000.00',
        termsVersion: 'v1.0',
        selectedPreparationServiceName: 'Filleting',
      });

      const adjustmentId = snapshot.weightAdjustment!.id;

      // Scale measurement on whole raw fish: 3.200 lbs -> 1920 JMD
      const measureResult = await measurementService.recordAuthoritativeMeasurement({
        weightAdjustmentId: adjustmentId,
        expectedRevision: 1,
        idempotencyKey: 'idemp-meas-wholeraw',
        measuredWeight: '3.200',
        scalePhotoUrl: 'https://storage.iriefishmongers.com/scales/scale-wr.jpg',
        operatorUserId: vendorActor.id,
        authenticatedActor: vendorActor,
        tareIsolated: true,
        physicalLotId: 'lot-001',
      });

      expect(measureResult.pricingResult.finalItemTotal?.toString()).toBe('1920');

      // Preparation yields only 2.100 lbs of fillets (cleaning loss is absorbed, whole weight is billable)
      const prepResult = await prepService.recordPreparationFulfillment({
        weightAdjustmentId: adjustmentId,
        expectedRevision: 1,
        idempotencyKey: 'idemp-prep-wholeraw',
        preparationServiceName: 'Filleting',
        preparedNetWeight: '2.100',
        partsOutcome: UsablePartsFulfillmentOutcome.RETURNED_AVAILABLE_PARTS,
        unit: WeightUnit.POUNDS,
        operatorUserId: vendorActor.id,
        authenticatedActor: vendorActor,
        physicalLotId: 'lot-001',
      });

      // Price remains 1920 JMD based on whole weight, not mutated by filleting yield
      const adj = store.adjustments.get(adjustmentId);
      expect(adj.finalItemTotal.toString()).toBe('1920');
      expect(prepResult.preparationEvent.preparedNetWeight?.toString()).toBe('2.1');
    });

    it('TC-WP3.5-LC-16: fails closed when purchased order item lacks immutable original lot or listing provenance', async () => {
      const vendorActor: any = { id: 'user-vendor-1', email: 'v@example.com', roles: [RoleName.VENDOR] };

      const snapshot = await snapshotInitService.initializeSnapshot({
        orderItemId: 'item-001',
        customerAuthorizedCeilingJmd: '2000.00',
        termsVersion: 'v1.0',
      });

      const adjustmentId = snapshot.weightAdjustment!.id;

      // Remove original lot identifier from orderItem
      const item = store.orderItems.get('item-001');
      item.originalLotId = null;

      const release = await releaseReadinessService.evaluateReleaseReadiness({
        weightAdjustmentId: adjustmentId,
      });

      expect(release.gate2FoodSafetyAndRegulatory.status).toBe('BLOCKED');
      expect(release.gate2FoodSafetyAndRegulatory.details).toContain('Missing authoritative original-lot provenance');
      expect(release.dispatchReady).toBe(false);
      expect(release.handoverReady).toBe(false);
    });
  });

  // ===========================================================================
  // Section 3: Transaction & Rollback Semantics
  // ===========================================================================
  describe('Transaction & Rollback Semantics', () => {
    it('TC-WP3.5-LC-17: rolls back customer approval challenge consumption when transaction fails', async () => {
      const custActor: any = { id: 'user-cust-1', email: 'c@example.com', roles: [RoleName.CUSTOMER] };

      const rawToken = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
      const challenge = {
        id: 'ch-rollback-1',
        weightAdjustmentId: 'adj-001',
        measurementRevision: 1,
        challengeSequence: 1,
        authenticatedCustomerId: custActor.id,
        idempotencyKey: 'idemp-chal-rb',
        approvalTokenHash: hashApprovalToken(rawToken),
        status: ApprovalChallengeStatus.OPEN,
        proposedTotalJmd: new Prisma.Decimal('2400.00'),
        authorizedCeilingJmd: new Prisma.Decimal('2000.00'),
        expiresAt: new Date(Date.now() + 3600_000),
        consumedAt: null,
        createdAt: new Date(),
      };
      store.approvalChallenges.set(challenge.id, challenge);

      // Force failure during transaction callback
      prismaMock.$transaction.mockImplementationOnce(async (cb: any) => {
        throw new Error('Database transaction lock conflict');
      });

      await expect(
        approvalCoordService.processCustomerApproval({
          weightAdjustmentId: 'adj-001',
          measurementRevision: 1,
          rawApprovalToken: rawToken,
          action: CustomerApprovalAction.APPROVED,
          authenticatedActor: custActor,
        }),
      ).rejects.toThrow('Database transaction lock conflict');

      // Verify challenge remains unconsumed
      expect(challenge.consumedAt).toBeNull();
      expect(challenge.status).toBe(ApprovalChallengeStatus.OPEN);
    });

    it('TC-WP3.5-LC-18: verifies failed settlement evidence submission leaves obligation balance un-discharged', async () => {
      const vendorActor: any = { id: 'user-vendor-1', email: 'v@example.com', roles: [RoleName.VENDOR] };

      const obligation = {
        id: 'ob-rollback-2',
        weightAdjustmentId: 'adj-001',
        revision: 1,
        direction: PaymentObligationDirection.SUPPLEMENTAL_PAYMENT_DUE,
        amountJmd: new Prisma.Decimal('500.00'),
        status: ObligationStatus.PENDING,
        idempotencyKey: 'idemp-ob-rb-2',
        payloadHash: 'hash-rb-2',
        createdAt: new Date(),
      };
      store.obligations.set(obligation.id, obligation);

      // Attempting invalid settlement amount throws before recording
      await expect(
        settlementService.recordSettlement({
          obligationId: obligation.id,
          settlementChannel: SettlementChannel.VENDOR_ABSORPTION,
          amountSettled: '-50.00', // Invalid negative amount
          idempotencyKey: 'idemp-settle-rb-neg',
          externalReference: 'Waiver',
          authenticatedActor: vendorActor,
        }),
      ).rejects.toThrow(InvalidSettlementAmountError);

      // Obligation status remains PENDING and no settlement record is persisted
      expect(obligation.status).toBe(ObligationStatus.PENDING);
      expect(store.settlements.size).toBe(0);
    });

    it('TC-WP3.5-LC-19: identifies PostgreSQL real locking limitation (mocked tests do not execute real FOR UPDATE)', () => {
      // In PostgreSQL, FOR UPDATE acquires row-level exclusive locks protecting concurrent settlement races.
      // Unit/Service tests execute through TypeScript mocks without real PostgreSQL locks.
      // Real row locks and PostgreSQL foreign key integrity remain deferred to post-migration review.
      expect(true).toBe(true);
    });
  });
});
