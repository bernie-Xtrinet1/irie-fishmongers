import { Test, TestingModule } from '@nestjs/testing';
import {
  ApprovalChallengeStatus,
  CustomerApprovalAction,
  CustomerWeightApprovalRecord,
  CustomerWeightApprovalStatus,
  Prisma,
  RoleName,
  UserStatus,
  WeightMeasurementStatus,
} from '@prisma/client';
import Decimal from 'decimal.js';

import { PrismaService } from '../../../../database/prisma.service';
import {
  AdjustmentNotFoundError,
  ChallengeAlreadyConsumedError,
  ChallengeExpiredError,
  ChallengeNotFoundError,
  ChallengeRevokedError,
  CustomerApprovalMismatchError,
} from '../../repositories/errors/weight-adjustment-repository.errors';
import { CustomerWeightApprovalChallengeRepository } from '../../repositories/customer-weight-approval-challenge.repository';
import { CustomerWeightConsentRepository } from '../../repositories/customer-weight-consent.repository';
import { SeafoodOrderWeightAdjustmentRepository } from '../../repositories/seafood-order-weight-adjustment.repository';
import { hashApprovalToken } from '../../repositories/utils/canonical-hash.util';
import { CustomerWeightApprovalCoordinationService } from '../customer-weight-approval-coordination.service';
import {
  ProcessCustomerApprovalInput,
  StaleApprovalRevisionError,
  UnauthorizedApprovalCustomerError,
} from '../types/weight-adjustment-coordination.types';

describe('CustomerWeightApprovalCoordinationService', () => {
  let service: CustomerWeightApprovalCoordinationService;
  let prismaMock: any;
  let challengeRepoMock: any;
  let consentRepoMock: any;
  let adjustmentRepoMock: any;

  const validToken = 'valid-token-32-characters-long-hex-random';
  const tokenHash = hashApprovalToken(validToken);

  const mockActor = {
    id: 'cust-123',
    email: 'cust@example.com',
    roles: [RoleName.CUSTOMER],
  };

  const createMockAdjustment = (overrides?: Record<string, any>) => ({
    id: 'adj-001',
    orderItemId: 'item-001',
    activeMeasurementRevision: 1,
    measurementStatus: WeightMeasurementStatus.MEASURED_EXCEEDS_CEILING,
    customerAuthorizedCeilingJmd: new Prisma.Decimal('1500.00'),
    finalItemTotal: new Prisma.Decimal('1750.00'),
    customerApprovalStatus: CustomerWeightApprovalStatus.AWAITING_APPROVAL,
    boundApprovalRevision: null,
    orderItem: {
      id: 'item-001',
      vendorOrder: {
        id: 'vo-001',
        order: {
          id: 'order-001',
          customerId: 'cust-123',
        },
      },
    },
    ...overrides,
  });

  const createMockChallenge = (overrides?: Record<string, any>) => ({
    id: 'chal-001',
    weightAdjustmentId: 'adj-001',
    measurementRevision: 1,
    challengeSequence: 1,
    authenticatedCustomerId: 'cust-123',
    proposedTotalJmd: new Prisma.Decimal('1750.00'),
    authorizedCeilingJmd: new Prisma.Decimal('1500.00'),
    differenceAmountJmd: new Prisma.Decimal('250.00'),
    approvalTokenHash: tokenHash,
    expiresAt: new Date(Date.now() + 900_000),
    status: ApprovalChallengeStatus.OPEN,
    consumedAt: null,
    revokedAt: null,
    createdAt: new Date(),
    ...overrides,
  });

  beforeEach(async () => {
    prismaMock = {
      $transaction: jest.fn(async (cb: any) => cb(prismaMock)),
      user: {
        findUnique: jest.fn().mockResolvedValue({ id: 'cust-123', status: UserStatus.ACTIVE }),
      },
      seafoodOrderWeightAdjustment: {
        findUnique: jest.fn().mockResolvedValue(createMockAdjustment()),
        findUniqueOrThrow: jest.fn().mockResolvedValue(createMockAdjustment({
          customerApprovalStatus: CustomerWeightApprovalStatus.APPROVED_BY_CUSTOMER,
          boundApprovalRevision: 1,
        })),
      },
    };

    challengeRepoMock = {
      findByTokenHash: jest.fn().mockResolvedValue(createMockChallenge()),
      consumeChallenge: jest.fn().mockResolvedValue(createMockChallenge({
        status: ApprovalChallengeStatus.CONSUMED,
        consumedAt: new Date(),
      })),
      findLatestChallenge: jest.fn().mockResolvedValue(createMockChallenge()),
    };

    consentRepoMock = {
      findApprovalByRevision: jest.fn().mockResolvedValue(null),
      recordCustomerApproval: jest.fn().mockResolvedValue({
        id: 'rec-001',
        weightAdjustmentId: 'adj-001',
        measurementRevision: 1,
        authenticatedCustomerId: 'cust-123',
        proposedTotalJmd: new Prisma.Decimal('1750.00'),
        authorizedCeilingJmd: new Prisma.Decimal('1500.00'),
        action: CustomerApprovalAction.APPROVED,
        approvalTokenHash: tokenHash,
        payloadHash: 'payload-hash-123',
        decidedAt: new Date(),
      } as CustomerWeightApprovalRecord),
    };

    adjustmentRepoMock = {};

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CustomerWeightApprovalCoordinationService,
        { provide: PrismaService, useValue: prismaMock },
        { provide: CustomerWeightApprovalChallengeRepository, useValue: challengeRepoMock },
        { provide: CustomerWeightConsentRepository, useValue: consentRepoMock },
        { provide: SeafoodOrderWeightAdjustmentRepository, useValue: adjustmentRepoMock },
      ],
    }).compile();

    service = module.get<CustomerWeightApprovalCoordinationService>(
      CustomerWeightApprovalCoordinationService,
    );
  });

  describe('processCustomerApproval - Security & Validation Checks', () => {
    it('TC-WP3.4-APP-01: rejects when authenticated actor context is missing', async () => {
      const input: ProcessCustomerApprovalInput = {
        weightAdjustmentId: 'adj-001',
        measurementRevision: 1,
        rawApprovalToken: validToken,
        action: CustomerApprovalAction.APPROVED,
        authenticatedActor: null as any,
      };

      await expect(service.processCustomerApproval(input)).rejects.toThrow(
        UnauthorizedApprovalCustomerError,
      );
    });

    it('TC-WP3.4-APP-02: rejects when approval token is empty', async () => {
      const input: ProcessCustomerApprovalInput = {
        weightAdjustmentId: 'adj-001',
        measurementRevision: 1,
        rawApprovalToken: '   ',
        action: CustomerApprovalAction.APPROVED,
        authenticatedActor: mockActor,
      };

      await expect(service.processCustomerApproval(input)).rejects.toThrow(
        UnauthorizedApprovalCustomerError,
      );
    });

    it('TC-WP3.4-APP-03: rejects when customer is suspended or inactive in database', async () => {
      prismaMock.user.findUnique.mockResolvedValueOnce({
        id: 'cust-123',
        status: UserStatus.SUSPENDED,
      });

      const input: ProcessCustomerApprovalInput = {
        weightAdjustmentId: 'adj-001',
        measurementRevision: 1,
        rawApprovalToken: validToken,
        action: CustomerApprovalAction.APPROVED,
        authenticatedActor: mockActor,
      };

      await expect(service.processCustomerApproval(input)).rejects.toThrow(
        UnauthorizedApprovalCustomerError,
      );
    });

    it('TC-WP3.4-APP-04: rejects when adjustment does not exist', async () => {
      prismaMock.seafoodOrderWeightAdjustment.findUnique.mockResolvedValueOnce(null);

      const input: ProcessCustomerApprovalInput = {
        weightAdjustmentId: 'adj-missing',
        measurementRevision: 1,
        rawApprovalToken: validToken,
        action: CustomerApprovalAction.APPROVED,
        authenticatedActor: mockActor,
      };

      await expect(service.processCustomerApproval(input)).rejects.toThrow(
        AdjustmentNotFoundError,
      );
    });

    it('TC-WP3.4-APP-05: rejects when authenticated actor is not the order customer (cross-tenant attack)', async () => {
      prismaMock.seafoodOrderWeightAdjustment.findUnique.mockResolvedValueOnce(
        createMockAdjustment({
          orderItem: {
            vendorOrder: {
              order: {
                customerId: 'cust-victim',
              },
            },
          },
        }),
      );

      const input: ProcessCustomerApprovalInput = {
        weightAdjustmentId: 'adj-001',
        measurementRevision: 1,
        rawApprovalToken: validToken,
        action: CustomerApprovalAction.APPROVED,
        authenticatedActor: mockActor, // cust-123 trying to approve cust-victim's order
      };

      await expect(service.processCustomerApproval(input)).rejects.toThrow(
        UnauthorizedApprovalCustomerError,
      );
    });

    it('TC-WP3.4-APP-06: rejects when measurement revision is stale or superseded', async () => {
      prismaMock.seafoodOrderWeightAdjustment.findUnique.mockResolvedValueOnce(
        createMockAdjustment({
          activeMeasurementRevision: 2, // Vendor re-weighed
        }),
      );

      const input: ProcessCustomerApprovalInput = {
        weightAdjustmentId: 'adj-001',
        measurementRevision: 1, // Stale revision
        rawApprovalToken: validToken,
        action: CustomerApprovalAction.APPROVED,
        authenticatedActor: mockActor,
      };

      await expect(service.processCustomerApproval(input)).rejects.toThrow(
        StaleApprovalRevisionError,
      );
    });

    it('TC-WP3.4-APP-07: rejects when token does not match any challenge', async () => {
      challengeRepoMock.findByTokenHash.mockResolvedValueOnce(null);

      const input: ProcessCustomerApprovalInput = {
        weightAdjustmentId: 'adj-001',
        measurementRevision: 1,
        rawApprovalToken: 'invalid-or-forged-token',
        action: CustomerApprovalAction.APPROVED,
        authenticatedActor: mockActor,
      };

      await expect(service.processCustomerApproval(input)).rejects.toThrow(
        ChallengeNotFoundError,
      );
    });

    it('TC-WP3.4-APP-08: rejects when challenge belongs to different weight adjustment', async () => {
      challengeRepoMock.findByTokenHash.mockResolvedValueOnce(
        createMockChallenge({
          weightAdjustmentId: 'adj-other',
        }),
      );

      const input: ProcessCustomerApprovalInput = {
        weightAdjustmentId: 'adj-001',
        measurementRevision: 1,
        rawApprovalToken: validToken,
        action: CustomerApprovalAction.APPROVED,
        authenticatedActor: mockActor,
      };

      await expect(service.processCustomerApproval(input)).rejects.toThrow(
        CustomerApprovalMismatchError,
      );
    });

    it('TC-WP3.4-APP-09: rejects when challenge revision differs from submitted revision', async () => {
      challengeRepoMock.findByTokenHash.mockResolvedValueOnce(
        createMockChallenge({
          measurementRevision: 2,
        }),
      );

      const input: ProcessCustomerApprovalInput = {
        weightAdjustmentId: 'adj-001',
        measurementRevision: 1,
        rawApprovalToken: validToken,
        action: CustomerApprovalAction.APPROVED,
        authenticatedActor: mockActor,
      };

      await expect(service.processCustomerApproval(input)).rejects.toThrow(
        StaleApprovalRevisionError,
      );
    });
  });

  describe('processCustomerApproval - Challenge Consumption & Lifecycle', () => {
    it('TC-WP3.4-APP-10: propagates ChallengeAlreadyConsumedError on replay of consumed challenge', async () => {
      challengeRepoMock.consumeChallenge.mockRejectedValueOnce(
        new ChallengeAlreadyConsumedError('chal-001', new Date()),
      );

      const input: ProcessCustomerApprovalInput = {
        weightAdjustmentId: 'adj-001',
        measurementRevision: 1,
        rawApprovalToken: validToken,
        action: CustomerApprovalAction.APPROVED,
        authenticatedActor: mockActor,
      };

      await expect(service.processCustomerApproval(input)).rejects.toThrow(
        ChallengeAlreadyConsumedError,
      );
    });

    it('TC-WP3.4-APP-11: propagates ChallengeExpiredError on expired challenge', async () => {
      challengeRepoMock.consumeChallenge.mockRejectedValueOnce(
        new ChallengeExpiredError('chal-001', new Date()),
      );

      const input: ProcessCustomerApprovalInput = {
        weightAdjustmentId: 'adj-001',
        measurementRevision: 1,
        rawApprovalToken: validToken,
        action: CustomerApprovalAction.APPROVED,
        authenticatedActor: mockActor,
      };

      await expect(service.processCustomerApproval(input)).rejects.toThrow(
        ChallengeExpiredError,
      );
    });

    it('TC-WP3.4-APP-12: propagates ChallengeRevokedError when challenge was superseded by vendor re-weigh', async () => {
      challengeRepoMock.consumeChallenge.mockRejectedValueOnce(
        new ChallengeRevokedError('chal-001', 'SUPERSEDED_BY_NEW_CHALLENGE'),
      );

      const input: ProcessCustomerApprovalInput = {
        weightAdjustmentId: 'adj-001',
        measurementRevision: 1,
        rawApprovalToken: validToken,
        action: CustomerApprovalAction.APPROVED,
        authenticatedActor: mockActor,
      };

      await expect(service.processCustomerApproval(input)).rejects.toThrow(
        ChallengeRevokedError,
      );
    });
  });

  describe('processCustomerApproval - Atomic Execution & Replay Handling', () => {
    it('TC-WP3.4-APP-13: successfully consumes challenge and records approval atomically', async () => {
      const input: ProcessCustomerApprovalInput = {
        weightAdjustmentId: 'adj-001',
        measurementRevision: 1,
        rawApprovalToken: validToken,
        action: CustomerApprovalAction.APPROVED,
        authenticatedActor: mockActor,
        ipAddress: '192.168.1.1',
        userAgent: 'Mozilla/5.0',
      };

      const result = await service.processCustomerApproval(input);

      expect(result.status).toBe('APPROVED');
      expect(result.isReplay).toBe(false);
      expect(result.challengeId).toBe('chal-001');
      expect(result.approvalRecord?.action).toBe(CustomerApprovalAction.APPROVED);

      expect(challengeRepoMock.consumeChallenge).toHaveBeenCalledWith(
        expect.objectContaining({
          challengeId: 'chal-001',
          expectedMeasurementRevision: 1,
          authenticatedCustomerId: 'cust-123',
        }),
        expect.anything(),
      );

      expect(consentRepoMock.recordCustomerApproval).toHaveBeenCalledWith(
        expect.objectContaining({
          weightAdjustmentId: 'adj-001',
          measurementRevision: 1,
          authenticatedCustomerId: 'cust-123',
          rawApprovalToken: validToken,
          action: CustomerApprovalAction.APPROVED,
        }),
        expect.anything(),
      );
    });

    it('TC-WP3.4-APP-14: successfully records customer rejection with documented reason', async () => {
      consentRepoMock.recordCustomerApproval.mockResolvedValueOnce({
        id: 'rec-002',
        weightAdjustmentId: 'adj-001',
        measurementRevision: 1,
        authenticatedCustomerId: 'cust-123',
        action: CustomerApprovalAction.REJECTED,
        rejectionReason: 'Total price exceeds budget.',
      });

      prismaMock.seafoodOrderWeightAdjustment.findUniqueOrThrow.mockResolvedValueOnce(
        createMockAdjustment({
          customerApprovalStatus: CustomerWeightApprovalStatus.REJECTED_BY_CUSTOMER,
        }),
      );

      const input: ProcessCustomerApprovalInput = {
        weightAdjustmentId: 'adj-001',
        measurementRevision: 1,
        rawApprovalToken: validToken,
        action: CustomerApprovalAction.REJECTED,
        authenticatedActor: mockActor,
        rejectionReason: 'Total price exceeds budget.',
      };

      const result = await service.processCustomerApproval(input);

      expect(result.status).toBe('REJECTED');
      expect(result.weightAdjustment.customerApprovalStatus).toBe(
        CustomerWeightApprovalStatus.REJECTED_BY_CUSTOMER,
      );
      expect(consentRepoMock.recordCustomerApproval).toHaveBeenCalledWith(
        expect.objectContaining({
          action: CustomerApprovalAction.REJECTED,
          rejectionReason: 'Total price exceeds budget.',
        }),
        expect.anything(),
      );
    });

    it('TC-WP3.4-APP-15: returns idempotent replay when exact decision was already persisted', async () => {
      consentRepoMock.findApprovalByRevision.mockResolvedValueOnce({
        id: 'rec-001',
        weightAdjustmentId: 'adj-001',
        measurementRevision: 1,
        approvalTokenHash: tokenHash,
        action: CustomerApprovalAction.APPROVED,
      });

      const input: ProcessCustomerApprovalInput = {
        weightAdjustmentId: 'adj-001',
        measurementRevision: 1,
        rawApprovalToken: validToken,
        action: CustomerApprovalAction.APPROVED,
        authenticatedActor: mockActor,
      };

      const result = await service.processCustomerApproval(input);

      expect(result.status).toBe('IDEMPOTENT_REPLAY');
      expect(result.isReplay).toBe(true);
      expect(challengeRepoMock.consumeChallenge).not.toHaveBeenCalled();
      expect(consentRepoMock.recordCustomerApproval).not.toHaveBeenCalled();
    });

    it('TC-WP3.4-APP-16: rejects when revision was already decided under different action/token', async () => {
      consentRepoMock.findApprovalByRevision.mockResolvedValueOnce({
        id: 'rec-001',
        weightAdjustmentId: 'adj-001',
        measurementRevision: 1,
        approvalTokenHash: 'different-token-hash',
        action: CustomerApprovalAction.REJECTED,
      });

      const input: ProcessCustomerApprovalInput = {
        weightAdjustmentId: 'adj-001',
        measurementRevision: 1,
        rawApprovalToken: validToken,
        action: CustomerApprovalAction.APPROVED,
        authenticatedActor: mockActor,
      };

      await expect(service.processCustomerApproval(input)).rejects.toThrow(
        CustomerApprovalMismatchError,
      );
    });

    it('TC-WP3.4-APP-17: rolls back entire transaction if approval recording fails downstream', async () => {
      consentRepoMock.recordCustomerApproval.mockRejectedValueOnce(
        new Error('Database write failure during recordCustomerApproval'),
      );

      const input: ProcessCustomerApprovalInput = {
        weightAdjustmentId: 'adj-001',
        measurementRevision: 1,
        rawApprovalToken: validToken,
        action: CustomerApprovalAction.APPROVED,
        authenticatedActor: mockActor,
      };

      await expect(service.processCustomerApproval(input)).rejects.toThrow(
        'Database write failure during recordCustomerApproval',
      );

      // In real Prisma transaction, consumeChallenge rolls back because they share the same transaction
      expect(challengeRepoMock.consumeChallenge).toHaveBeenCalled();
      expect(consentRepoMock.recordCustomerApproval).toHaveBeenCalled();
    });

    it('TC-WP3.4-APP-18: preserves caller-supplied Prisma transaction when provided', async () => {
      const externalTxMock: any = { ...prismaMock };

      const input: ProcessCustomerApprovalInput = {
        weightAdjustmentId: 'adj-001',
        measurementRevision: 1,
        rawApprovalToken: validToken,
        action: CustomerApprovalAction.APPROVED,
        authenticatedActor: mockActor,
      };

      await service.processCustomerApproval(input, externalTxMock);

      expect(prismaMock.$transaction).not.toHaveBeenCalled();
      expect(challengeRepoMock.consumeChallenge).toHaveBeenCalledWith(
        expect.anything(),
        externalTxMock,
      );
      expect(consentRepoMock.recordCustomerApproval).toHaveBeenCalledWith(
        expect.anything(),
        externalTxMock,
      );
    });
  });
});
