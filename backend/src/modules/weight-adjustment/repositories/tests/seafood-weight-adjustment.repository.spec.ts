import Decimal from 'decimal.js';
import {
  CustomerApprovalAction,
  CustomerWeightApprovalStatus,
  ObligationStatus,
  PaymentObligationDirection,
  Prisma,
  SeafoodPricingBasis,
  SettlementChannel,
  UsablePartsFulfillmentOutcome,
  WeightUnit,
} from '@prisma/client';

import { PrismaService } from '../../../../database/prisma.service';
import { SeafoodOrderWeightAdjustmentRepository } from '../seafood-order-weight-adjustment.repository';
import { SeafoodWeightMeasurementEventRepository } from '../seafood-weight-measurement-event.repository';
import { SeafoodPreparationFulfillmentEventRepository } from '../seafood-preparation-fulfillment-event.repository';
import { CustomerWeightConsentRepository } from '../customer-weight-consent.repository';
import { WeightFinancialObligationRepository } from '../weight-financial-obligation.repository';
import {
  CustomerApprovalRevisionMismatchError,
  IdempotencyPayloadConflictError,
  ImmutableAuditMutationError,
  InvalidSettlementAmountError,
  InvalidSettlementChannelError,
  ObligationAlreadySettledError,
  SettlementAmountExceedsObligationError,
  SettlementChannelDirectionMismatchError,
  StaleRevisionConflictError,
} from '../errors/weight-adjustment-repository.errors';
import {
  FinancialEvidenceClassification,
  PERMITTED_SETTLEMENT_CHANNELS_BY_DIRECTION,
  classifySettlementEvidence,
} from '../weight-financial-obligation.repository';
import { computeCanonicalPayloadHash, hashApprovalToken } from '../utils/canonical-hash.util';

describe('Phase 16D WP2: Weight Adjustment Repositories (Unit & Concurrency Guard Tests)', () => {
  let prismaMock: any;
  let adjustmentRepo: SeafoodOrderWeightAdjustmentRepository;
  let measurementRepo: SeafoodWeightMeasurementEventRepository;
  let prepRepo: SeafoodPreparationFulfillmentEventRepository;
  let consentRepo: CustomerWeightConsentRepository;
  let obligationRepo: WeightFinancialObligationRepository;

  beforeEach(() => {
    prismaMock = {
      $transaction: jest.fn(async (cb) => cb(prismaMock)),
      $queryRaw: jest.fn().mockResolvedValue([]),
      seafoodOrderWeightAdjustment: {
        create: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
      },
      seafoodWeightMeasurementEvent: {
        create: jest.fn(),
        findUnique: jest.fn(),
        findMany: jest.fn(),
      },
      seafoodPreparationFulfillmentEvent: {
        create: jest.fn(),
        findUnique: jest.fn(),
        findMany: jest.fn(),
      },
      customerCheckoutCeilingConsent: {
        create: jest.fn(),
        findUnique: jest.fn(),
      },
      customerWeightApprovalRecord: {
        create: jest.fn(),
        findUnique: jest.fn(),
      },
      weightAdjustmentObligation: {
        create: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
        findMany: jest.fn(),
      },
      weightAdjustmentSettlementRecord: {
        create: jest.fn(),
        findUnique: jest.fn(),
        findMany: jest.fn(),
      },
    };

    adjustmentRepo = new SeafoodOrderWeightAdjustmentRepository(prismaMock as unknown as PrismaService);
    measurementRepo = new SeafoodWeightMeasurementEventRepository(prismaMock as unknown as PrismaService);
    prepRepo = new SeafoodPreparationFulfillmentEventRepository(prismaMock as unknown as PrismaService);
    consentRepo = new CustomerWeightConsentRepository(prismaMock as unknown as PrismaService);
    obligationRepo = new WeightFinancialObligationRepository(prismaMock as unknown as PrismaService);
  });

  describe('1. Append-Only Measurement Events, Revision Fencing & Atomic Persistence', () => {
    it('appends a new measurement event and atomically advances activeMeasurementRevision via CAS', async () => {
      prismaMock.seafoodWeightMeasurementEvent.findUnique.mockResolvedValue(null);
      prismaMock.seafoodOrderWeightAdjustment.findUnique.mockResolvedValue({
        id: 'adj-1',
        activeMeasurementRevision: 0,
      });
      prismaMock.seafoodWeightMeasurementEvent.create.mockResolvedValue({
        id: 'event-1',
        weightAdjustmentId: 'adj-1',
        revision: 1,
        measuredWeight: new Decimal(5.25),
      });
      prismaMock.seafoodOrderWeightAdjustment.updateMany.mockResolvedValue({ count: 1 });

      const result = await measurementRepo.appendMeasurementEvent({
        weightAdjustmentId: 'adj-1',
        expectedRevision: 1,
        idempotencyKey: 'idem-1',
        pricingBasis: SeafoodPricingBasis.WHOLE_RAW,
        unit: WeightUnit.POUNDS,
        measuredWeight: '5.250',
        scalePhotoUrl: 'https://photos.example.com/scale1.jpg',
        operatorUserId: 'user-fishmonger-1',
      });

      expect(result.isReplay).toBe(false);
      expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
      expect(prismaMock.seafoodWeightMeasurementEvent.create).toHaveBeenCalledTimes(1);
      expect(prismaMock.seafoodOrderWeightAdjustment.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'adj-1', activeMeasurementRevision: 0 },
          data: expect.objectContaining({ activeMeasurementRevision: 1 }),
        }),
      );
    });

    it('rejects stale revisions and prohibits silent re-sequencing (TC-CONC-03)', async () => {
      prismaMock.seafoodWeightMeasurementEvent.findUnique.mockResolvedValue(null);
      prismaMock.seafoodOrderWeightAdjustment.findUnique.mockResolvedValue({
        id: 'adj-1',
        activeMeasurementRevision: 1, // Current revision is already 1
      });

      await expect(
        measurementRepo.appendMeasurementEvent({
          weightAdjustmentId: 'adj-1',
          expectedRevision: 1,
          idempotencyKey: 'idem-stale',
          pricingBasis: SeafoodPricingBasis.WHOLE_RAW,
          unit: WeightUnit.POUNDS,
          measuredWeight: '5.400',
          scalePhotoUrl: 'https://photos.example.com/scale2.jpg',
          operatorUserId: 'user-fishmonger-2',
        }),
      ).rejects.toThrow(StaleRevisionConflictError);

      expect(prismaMock.seafoodWeightMeasurementEvent.create).not.toHaveBeenCalled();
    });

    it('aborts transaction if atomic compare-and-swap detects concurrent modification during updateMany', async () => {
      prismaMock.seafoodWeightMeasurementEvent.findUnique.mockResolvedValue(null);
      prismaMock.seafoodOrderWeightAdjustment.findUnique.mockResolvedValue({
        id: 'adj-1',
        activeMeasurementRevision: 0,
      });
      prismaMock.seafoodWeightMeasurementEvent.create.mockResolvedValue({ id: 'event-1' });
      // updateMany returns count: 0 (another concurrent transaction committed revision 1 between find and update)
      prismaMock.seafoodOrderWeightAdjustment.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        measurementRepo.appendMeasurementEvent({
          weightAdjustmentId: 'adj-1',
          expectedRevision: 1,
          idempotencyKey: 'idem-cas-fail',
          pricingBasis: SeafoodPricingBasis.WHOLE_RAW,
          unit: WeightUnit.POUNDS,
          measuredWeight: '5.250',
          scalePhotoUrl: 'https://photos.example.com/scale1.jpg',
          operatorUserId: 'user-fishmonger-1',
        }),
      ).rejects.toThrow(StaleRevisionConflictError);
    });

    it('replays existing measurement event if idempotency key and payload hash match', async () => {
      const payload = {
        weightAdjustmentId: 'adj-1',
        expectedRevision: 1,
        pricingBasis: SeafoodPricingBasis.WHOLE_RAW,
        unit: WeightUnit.POUNDS,
        measuredWeight: '5.250',
        scalePhotoUrl: 'https://photos.example.com/scale1.jpg',
        scaleDeviceIdentifier: null,
        scaleCalibrationDate: null,
        operatorUserId: 'user-fishmonger-1',
        correctionReason: null,
      };
      const hash = computeCanonicalPayloadHash(payload);

      prismaMock.seafoodWeightMeasurementEvent.findUnique.mockResolvedValue({
        id: 'event-1',
        payloadHash: hash,
        idempotencyKey: 'idem-1',
      });

      const result = await measurementRepo.appendMeasurementEvent({
        weightAdjustmentId: 'adj-1',
        expectedRevision: 1,
        idempotencyKey: 'idem-1',
        pricingBasis: SeafoodPricingBasis.WHOLE_RAW,
        unit: WeightUnit.POUNDS,
        measuredWeight: '5.250',
        scalePhotoUrl: 'https://photos.example.com/scale1.jpg',
        operatorUserId: 'user-fishmonger-1',
      });

      expect(result.isReplay).toBe(true);
      expect(prismaMock.seafoodWeightMeasurementEvent.create).not.toHaveBeenCalled();
    });

    it('recovers from concurrent P2002 idempotency collision and returns existing event if payload matches', async () => {
      const payload = {
        weightAdjustmentId: 'adj-1',
        expectedRevision: 1,
        pricingBasis: SeafoodPricingBasis.WHOLE_RAW,
        unit: WeightUnit.POUNDS,
        measuredWeight: '5.250',
        scalePhotoUrl: 'https://photos.example.com/scale1.jpg',
        scaleDeviceIdentifier: null,
        scaleCalibrationDate: null,
        operatorUserId: 'user-fishmonger-1',
        correctionReason: null,
      };
      const hash = computeCanonicalPayloadHash(payload);

      // Preliminary and in-tx findUnique miss (simulating race)
      prismaMock.seafoodWeightMeasurementEvent.findUnique
        .mockResolvedValueOnce(null) // Step 2 preliminary check
        .mockResolvedValueOnce(null) // In-tx check
        .mockResolvedValueOnce({ id: 'committed-event-1', payloadHash: hash }); // Post-crash recovery query

      prismaMock.seafoodOrderWeightAdjustment.findUnique.mockResolvedValue({
        id: 'adj-1',
        activeMeasurementRevision: 0,
      });

      // create() fails with Prisma P2002
      const p2002Error = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: '6.19.3',
      });
      prismaMock.seafoodWeightMeasurementEvent.create.mockRejectedValue(p2002Error);

      const result = await measurementRepo.appendMeasurementEvent({
        weightAdjustmentId: 'adj-1',
        expectedRevision: 1,
        idempotencyKey: 'idem-race-1',
        pricingBasis: SeafoodPricingBasis.WHOLE_RAW,
        unit: WeightUnit.POUNDS,
        measuredWeight: '5.250',
        scalePhotoUrl: 'https://photos.example.com/scale1.jpg',
        operatorUserId: 'user-fishmonger-1',
      });

      expect(result.isReplay).toBe(true);
      expect(result.event.id).toBe('committed-event-1');
    });

    it('throws IdempotencyPayloadConflictError when concurrent P2002 collision has conflicting payload', async () => {
      // Preliminary and in-tx findUnique miss
      prismaMock.seafoodWeightMeasurementEvent.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ id: 'committed-event-1', payloadHash: 'completely-different-hash' });

      prismaMock.seafoodOrderWeightAdjustment.findUnique.mockResolvedValue({
        id: 'adj-1',
        activeMeasurementRevision: 0,
      });

      const p2002Error = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: '6.19.3',
      });
      prismaMock.seafoodWeightMeasurementEvent.create.mockRejectedValue(p2002Error);

      await expect(
        measurementRepo.appendMeasurementEvent({
          weightAdjustmentId: 'adj-1',
          expectedRevision: 1,
          idempotencyKey: 'idem-race-conflict',
          pricingBasis: SeafoodPricingBasis.WHOLE_RAW,
          unit: WeightUnit.POUNDS,
          measuredWeight: '5.250',
          scalePhotoUrl: 'https://photos.example.com/scale1.jpg',
          operatorUserId: 'user-fishmonger-1',
        }),
      ).rejects.toThrow(IdempotencyPayloadConflictError);
    });

    it('propagates P2002 error under an externally supplied transaction without returning fallback success', async () => {
      const txMock: any = {
        seafoodWeightMeasurementEvent: {
          findUnique: jest.fn().mockResolvedValue(null),
          create: jest.fn().mockRejectedValue(
            new Prisma.PrismaClientKnownRequestError('Unique constraint failed on idempotencyKey', {
              code: 'P2002',
              clientVersion: '6.19.3',
            }),
          ),
        },
        seafoodOrderWeightAdjustment: {
          findUnique: jest.fn().mockResolvedValue({ id: 'adj-1', activeMeasurementRevision: 0 }),
          updateMany: jest.fn(),
        },
      };

      await expect(
        measurementRepo.appendMeasurementEvent(
          {
            weightAdjustmentId: 'adj-1',
            expectedRevision: 1,
            idempotencyKey: 'idem-external-race',
            pricingBasis: SeafoodPricingBasis.WHOLE_RAW,
            unit: WeightUnit.POUNDS,
            measuredWeight: '5.250',
            scalePhotoUrl: 'https://photos.example.com/scale1.jpg',
            operatorUserId: 'user-fishmonger-1',
          },
          txMock,
        ),
      ).rejects.toThrow(Prisma.PrismaClientKnownRequestError);

      // Verify that this.prisma was NOT queried for a fallback success on the aborted transaction
      expect(prismaMock.seafoodWeightMeasurementEvent.findUnique).not.toHaveBeenCalled();
      expect(txMock.seafoodOrderWeightAdjustment.updateMany).not.toHaveBeenCalled();
    });

    it('returns verified replay under external transaction when idempotency key exists without causing P2002', async () => {
      const payload = {
        weightAdjustmentId: 'adj-1',
        expectedRevision: 1,
        pricingBasis: SeafoodPricingBasis.WHOLE_RAW,
        unit: WeightUnit.POUNDS,
        measuredWeight: '5.250',
        scalePhotoUrl: 'https://photos.example.com/scale1.jpg',
        scaleDeviceIdentifier: null,
        scaleCalibrationDate: null,
        operatorUserId: 'user-fishmonger-1',
        correctionReason: null,
      };
      const hash = computeCanonicalPayloadHash(payload);

      const txMock: any = {
        seafoodWeightMeasurementEvent: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'event-existing-in-tx',
            payloadHash: hash,
            idempotencyKey: 'idem-existing-in-tx',
          }),
          create: jest.fn(),
        },
        seafoodOrderWeightAdjustment: {
          findUnique: jest.fn(),
          updateMany: jest.fn(),
        },
      };

      const result = await measurementRepo.appendMeasurementEvent(
        {
          weightAdjustmentId: 'adj-1',
          expectedRevision: 1,
          idempotencyKey: 'idem-existing-in-tx',
          pricingBasis: SeafoodPricingBasis.WHOLE_RAW,
          unit: WeightUnit.POUNDS,
          measuredWeight: '5.250',
          scalePhotoUrl: 'https://photos.example.com/scale1.jpg',
          operatorUserId: 'user-fishmonger-1',
        },
        txMock,
      );

      expect(result.isReplay).toBe(true);
      expect(result.event.id).toBe('event-existing-in-tx');
      expect(txMock.seafoodWeightMeasurementEvent.create).not.toHaveBeenCalled();
      expect(txMock.seafoodOrderWeightAdjustment.updateMany).not.toHaveBeenCalled();
    });

    it('propagates unrelated Prisma and database errors unchanged without swallowing', async () => {
      const txMock: any = {
        seafoodWeightMeasurementEvent: {
          findUnique: jest.fn().mockRejectedValue(new Error('Connection terminated unexpectedly')),
        },
      };

      await expect(
        measurementRepo.appendMeasurementEvent(
          {
            weightAdjustmentId: 'adj-1',
            expectedRevision: 1,
            idempotencyKey: 'idem-db-err',
            pricingBasis: SeafoodPricingBasis.WHOLE_RAW,
            unit: WeightUnit.POUNDS,
            measuredWeight: '5.250',
            scalePhotoUrl: 'https://photos.example.com/scale1.jpg',
            operatorUserId: 'user-fishmonger-1',
          },
          txMock,
        ),
      ).rejects.toThrow('Connection terminated unexpectedly');
    });

    it('prohibits update and delete methods on measurement audit repository', () => {
      expect(() => measurementRepo.update()).toThrow(ImmutableAuditMutationError);
      expect(() => measurementRepo.delete()).toThrow(ImmutableAuditMutationError);
    });
  });

  describe('2. Preparation & Usable-Parts Fulfillment Events', () => {
    it('appends usable parts outcome and updates parent projection without blocking fulfillment', async () => {
      prismaMock.seafoodPreparationFulfillmentEvent.findUnique.mockResolvedValue(null);
      prismaMock.seafoodOrderWeightAdjustment.findUnique.mockResolvedValue({
        id: 'adj-1',
        activePreparationRevision: 0,
      });
      prismaMock.seafoodPreparationFulfillmentEvent.create.mockResolvedValue({
        id: 'prep-1',
        partsOutcome: UsablePartsFulfillmentOutcome.PARTIALLY_RETURNED,
      });
      prismaMock.seafoodOrderWeightAdjustment.updateMany.mockResolvedValue({ count: 1 });

      const result = await prepRepo.appendPreparationEvent({
        weightAdjustmentId: 'adj-1',
        expectedRevision: 1,
        idempotencyKey: 'prep-idem-1',
        preparedNetWeight: '3.400',
        partsOutcome: UsablePartsFulfillmentOutcome.PARTIALLY_RETURNED,
        partsDisposalReason: 'Bruised vertebrae safely discarded',
        operatorUserId: 'user-fishmonger-1',
      });

      expect(result.isReplay).toBe(false);
      expect(prismaMock.seafoodOrderWeightAdjustment.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'adj-1', activePreparationRevision: 0 },
          data: expect.objectContaining({
            activePreparationRevision: 1,
            usablePartsOutcome: UsablePartsFulfillmentOutcome.PARTIALLY_RETURNED,
          }),
        }),
      );
    });

    it('propagates P2002 error under an externally supplied transaction without returning fallback success', async () => {
      const txMock: any = {
        seafoodPreparationFulfillmentEvent: {
          findUnique: jest.fn().mockResolvedValue(null),
          create: jest.fn().mockRejectedValue(
            new Prisma.PrismaClientKnownRequestError('Unique constraint failed on idempotencyKey', {
              code: 'P2002',
              clientVersion: '6.19.3',
            }),
          ),
        },
        seafoodOrderWeightAdjustment: {
          findUnique: jest.fn().mockResolvedValue({ id: 'adj-1', activePreparationRevision: 0 }),
          updateMany: jest.fn(),
        },
      };

      await expect(
        prepRepo.appendPreparationEvent(
          {
            weightAdjustmentId: 'adj-1',
            expectedRevision: 1,
            idempotencyKey: 'prep-external-race',
            partsOutcome: UsablePartsFulfillmentOutcome.RETURNED_AVAILABLE_PARTS,
            operatorUserId: 'user-fishmonger-1',
          },
          txMock,
        ),
      ).rejects.toThrow(Prisma.PrismaClientKnownRequestError);

      expect(prismaMock.seafoodPreparationFulfillmentEvent.findUnique).not.toHaveBeenCalled();
      expect(txMock.seafoodOrderWeightAdjustment.updateMany).not.toHaveBeenCalled();
    });

    it('returns verified replay under external transaction when idempotency key exists without causing P2002', async () => {
      const payload = {
        weightAdjustmentId: 'adj-1',
        expectedRevision: 1,
        preparedNetWeight: null,
        partsOutcome: UsablePartsFulfillmentOutcome.RETURNED_AVAILABLE_PARTS,
        partsDisposalReason: null,
        preparedPhotoUrl: null,
        operatorUserId: 'user-fishmonger-1',
        correctionReason: null,
      };
      const hash = computeCanonicalPayloadHash(payload);

      const txMock: any = {
        seafoodPreparationFulfillmentEvent: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'prep-existing-in-tx',
            payloadHash: hash,
            idempotencyKey: 'prep-existing-in-tx',
          }),
          create: jest.fn(),
        },
        seafoodOrderWeightAdjustment: {
          findUnique: jest.fn(),
          updateMany: jest.fn(),
        },
      };

      const result = await prepRepo.appendPreparationEvent(
        {
          weightAdjustmentId: 'adj-1',
          expectedRevision: 1,
          idempotencyKey: 'prep-existing-in-tx',
          partsOutcome: UsablePartsFulfillmentOutcome.RETURNED_AVAILABLE_PARTS,
          operatorUserId: 'user-fishmonger-1',
        },
        txMock,
      );

      expect(result.isReplay).toBe(true);
      expect(result.event.id).toBe('prep-existing-in-tx');
      expect(txMock.seafoodPreparationFulfillmentEvent.create).not.toHaveBeenCalled();
      expect(txMock.seafoodOrderWeightAdjustment.updateMany).not.toHaveBeenCalled();
    });

    it('prohibits update and delete methods on preparation audit repository', () => {
      expect(() => prepRepo.update()).toThrow(ImmutableAuditMutationError);
      expect(() => prepRepo.delete()).toThrow(ImmutableAuditMutationError);
    });
  });

  describe('3. Customer Consent & Approval Binding', () => {
    it('records checkout ceiling consent bound to authenticated customer', async () => {
      prismaMock.customerCheckoutCeilingConsent.create.mockResolvedValue({
        id: 'consent-1',
        authenticatedCustomerId: 'cust-1',
        authorizedCeilingJmd: new Decimal(4800.0),
      });

      const consent = await consentRepo.recordCheckoutCeilingConsent({
        weightAdjustmentId: 'adj-1',
        authenticatedCustomerId: 'cust-1',
        initialEstimatedWeight: '5.000',
        initialEstimatedTotal: '4550.00',
        authorizedCeilingJmd: '4800.00',
        termsVersion: 'v1.0-2026',
        ipAddress: '192.168.1.1',
      });

      expect(consent).toBeDefined();
      expect(prismaMock.customerCheckoutCeilingConsent.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            authenticatedCustomerId: 'cust-1',
            termsVersion: 'v1.0-2026',
            payloadHash: expect.any(String),
          }),
        }),
      );
    });

    it('hashes approval tokens and rejects approval if revision does not match active measurement', async () => {
      prismaMock.seafoodOrderWeightAdjustment.findUnique.mockResolvedValue({
        id: 'adj-1',
        activeMeasurementRevision: 2,
      });

      await expect(
        consentRepo.recordCustomerApproval({
          weightAdjustmentId: 'adj-1',
          measurementRevision: 1,
          authenticatedCustomerId: 'cust-1',
          proposedTotalJmd: '5100.00',
          authorizedCeilingJmd: '4800.00',
          action: CustomerApprovalAction.APPROVED,
          rawApprovalToken: 'secret-token-xyz-12345',
        }),
      ).rejects.toThrow(CustomerApprovalRevisionMismatchError);

      expect(prismaMock.customerWeightApprovalRecord.create).not.toHaveBeenCalled();
    });

    it('records approved decision with hashed token and binds parent approval status', async () => {
      prismaMock.seafoodOrderWeightAdjustment.findUnique.mockResolvedValue({
        id: 'adj-1',
        activeMeasurementRevision: 1,
      });
      prismaMock.customerWeightApprovalRecord.create.mockResolvedValue({
        id: 'approval-1',
        action: CustomerApprovalAction.APPROVED,
      });

      const rawToken = 'secret-one-time-token-abc';
      const expectedHash = hashApprovalToken(rawToken);

      await consentRepo.recordCustomerApproval({
        weightAdjustmentId: 'adj-1',
        measurementRevision: 1,
        authenticatedCustomerId: 'cust-1',
        proposedTotalJmd: '5100.00',
        authorizedCeilingJmd: '4800.00',
        action: CustomerApprovalAction.APPROVED,
        rawApprovalToken: rawToken,
      });

      expect(prismaMock.customerWeightApprovalRecord.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            approvalTokenHash: expectedHash,
            measurementRevision: 1,
            action: CustomerApprovalAction.APPROVED,
          }),
        }),
      );
      expect(JSON.stringify(prismaMock.customerWeightApprovalRecord.create.mock.calls[0])).not.toContain(rawToken);

      expect(prismaMock.seafoodOrderWeightAdjustment.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            customerApprovalStatus: CustomerWeightApprovalStatus.APPROVED_BY_CUSTOMER,
            boundApprovalRevision: 1,
          }),
        }),
      );
    });
  });

  describe('4. Financial Obligations & Settlement Evidence (Unit & Mocked Concurrency Tests)', () => {
    it('records obligation as PENDING and validates permitted settlement channels', async () => {
      prismaMock.weightAdjustmentObligation.findUnique.mockResolvedValue(null);
      prismaMock.weightAdjustmentObligation.create.mockResolvedValue({
        id: 'ob-1',
        status: ObligationStatus.PENDING,
      });

      const result = await obligationRepo.recordObligation({
        weightAdjustmentId: 'adj-1',
        revision: 1,
        idempotencyKey: 'ob-idem-1',
        direction: PaymentObligationDirection.SUPPLEMENTAL_PAYMENT_DUE,
        amountJmd: '220.00',
      });

      expect(result.obligation.status).toBe(ObligationStatus.PENDING);

      await expect(
        obligationRepo.recordSettlementEvidence({
          obligationId: 'ob-1',
          idempotencyKey: 'settle-idem-1',
          settlementChannel: 'UNAPPROVED_WALLET' as any,
          amountSettled: '220.00',
          settledByUserId: 'admin-1',
        }),
      ).rejects.toThrow(InvalidSettlementChannelError);
    });

    // 1. Partial settlement
    it('TC-SETTLE-01: records a valid partial settlement, keeping obligation status PENDING and balance accurate', async () => {
      prismaMock.weightAdjustmentSettlementRecord.findUnique.mockResolvedValue(null);
      prismaMock.weightAdjustmentObligation.findUnique.mockResolvedValue({
        id: 'ob-partial-1',
        direction: PaymentObligationDirection.SUPPLEMENTAL_PAYMENT_DUE,
        amountJmd: new Prisma.Decimal('500.00'),
        status: ObligationStatus.PENDING,
        settlementRecords: [],
      });
      prismaMock.weightAdjustmentSettlementRecord.create.mockResolvedValue({
        id: 'settle-part-1',
        obligationId: 'ob-partial-1',
        amountSettled: new Prisma.Decimal('200.00'),
        settlementChannel: SettlementChannel.COD_DOORSTEP_RECEIPT,
      });

      const result = await obligationRepo.recordSettlementEvidence({
        obligationId: 'ob-partial-1',
        idempotencyKey: 'idem-partial-1',
        settlementChannel: SettlementChannel.COD_DOORSTEP_RECEIPT,
        amountSettled: '200.00',
        settledByUserId: 'driver-1',
      });

      expect(result.isReplay).toBe(false);
      expect(prismaMock.weightAdjustmentSettlementRecord.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            obligationId: 'ob-partial-1',
            amountSettled: new Prisma.Decimal('200.00'),
            settlementChannel: SettlementChannel.COD_DOORSTEP_RECEIPT,
          }),
        }),
      );
      // Obligation status must NOT transition to SETTLED because 200.00 < 500.00
      expect(prismaMock.weightAdjustmentObligation.update).not.toHaveBeenCalled();
    });

    // 2. Exact full settlement
    it('TC-SETTLE-02: transitions obligation to SETTLED upon exact cumulative full settlement', async () => {
      prismaMock.weightAdjustmentSettlementRecord.findUnique.mockResolvedValue(null);
      // Obligation of 500.00 with existing 200.00 settlement
      prismaMock.weightAdjustmentObligation.findUnique.mockResolvedValue({
        id: 'ob-full-1',
        direction: PaymentObligationDirection.SUPPLEMENTAL_PAYMENT_DUE,
        amountJmd: new Prisma.Decimal('500.00'),
        status: ObligationStatus.PENDING,
        settlementRecords: [{ amountSettled: new Prisma.Decimal('200.00') }],
      });
      prismaMock.weightAdjustmentSettlementRecord.create.mockResolvedValue({
        id: 'settle-full-2',
        obligationId: 'ob-full-1',
        amountSettled: new Prisma.Decimal('300.00'),
        settlementChannel: SettlementChannel.WIPAY_SECONDARY_PAYMENT_CONFIRMED,
      });

      const result = await obligationRepo.recordSettlementEvidence({
        obligationId: 'ob-full-1',
        idempotencyKey: 'idem-full-2',
        settlementChannel: SettlementChannel.WIPAY_SECONDARY_PAYMENT_CONFIRMED,
        amountSettled: '300.00',
        externalReference: 'WIPAY-TXN-88491',
        settledByUserId: 'driver-1',
      });

      expect(result.isReplay).toBe(false);
      expect(prismaMock.weightAdjustmentSettlementRecord.create).toHaveBeenCalledTimes(1);
      // 200 + 300 == 500, status must transition to SETTLED
      expect(prismaMock.weightAdjustmentObligation.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'ob-full-1' },
          data: { status: ObligationStatus.SETTLED },
        }),
      );
    });

    // 3. Excessive settlement rejection
    it('TC-SETTLE-03: rejects settlement amounts exceeding remaining balance', async () => {
      prismaMock.weightAdjustmentSettlementRecord.findUnique.mockResolvedValue(null);
      // Obligation of 500.00 with existing 400.00 settlement (remaining 100.00)
      prismaMock.weightAdjustmentObligation.findUnique.mockResolvedValue({
        id: 'ob-excess-1',
        direction: PaymentObligationDirection.SUPPLEMENTAL_PAYMENT_DUE,
        amountJmd: new Prisma.Decimal('500.00'),
        status: ObligationStatus.PENDING,
        settlementRecords: [{ amountSettled: new Prisma.Decimal('400.00') }],
      });

      await expect(
        obligationRepo.recordSettlementEvidence({
          obligationId: 'ob-excess-1',
          idempotencyKey: 'idem-excess-1',
          settlementChannel: SettlementChannel.COD_DOORSTEP_RECEIPT,
          amountSettled: '150.00', // 150 > remaining 100
          settledByUserId: 'driver-1',
        }),
      ).rejects.toThrow(SettlementAmountExceedsObligationError);

      expect(prismaMock.weightAdjustmentSettlementRecord.create).not.toHaveBeenCalled();
      expect(prismaMock.weightAdjustmentObligation.update).not.toHaveBeenCalled();
    });

    // 4. Zero and negative amount rejection
    it('TC-SETTLE-04: rejects zero, negative, or non-numeric settlement amounts', async () => {
      prismaMock.weightAdjustmentSettlementRecord.findUnique.mockResolvedValue(null);

      // Zero amount
      await expect(
        obligationRepo.recordSettlementEvidence({
          obligationId: 'ob-1',
          idempotencyKey: 'idem-zero',
          settlementChannel: SettlementChannel.COD_DOORSTEP_RECEIPT,
          amountSettled: '0.00',
          settledByUserId: 'driver-1',
        }),
      ).rejects.toThrow(InvalidSettlementAmountError);

      // Negative amount
      await expect(
        obligationRepo.recordSettlementEvidence({
          obligationId: 'ob-1',
          idempotencyKey: 'idem-neg',
          settlementChannel: SettlementChannel.COD_DOORSTEP_RECEIPT,
          amountSettled: '-50.00',
          settledByUserId: 'driver-1',
        }),
      ).rejects.toThrow(InvalidSettlementAmountError);

      // Non-numeric amount
      await expect(
        obligationRepo.recordSettlementEvidence({
          obligationId: 'ob-1',
          idempotencyKey: 'idem-invalid',
          settlementChannel: SettlementChannel.COD_DOORSTEP_RECEIPT,
          amountSettled: 'not-a-number',
          settledByUserId: 'driver-1',
        }),
      ).rejects.toThrow(InvalidSettlementAmountError);

      expect(prismaMock.weightAdjustmentSettlementRecord.create).not.toHaveBeenCalled();
      expect(prismaMock.weightAdjustmentObligation.update).not.toHaveBeenCalled();
    });

    // 5. Direction/channel incompatibility
    it('TC-SETTLE-05: enforces direction-specific settlement channels and rejects mismatches', async () => {
      prismaMock.weightAdjustmentSettlementRecord.findUnique.mockResolvedValue(null);

      // Case A: CREDIT_DUE_CUSTOMER rejects COD_DOORSTEP_RECEIPT
      prismaMock.weightAdjustmentObligation.findUnique.mockResolvedValueOnce({
        id: 'ob-cred-1',
        direction: PaymentObligationDirection.CREDIT_DUE_CUSTOMER,
        amountJmd: new Prisma.Decimal('100.00'),
        status: ObligationStatus.PENDING,
        settlementRecords: [],
      });
      await expect(
        obligationRepo.recordSettlementEvidence({
          obligationId: 'ob-cred-1',
          idempotencyKey: 'idem-mismatch-1',
          settlementChannel: SettlementChannel.COD_DOORSTEP_RECEIPT,
          amountSettled: '100.00',
          settledByUserId: 'driver-1',
        }),
      ).rejects.toThrow(SettlementChannelDirectionMismatchError);

      // Case B: CREDIT_DUE_CUSTOMER rejects WIPAY_SECONDARY_PAYMENT_CONFIRMED
      prismaMock.weightAdjustmentObligation.findUnique.mockResolvedValueOnce({
        id: 'ob-cred-2',
        direction: PaymentObligationDirection.CREDIT_DUE_CUSTOMER,
        amountJmd: new Prisma.Decimal('100.00'),
        status: ObligationStatus.PENDING,
        settlementRecords: [],
      });
      await expect(
        obligationRepo.recordSettlementEvidence({
          obligationId: 'ob-cred-2',
          idempotencyKey: 'idem-mismatch-2',
          settlementChannel: SettlementChannel.WIPAY_SECONDARY_PAYMENT_CONFIRMED,
          amountSettled: '100.00',
          settledByUserId: 'driver-1',
        }),
      ).rejects.toThrow(SettlementChannelDirectionMismatchError);

      // Case C: SUPPLEMENTAL_PAYMENT_DUE rejects ADMIN_CREDIT_MEMO_ISSUED
      prismaMock.weightAdjustmentObligation.findUnique.mockResolvedValueOnce({
        id: 'ob-supp-1',
        direction: PaymentObligationDirection.SUPPLEMENTAL_PAYMENT_DUE,
        amountJmd: new Prisma.Decimal('100.00'),
        status: ObligationStatus.PENDING,
        settlementRecords: [],
      });
      await expect(
        obligationRepo.recordSettlementEvidence({
          obligationId: 'ob-supp-1',
          idempotencyKey: 'idem-mismatch-3',
          settlementChannel: SettlementChannel.ADMIN_CREDIT_MEMO_ISSUED,
          amountSettled: '100.00',
          settledByUserId: 'admin-1',
        }),
      ).rejects.toThrow(SettlementChannelDirectionMismatchError);

      // Case D: NONE direction rejects all channels
      prismaMock.weightAdjustmentObligation.findUnique.mockResolvedValueOnce({
        id: 'ob-none-1',
        direction: PaymentObligationDirection.NONE,
        amountJmd: new Prisma.Decimal('0.00'),
        status: ObligationStatus.PENDING,
        settlementRecords: [],
      });
      await expect(
        obligationRepo.recordSettlementEvidence({
          obligationId: 'ob-none-1',
          idempotencyKey: 'idem-mismatch-4',
          settlementChannel: SettlementChannel.ADMIN_CREDIT_MEMO_ISSUED,
          amountSettled: '10.00',
          settledByUserId: 'admin-1',
        }),
      ).rejects.toThrow(SettlementChannelDirectionMismatchError);
    });

    // 6. Credit memo versus cash refund distinction
    it('TC-SETTLE-06: distinguishes credit memo from cash refund and settles CREDIT_DUE_CUSTOMER', async () => {
      // Classification semantics
      expect(obligationRepo.classifySettlementRecord(SettlementChannel.ADMIN_CREDIT_MEMO_ISSUED))
        .toBe(FinancialEvidenceClassification.CUSTOMER_CREDIT_MEMO);
      expect(obligationRepo.classifySettlementRecord(SettlementChannel.COD_DOORSTEP_RECEIPT))
        .toBe(FinancialEvidenceClassification.CUSTOMER_PAYMENT);

      prismaMock.weightAdjustmentSettlementRecord.findUnique.mockResolvedValue(null);
      prismaMock.weightAdjustmentObligation.findUnique.mockResolvedValue({
        id: 'ob-credit-memo',
        direction: PaymentObligationDirection.CREDIT_DUE_CUSTOMER,
        amountJmd: new Prisma.Decimal('275.50'),
        status: ObligationStatus.PENDING,
        settlementRecords: [],
      });
      prismaMock.weightAdjustmentSettlementRecord.create.mockResolvedValue({
        id: 'settle-cm-1',
        obligationId: 'ob-credit-memo',
        settlementChannel: SettlementChannel.ADMIN_CREDIT_MEMO_ISSUED,
        amountSettled: new Prisma.Decimal('275.50'),
      });

      const result = await obligationRepo.recordSettlementEvidence({
        obligationId: 'ob-credit-memo',
        idempotencyKey: 'idem-credit-memo-1',
        settlementChannel: SettlementChannel.ADMIN_CREDIT_MEMO_ISSUED,
        amountSettled: '275.50',
        externalReference: 'CREDIT-MEMO-2026-0042',
        settledByUserId: 'admin-1',
      });

      expect(result.isReplay).toBe(false);
      expect(prismaMock.weightAdjustmentSettlementRecord.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            settlementChannel: SettlementChannel.ADMIN_CREDIT_MEMO_ISSUED,
            amountSettled: new Prisma.Decimal('275.50'),
          }),
        }),
      );
      expect(prismaMock.weightAdjustmentObligation.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'ob-credit-memo' },
          data: { status: ObligationStatus.SETTLED },
        }),
      );
    });

    // 7. Vendor absorption versus money received
    it('TC-SETTLE-07: vendor absorption discharges obligation as waiver without cash receipt', async () => {
      // Classification semantics
      expect(obligationRepo.classifySettlementRecord(SettlementChannel.VENDOR_ABSORPTION))
        .toBe(FinancialEvidenceClassification.VENDOR_ABSORPTION_WAIVER);

      prismaMock.weightAdjustmentSettlementRecord.findUnique.mockResolvedValue(null);
      prismaMock.weightAdjustmentObligation.findUnique.mockResolvedValue({
        id: 'ob-vendor-absorb',
        direction: PaymentObligationDirection.SUPPLEMENTAL_PAYMENT_DUE,
        amountJmd: new Prisma.Decimal('180.00'),
        status: ObligationStatus.PENDING,
        settlementRecords: [],
      });
      prismaMock.weightAdjustmentSettlementRecord.create.mockResolvedValue({
        id: 'settle-va-1',
        obligationId: 'ob-vendor-absorb',
        settlementChannel: SettlementChannel.VENDOR_ABSORPTION,
        amountSettled: new Prisma.Decimal('180.00'),
      });

      const result = await obligationRepo.recordSettlementEvidence({
        obligationId: 'ob-vendor-absorb',
        idempotencyKey: 'idem-va-1',
        settlementChannel: SettlementChannel.VENDOR_ABSORPTION,
        amountSettled: '180.00',
        externalReference: 'VENDOR-WAIVER-DISPATCH-991',
        settledByUserId: 'vendor-admin-1',
      });

      expect(result.isReplay).toBe(false);
      expect(prismaMock.weightAdjustmentSettlementRecord.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            settlementChannel: SettlementChannel.VENDOR_ABSORPTION,
            amountSettled: new Prisma.Decimal('180.00'),
          }),
        }),
      );
      expect(prismaMock.weightAdjustmentObligation.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'ob-vendor-absorb' },
          data: { status: ObligationStatus.SETTLED },
        }),
      );
    });

    // 8. Concurrent settlements (Mocked Concurrency & Row Locking)
    it('TC-SETTLE-08: concurrent settlement protection via row locking and rejection of already-settled obligation (Mocked Concurrency)', async () => {
      // Verifies row-level lock is acquired inside the transaction
      prismaMock.weightAdjustmentSettlementRecord.findUnique.mockResolvedValue(null);
      prismaMock.weightAdjustmentObligation.findUnique.mockResolvedValue({
        id: 'ob-lock-1',
        direction: PaymentObligationDirection.SUPPLEMENTAL_PAYMENT_DUE,
        amountJmd: new Prisma.Decimal('200.00'),
        status: ObligationStatus.PENDING,
        settlementRecords: [],
      });
      prismaMock.weightAdjustmentSettlementRecord.create.mockResolvedValue({
        id: 'settle-lock-1',
        obligationId: 'ob-lock-1',
        amountSettled: new Prisma.Decimal('200.00'),
        settlementChannel: SettlementChannel.COD_DOORSTEP_RECEIPT,
      });

      await obligationRepo.recordSettlementEvidence({
        obligationId: 'ob-lock-1',
        idempotencyKey: 'idem-lock-1',
        settlementChannel: SettlementChannel.COD_DOORSTEP_RECEIPT,
        amountSettled: '200.00',
        settledByUserId: 'driver-1',
      });

      // Verify row lock query was issued
      expect(prismaMock.$queryRaw).toHaveBeenCalled();

      // Now simulate a concurrent second transaction that arrives after the first marked it SETTLED
      prismaMock.weightAdjustmentObligation.findUnique.mockResolvedValueOnce({
        id: 'ob-lock-1',
        direction: PaymentObligationDirection.SUPPLEMENTAL_PAYMENT_DUE,
        amountJmd: new Prisma.Decimal('200.00'),
        status: ObligationStatus.SETTLED, // Already settled by transaction 1
        settlementRecords: [{ amountSettled: new Prisma.Decimal('200.00') }],
      });

      await expect(
        obligationRepo.recordSettlementEvidence({
          obligationId: 'ob-lock-1',
          idempotencyKey: 'idem-lock-2', // new key
          settlementChannel: SettlementChannel.COD_DOORSTEP_RECEIPT,
          amountSettled: '50.00',
          settledByUserId: 'driver-1',
        }),
      ).rejects.toThrow(ObligationAlreadySettledError);
    });

    // 9. Idempotent replay
    it('TC-SETTLE-09: identical idempotent replay returns existing record without balance change, even when SETTLED', async () => {
      const payloadHash = computeCanonicalPayloadHash({
        obligationId: 'ob-settled-1',
        settlementChannel: SettlementChannel.COD_DOORSTEP_RECEIPT,
        amountSettled: '300.00',
        externalReference: 'RECEIPT-001',
        settledByUserId: 'driver-1',
      });

      const existingRecord = {
        id: 'settle-rec-existing',
        obligationId: 'ob-settled-1',
        idempotencyKey: 'idem-settled-replay',
        payloadHash,
        settlementChannel: SettlementChannel.COD_DOORSTEP_RECEIPT,
        amountSettled: new Prisma.Decimal('300.00'),
      };

      // Existing record found by idempotency key
      prismaMock.weightAdjustmentSettlementRecord.findUnique.mockResolvedValue(existingRecord);

      const result = await obligationRepo.recordSettlementEvidence({
        obligationId: 'ob-settled-1',
        idempotencyKey: 'idem-settled-replay',
        settlementChannel: SettlementChannel.COD_DOORSTEP_RECEIPT,
        amountSettled: '300.00',
        externalReference: 'RECEIPT-001',
        settledByUserId: 'driver-1',
      });

      expect(result.isReplay).toBe(true);
      expect(result.settlement).toBe(existingRecord);
      expect(prismaMock.$transaction).not.toHaveBeenCalled();
      expect(prismaMock.weightAdjustmentSettlementRecord.create).not.toHaveBeenCalled();
      expect(prismaMock.weightAdjustmentObligation.update).not.toHaveBeenCalled();
    });

    // 10. Conflicting idempotency payloads
    it('TC-SETTLE-10: conflicting idempotency payloads on same key throw IdempotencyPayloadConflictError', async () => {
      const existingRecord = {
        id: 'settle-rec-existing',
        obligationId: 'ob-1',
        idempotencyKey: 'idem-conflict-key',
        payloadHash: 'hash-original-amount-100',
        settlementChannel: SettlementChannel.COD_DOORSTEP_RECEIPT,
        amountSettled: new Prisma.Decimal('100.00'),
      };

      prismaMock.weightAdjustmentSettlementRecord.findUnique.mockResolvedValue(existingRecord);

      // Same idempotencyKey, but different amount (200.00) produces different payloadHash
      await expect(
        obligationRepo.recordSettlementEvidence({
          obligationId: 'ob-1',
          idempotencyKey: 'idem-conflict-key',
          settlementChannel: SettlementChannel.COD_DOORSTEP_RECEIPT,
          amountSettled: '200.00',
          settledByUserId: 'driver-1',
        }),
      ).rejects.toThrow(IdempotencyPayloadConflictError);

      expect(prismaMock.weightAdjustmentSettlementRecord.create).not.toHaveBeenCalled();
      expect(prismaMock.weightAdjustmentObligation.update).not.toHaveBeenCalled();
    });

    // 11. Balance inquiry accuracy
    it('TC-SETTLE-11: getObligationBalance calculates accurate cumulative balance and discharge status', async () => {
      prismaMock.weightAdjustmentObligation.findUnique.mockResolvedValue({
        id: 'ob-bal-1',
        amountJmd: new Prisma.Decimal('600.00'),
        status: ObligationStatus.PENDING,
        settlementRecords: [
          { amountSettled: new Prisma.Decimal('150.00') },
          { amountSettled: new Prisma.Decimal('200.00') },
        ],
      });

      const balance = await obligationRepo.getObligationBalance('ob-bal-1');

      expect(balance.totalAmountJmd).toBe('600.00');
      expect(balance.totalSettledJmd).toBe('350.00');
      expect(balance.remainingBalanceJmd).toBe('250.00');
      expect(balance.isFullySettled).toBe(false);
      expect(balance.status).toBe(ObligationStatus.PENDING);
    });
  });
});
