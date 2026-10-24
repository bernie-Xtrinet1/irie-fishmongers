import { Test, TestingModule } from '@nestjs/testing';
import {
  ObligationStatus,
  PaymentObligationDirection,
  Prisma,
  RoleName,
  SettlementChannel,
  UserStatus,
} from '@prisma/client';
import Decimal from 'decimal.js';

import { PrismaService } from '../../../../database/prisma.service';
import {
  AdjustmentNotFoundError,
  IdempotencyPayloadConflictError,
  InvalidSettlementAmountError,
  ObligationAlreadySettledError,
  SettlementAmountExceedsObligationError,
  SettlementChannelDirectionMismatchError,
} from '../../repositories/errors/weight-adjustment-repository.errors';
import {
  FinancialEvidenceClassification,
  WeightFinancialObligationRepository,
} from '../../repositories/weight-financial-obligation.repository';
import { WeightAdjustmentSettlementService } from '../weight-adjustment-settlement.service';
import {
  DormantSettlementChannelError,
  InvalidSettlementEvidenceError,
  RecordFinancialSettlementInput,
  UnauthorizedSettlementOperatorError,
} from '../types/weight-adjustment-coordination.types';

describe('WeightAdjustmentSettlementService', () => {
  let service: WeightAdjustmentSettlementService;
  let prismaMock: any;
  let obligationRepoMock: any;

  const mockDriverActor = {
    id: 'user-driver-1',
    email: 'driver@example.com',
    roles: [RoleName.DRIVER],
  };

  const mockAdminActor = {
    id: 'user-admin-1',
    email: 'admin@example.com',
    roles: [RoleName.ADMINISTRATOR],
  };

  const mockVendorActor = {
    id: 'user-vendor-owner-1',
    email: 'vendor@example.com',
    roles: [RoleName.VENDOR],
  };

  const createMockObligation = (overrides?: Record<string, any>) => ({
    id: 'ob-001',
    weightAdjustmentId: 'adj-001',
    revision: 1,
    direction: PaymentObligationDirection.SUPPLEMENTAL_PAYMENT_DUE,
    amountJmd: new Prisma.Decimal('500.00'),
    status: ObligationStatus.PENDING,
    idempotencyKey: 'idemp-ob-1',
    payloadHash: 'hash-ob-1',
    createdAt: new Date(),
    weightAdjustment: {
      id: 'adj-001',
      orderItem: {
        id: 'item-001',
        vendorOrder: {
          id: 'vo-001',
          vendor: {
            id: 'vendor-123',
            userId: 'user-vendor-owner-1',
          },
          delivery: {
            id: 'del-001',
            vendorOrderId: 'vo-001',
            driverId: 'drv-001',
            driver: {
              id: 'drv-001',
              userId: 'user-driver-1',
            },
          },
        },
      },
    },
    ...overrides,
  });

  const createMockSettlement = (overrides?: Record<string, any>) => ({
    id: 'set-001',
    obligationId: 'ob-001',
    idempotencyKey: 'idemp-set-1',
    payloadHash: 'hash-set-1',
    settlementChannel: SettlementChannel.COD_DOORSTEP_RECEIPT,
    amountSettled: new Prisma.Decimal('500.00'),
    externalReference: 'REC-12345',
    evidenceDocumentUrl: 'https://storage.iriefishmongers.com/receipts/rec-12345.jpg',
    settledByUserId: 'user-driver-1',
    settledAt: new Date(),
    ...overrides,
  });

  beforeEach(async () => {
    prismaMock = {
      $transaction: jest.fn(async (cb: any) => cb(prismaMock)),
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'user-driver-1',
          status: UserStatus.ACTIVE,
          roles: [{ role: { name: RoleName.DRIVER } }],
        }),
      },
      weightAdjustmentObligation: {
        findUnique: jest.fn().mockResolvedValue(createMockObligation()),
        findUniqueOrThrow: jest.fn().mockResolvedValue(createMockObligation()),
      },
    };

    obligationRepoMock = {
      recordSettlementEvidence: jest.fn().mockResolvedValue({
        settlement: createMockSettlement(),
        isReplay: false,
      }),
      getObligationBalance: jest.fn().mockResolvedValue({
        obligationId: 'ob-001',
        totalAmountJmd: '500.00',
        totalSettledJmd: '500.00',
        remainingBalanceJmd: '0.00',
        status: ObligationStatus.SETTLED,
        isFullySettled: true,
      }),
      classifySettlementRecord: jest.fn((channel: SettlementChannel) => {
        if (channel === SettlementChannel.COD_DOORSTEP_RECEIPT) {
          return FinancialEvidenceClassification.CUSTOMER_PAYMENT;
        }
        if (channel === SettlementChannel.VENDOR_ABSORPTION) {
          return FinancialEvidenceClassification.VENDOR_ABSORPTION_WAIVER;
        }
        if (channel === SettlementChannel.ADMIN_CREDIT_MEMO_ISSUED) {
          return FinancialEvidenceClassification.CUSTOMER_CREDIT_MEMO;
        }
        throw new Error(`Unknown channel: ${channel}`);
      }),
      findObligationsByAdjustmentId: jest.fn().mockResolvedValue([createMockObligation()]),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WeightAdjustmentSettlementService,
        { provide: PrismaService, useValue: prismaMock },
        { provide: WeightFinancialObligationRepository, useValue: obligationRepoMock },
      ],
    }).compile();

    service = module.get<WeightAdjustmentSettlementService>(WeightAdjustmentSettlementService);
  });

  describe('recordSettlement - Validation & Preconditions', () => {
    it('TC-WP3.4-SET-01: rejects when authenticated actor is missing', async () => {
      const input: RecordFinancialSettlementInput = {
        obligationId: 'ob-001',
        settlementChannel: SettlementChannel.COD_DOORSTEP_RECEIPT,
        amountSettled: '500.00',
        idempotencyKey: 'idemp-1',
        authenticatedActor: null as any,
      };

      await expect(service.recordSettlement(input)).rejects.toThrow(
        UnauthorizedSettlementOperatorError,
      );
    });

    it('TC-WP3.4-SET-02: rejects WiPay secondary payment channel as dormant', async () => {
      const input: RecordFinancialSettlementInput = {
        obligationId: 'ob-001',
        settlementChannel: SettlementChannel.WIPAY_SECONDARY_PAYMENT_CONFIRMED,
        amountSettled: '500.00',
        idempotencyKey: 'idemp-1',
        authenticatedActor: mockDriverActor,
      };

      await expect(service.recordSettlement(input)).rejects.toThrow(
        DormantSettlementChannelError,
      );
    });

    it('TC-WP3.4-SET-03: rejects invalid, negative, NaN or zero settlement amounts', async () => {
      const invalidAmounts = ['0.00', '-50.00', 'invalid-num', 'NaN', 'Infinity'];

      for (const amount of invalidAmounts) {
        const input: RecordFinancialSettlementInput = {
          obligationId: 'ob-001',
          settlementChannel: SettlementChannel.COD_DOORSTEP_RECEIPT,
          amountSettled: amount,
          idempotencyKey: 'idemp-1',
          authenticatedActor: mockDriverActor,
        };

        await expect(service.recordSettlement(input)).rejects.toThrow(
          InvalidSettlementAmountError,
        );
      }
    });

    it('TC-WP3.4-SET-04: rejects when actor user is inactive or suspended in database', async () => {
      prismaMock.user.findUnique.mockResolvedValueOnce({
        id: 'user-driver-1',
        status: UserStatus.SUSPENDED,
        roles: [{ role: { name: RoleName.DRIVER } }],
      });

      const input: RecordFinancialSettlementInput = {
        obligationId: 'ob-001',
        settlementChannel: SettlementChannel.COD_DOORSTEP_RECEIPT,
        amountSettled: '500.00',
        idempotencyKey: 'idemp-1',
        externalReference: 'REC-12345',
        evidenceDocumentUrl: 'https://storage.iriefishmongers.com/doc.jpg',
        authenticatedActor: mockDriverActor,
      };

      await expect(service.recordSettlement(input)).rejects.toThrow(
        UnauthorizedSettlementOperatorError,
      );
    });

    it('TC-WP3.4-SET-05: rejects when obligation does not exist', async () => {
      prismaMock.weightAdjustmentObligation.findUnique.mockResolvedValueOnce(null);

      const input: RecordFinancialSettlementInput = {
        obligationId: 'ob-missing',
        settlementChannel: SettlementChannel.COD_DOORSTEP_RECEIPT,
        amountSettled: '500.00',
        idempotencyKey: 'idemp-1',
        externalReference: 'REC-12345',
        evidenceDocumentUrl: 'https://storage.iriefishmongers.com/doc.jpg',
        authenticatedActor: mockDriverActor,
      };

      await expect(service.recordSettlement(input)).rejects.toThrow(
        AdjustmentNotFoundError,
      );
    });
  });

  describe('recordSettlement - Role & Channel Evidence Enforcement', () => {
    it('TC-WP3.4-SET-06: rejects COD receipt when actor is not a platform user with active status', async () => {
      prismaMock.user.findUnique.mockResolvedValueOnce({
        id: 'user-cust-1',
        status: UserStatus.ACTIVE,
        roles: [{ role: { name: RoleName.CUSTOMER } }],
      });

      const input: RecordFinancialSettlementInput = {
        obligationId: 'ob-001',
        settlementChannel: SettlementChannel.COD_DOORSTEP_RECEIPT,
        amountSettled: '500.00',
        idempotencyKey: 'idemp-1',
        externalReference: 'REC-12345',
        evidenceDocumentUrl: 'https://storage.iriefishmongers.com/doc.jpg',
        authenticatedActor: { id: 'user-cust-1', email: 'c@example.com', roles: [RoleName.CUSTOMER] },
      };

      await expect(service.recordSettlement(input)).rejects.toThrow(
        UnauthorizedSettlementOperatorError,
      );
    });

    it('TC-WP3.4-SET-06A (Test 13): rejects COD receipt when actor is an unassigned driver', async () => {
      // Driver user exists and is active, but is not the driver assigned to this delivery (del-001 is assigned to user-driver-1)
      prismaMock.user.findUnique.mockResolvedValueOnce({
        id: 'user-driver-unassigned',
        status: UserStatus.ACTIVE,
        roles: [{ role: { name: RoleName.DRIVER } }],
      });

      const input: RecordFinancialSettlementInput = {
        obligationId: 'ob-001',
        settlementChannel: SettlementChannel.COD_DOORSTEP_RECEIPT,
        amountSettled: '500.00',
        idempotencyKey: 'idemp-unassigned-drv',
        externalReference: 'REC-99999',
        evidenceDocumentUrl: 'https://storage.iriefishmongers.com/doc.jpg',
        authenticatedActor: {
          id: 'user-driver-unassigned',
          email: 'unassigned@example.com',
          roles: [RoleName.DRIVER],
        },
      };

      await expect(service.recordSettlement(input)).rejects.toThrow(
        UnauthorizedSettlementOperatorError,
      );
    });

    it('TC-WP3.4-SET-06B (Test 14): rejects COD receipt when actor is an unrelated administrator without assignment', async () => {
      // Admin user exists and is active, but administrator role cannot bypass delivery assignment or substitute for driver receipt
      prismaMock.user.findUnique.mockResolvedValueOnce({
        id: 'user-admin-1',
        status: UserStatus.ACTIVE,
        roles: [{ role: { name: RoleName.ADMINISTRATOR } }],
      });

      const input: RecordFinancialSettlementInput = {
        obligationId: 'ob-001',
        settlementChannel: SettlementChannel.COD_DOORSTEP_RECEIPT,
        amountSettled: '500.00',
        idempotencyKey: 'idemp-admin-cod',
        externalReference: 'REC-ADMIN-1',
        evidenceDocumentUrl: 'https://storage.iriefishmongers.com/admin.jpg',
        authenticatedActor: mockAdminActor,
      };

      await expect(service.recordSettlement(input)).rejects.toThrow(
        UnauthorizedSettlementOperatorError,
      );
    });

    it('TC-WP3.4-SET-06C: rejects COD receipt when vendor order has no delivery record', async () => {
      const obligationWithoutDelivery = createMockObligation({
        weightAdjustment: {
          id: 'adj-001',
          orderItem: {
            id: 'item-001',
            vendorOrder: {
              id: 'vo-001',
              vendor: { id: 'vendor-123', userId: 'user-vendor-owner-1' },
              delivery: null,
            },
          },
        },
      });

      prismaMock.weightAdjustmentObligation.findUnique.mockResolvedValueOnce(obligationWithoutDelivery);

      const input: RecordFinancialSettlementInput = {
        obligationId: 'ob-001',
        settlementChannel: SettlementChannel.COD_DOORSTEP_RECEIPT,
        amountSettled: '500.00',
        idempotencyKey: 'idemp-no-del',
        externalReference: 'REC-12345',
        evidenceDocumentUrl: 'https://storage.iriefishmongers.com/doc.jpg',
        authenticatedActor: mockDriverActor,
      };

      await expect(service.recordSettlement(input)).rejects.toThrow(
        UnauthorizedSettlementOperatorError,
      );
    });

    it('TC-WP3.4-SET-07: rejects COD receipt when driver physical receipt reference is missing', async () => {
      const input: RecordFinancialSettlementInput = {
        obligationId: 'ob-001',
        settlementChannel: SettlementChannel.COD_DOORSTEP_RECEIPT,
        amountSettled: '500.00',
        idempotencyKey: 'idemp-1',
        externalReference: '   ',
        evidenceDocumentUrl: 'https://storage.iriefishmongers.com/doc.jpg',
        authenticatedActor: mockDriverActor,
      };

      await expect(service.recordSettlement(input)).rejects.toThrow(
        InvalidSettlementEvidenceError,
      );
    });

    it('TC-WP3.4-SET-08: rejects COD receipt when evidence document URL is missing', async () => {
      const input: RecordFinancialSettlementInput = {
        obligationId: 'ob-001',
        settlementChannel: SettlementChannel.COD_DOORSTEP_RECEIPT,
        amountSettled: '500.00',
        idempotencyKey: 'idemp-1',
        externalReference: 'REC-12345',
        evidenceDocumentUrl: '',
        authenticatedActor: mockDriverActor,
      };

      await expect(service.recordSettlement(input)).rejects.toThrow(
        InvalidSettlementEvidenceError,
      );
    });

    it('TC-WP3.4-SET-09: allows vendor absorption when actor is the vendor account owner', async () => {
      prismaMock.user.findUnique.mockResolvedValueOnce({
        id: 'user-vendor-owner-1',
        status: UserStatus.ACTIVE,
        roles: [{ role: { name: RoleName.VENDOR } }],
      });

      obligationRepoMock.recordSettlementEvidence.mockResolvedValueOnce({
        settlement: createMockSettlement({
          settlementChannel: SettlementChannel.VENDOR_ABSORPTION,
          settledByUserId: 'user-vendor-owner-1',
        }),
        isReplay: false,
      });

      const input: RecordFinancialSettlementInput = {
        obligationId: 'ob-001',
        settlementChannel: SettlementChannel.VENDOR_ABSORPTION,
        amountSettled: '500.00',
        idempotencyKey: 'idemp-abs-1',
        externalReference: 'Concession waived for regular high-volume customer.',
        authenticatedActor: mockVendorActor,
      };

      const result = await service.recordSettlement(input);

      expect(result.evidenceClassification).toBe(
        FinancialEvidenceClassification.VENDOR_ABSORPTION_WAIVER,
      );
      expect(result.isFullySettled).toBe(true);
    });

    it('TC-WP3.4-SET-10: rejects vendor absorption when actor is another vendor (cross-tenant violation)', async () => {
      prismaMock.user.findUnique.mockResolvedValueOnce({
        id: 'user-other-vendor',
        status: UserStatus.ACTIVE,
        roles: [{ role: { name: RoleName.VENDOR } }],
      });

      const input: RecordFinancialSettlementInput = {
        obligationId: 'ob-001',
        settlementChannel: SettlementChannel.VENDOR_ABSORPTION,
        amountSettled: '500.00',
        idempotencyKey: 'idemp-abs-1',
        externalReference: 'Concession waived.',
        authenticatedActor: {
          id: 'user-other-vendor',
          email: 'other@example.com',
          roles: [RoleName.VENDOR],
        },
      };

      await expect(service.recordSettlement(input)).rejects.toThrow(
        UnauthorizedSettlementOperatorError,
      );
    });

    it('TC-WP3.4-SET-11: rejects admin credit memo when actor does not hold ADMINISTRATOR role', async () => {
      prismaMock.user.findUnique.mockResolvedValueOnce({
        id: 'user-driver-1',
        status: UserStatus.ACTIVE,
        roles: [{ role: { name: RoleName.DRIVER } }],
      });

      const input: RecordFinancialSettlementInput = {
        obligationId: 'ob-001',
        settlementChannel: SettlementChannel.ADMIN_CREDIT_MEMO_ISSUED,
        amountSettled: '500.00',
        idempotencyKey: 'idemp-cm-1',
        externalReference: 'CM-10023',
        authenticatedActor: mockDriverActor,
      };

      await expect(service.recordSettlement(input)).rejects.toThrow(
        UnauthorizedSettlementOperatorError,
      );
    });

    it('TC-WP3.4-SET-12: rejects admin credit memo when credit memo reference number is missing', async () => {
      prismaMock.user.findUnique.mockResolvedValueOnce({
        id: 'user-admin-1',
        status: UserStatus.ACTIVE,
        roles: [{ role: { name: RoleName.ADMINISTRATOR } }],
      });

      const input: RecordFinancialSettlementInput = {
        obligationId: 'ob-001',
        settlementChannel: SettlementChannel.ADMIN_CREDIT_MEMO_ISSUED,
        amountSettled: '500.00',
        idempotencyKey: 'idemp-cm-1',
        externalReference: '   ',
        authenticatedActor: mockAdminActor,
      };

      await expect(service.recordSettlement(input)).rejects.toThrow(
        InvalidSettlementEvidenceError,
      );
    });
  });

  describe('recordSettlement - Directional Channel & Accounting Guarantees', () => {
    it('TC-WP3.4-SET-13: propagates SettlementChannelDirectionMismatchError when channel does not match obligation direction', async () => {
      obligationRepoMock.recordSettlementEvidence.mockRejectedValueOnce(
        new SettlementChannelDirectionMismatchError(
          SettlementChannel.ADMIN_CREDIT_MEMO_ISSUED,
          PaymentObligationDirection.SUPPLEMENTAL_PAYMENT_DUE,
        ),
      );

      prismaMock.user.findUnique.mockResolvedValueOnce({
        id: 'user-admin-1',
        status: UserStatus.ACTIVE,
        roles: [{ role: { name: RoleName.ADMINISTRATOR } }],
      });

      const input: RecordFinancialSettlementInput = {
        obligationId: 'ob-001',
        settlementChannel: SettlementChannel.ADMIN_CREDIT_MEMO_ISSUED,
        amountSettled: '500.00',
        idempotencyKey: 'idemp-cm-1',
        externalReference: 'CM-10023',
        authenticatedActor: mockAdminActor,
      };

      await expect(service.recordSettlement(input)).rejects.toThrow(
        SettlementChannelDirectionMismatchError,
      );
    });

    it('TC-WP3.4-SET-14: propagates SettlementAmountExceedsObligationError when amount exceeds remaining balance', async () => {
      obligationRepoMock.recordSettlementEvidence.mockRejectedValueOnce(
        new SettlementAmountExceedsObligationError('ob-001', '600.00', '500.00'),
      );

      const input: RecordFinancialSettlementInput = {
        obligationId: 'ob-001',
        settlementChannel: SettlementChannel.COD_DOORSTEP_RECEIPT,
        amountSettled: '600.00',
        idempotencyKey: 'idemp-1',
        externalReference: 'REC-12345',
        evidenceDocumentUrl: 'https://storage.iriefishmongers.com/doc.jpg',
        authenticatedActor: mockDriverActor,
      };

      await expect(service.recordSettlement(input)).rejects.toThrow(
        SettlementAmountExceedsObligationError,
      );
    });

    it('TC-WP3.4-SET-15: propagates ObligationAlreadySettledError when obligation was already fully settled', async () => {
      obligationRepoMock.recordSettlementEvidence.mockRejectedValueOnce(
        new ObligationAlreadySettledError('ob-001'),
      );

      const input: RecordFinancialSettlementInput = {
        obligationId: 'ob-001',
        settlementChannel: SettlementChannel.COD_DOORSTEP_RECEIPT,
        amountSettled: '100.00',
        idempotencyKey: 'idemp-2',
        externalReference: 'REC-12345',
        evidenceDocumentUrl: 'https://storage.iriefishmongers.com/doc.jpg',
        authenticatedActor: mockDriverActor,
      };

      await expect(service.recordSettlement(input)).rejects.toThrow(
        ObligationAlreadySettledError,
      );
    });

    it('TC-WP3.4-SET-16 (Test 15): returns idempotent replay with isReplay: true on identical duplicate COD evidence resubmission', async () => {
      obligationRepoMock.recordSettlementEvidence.mockResolvedValueOnce({
        settlement: createMockSettlement(),
        isReplay: true,
      });

      const input: RecordFinancialSettlementInput = {
        obligationId: 'ob-001',
        settlementChannel: SettlementChannel.COD_DOORSTEP_RECEIPT,
        amountSettled: '500.00',
        idempotencyKey: 'idemp-set-1',
        externalReference: 'REC-12345',
        evidenceDocumentUrl: 'https://storage.iriefishmongers.com/doc.jpg',
        authenticatedActor: mockDriverActor,
      };

      const result = await service.recordSettlement(input);

      expect(result.isReplay).toBe(true);
      expect(result.settlementRecord.id).toBe('set-001');
    });

    it('TC-WP3.4-SET-17: propagates IdempotencyPayloadConflictError when key matches but payload differs', async () => {
      obligationRepoMock.recordSettlementEvidence.mockRejectedValueOnce(
        new IdempotencyPayloadConflictError('idemp-set-1', 'hash-A', 'hash-B'),
      );

      const input: RecordFinancialSettlementInput = {
        obligationId: 'ob-001',
        settlementChannel: SettlementChannel.COD_DOORSTEP_RECEIPT,
        amountSettled: '500.00',
        idempotencyKey: 'idemp-set-1',
        externalReference: 'REC-DIFFERENT',
        evidenceDocumentUrl: 'https://storage.iriefishmongers.com/doc.jpg',
        authenticatedActor: mockDriverActor,
      };

      await expect(service.recordSettlement(input)).rejects.toThrow(
        IdempotencyPayloadConflictError,
      );
    });

    it('TC-WP3.4-SET-18: preserves caller-supplied Prisma transaction when provided', async () => {
      const externalTxMock: any = { ...prismaMock };

      const input: RecordFinancialSettlementInput = {
        obligationId: 'ob-001',
        settlementChannel: SettlementChannel.COD_DOORSTEP_RECEIPT,
        amountSettled: '500.00',
        idempotencyKey: 'idemp-1',
        externalReference: 'REC-12345',
        evidenceDocumentUrl: 'https://storage.iriefishmongers.com/doc.jpg',
        authenticatedActor: mockDriverActor,
      };

      await service.recordSettlement(input, externalTxMock);

      expect(prismaMock.$transaction).not.toHaveBeenCalled();
      expect(obligationRepoMock.recordSettlementEvidence).toHaveBeenCalledWith(
        expect.anything(),
        externalTxMock,
      );
    });
  });
});
