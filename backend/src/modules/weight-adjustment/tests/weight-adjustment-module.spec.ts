import { readFileSync } from 'fs';
import { resolve } from 'path';
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaModule } from '../../../database/prisma.module';
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

describe('WeightAdjustmentModule - Dependency Injection & Operational Dormancy', () => {
  let moduleRef: TestingModule;
  let prismaMock: any;

  beforeAll(async () => {
    prismaMock = {
      $transaction: jest.fn(),
      seafoodOrderWeightAdjustment: { findUnique: jest.fn(), create: jest.fn() },
      seafoodWeightMeasurementEvent: { findUnique: jest.fn(), create: jest.fn() },
      seafoodPreparationFulfillmentEvent: { findUnique: jest.fn(), create: jest.fn() },
      customerWeightApprovalChallenge: { findUnique: jest.fn(), create: jest.fn() },
      customerWeightConsent: { findUnique: jest.fn(), create: jest.fn() },
      weightAdjustmentObligation: { findUnique: jest.fn(), create: jest.fn() },
      weightAdjustmentSettlementRecord: { findUnique: jest.fn(), create: jest.fn() },
      seafoodLot: { findUnique: jest.fn() },
      user: { findUnique: jest.fn() },
    };

    moduleRef = await Test.createTestingModule({
      imports: [WeightAdjustmentModule],
    })
      .overrideProvider(PrismaService)
      .useValue(prismaMock)
      .compile();
  });

  describe('Module Configuration & Clean Boundaries', () => {
    it('TC-WP3.5-MOD-01: imports only PrismaModule infrastructure', () => {
      const imports = Reflect.getMetadata('imports', WeightAdjustmentModule) ?? [];
      expect(imports).toEqual([PrismaModule]);
    });

    it('TC-WP3.5-MOD-02: has zero controllers registered (no public HTTP endpoints)', () => {
      const controllers = Reflect.getMetadata('controllers', WeightAdjustmentModule) ?? [];
      expect(controllers).toEqual([]);
    });

    it('TC-WP3.5-MOD-03: exports strictly the six public domain orchestrator services', () => {
      const exports = Reflect.getMetadata('exports', WeightAdjustmentModule) ?? [];
      expect(exports).toHaveLength(6);

      // Exactly 6 Domain Orchestrators exported
      expect(exports).toContain(WeightAdjustmentSnapshotInitializationService);
      expect(exports).toContain(SeafoodWeightMeasurementService);
      expect(exports).toContain(SeafoodPreparationFulfillmentService);
      expect(exports).toContain(CustomerWeightApprovalCoordinationService);
      expect(exports).toContain(WeightAdjustmentSettlementService);
      expect(exports).toContain(WeightAdjustmentReleaseReadinessService);

      // Repositories must NOT be exported
      expect(exports).not.toContain(CustomerWeightApprovalChallengeRepository);
      expect(exports).not.toContain(CustomerWeightConsentRepository);
      expect(exports).not.toContain(SeafoodOrderWeightAdjustmentRepository);
      expect(exports).not.toContain(SeafoodPreparationFulfillmentEventRepository);
      expect(exports).not.toContain(SeafoodWeightMeasurementEventRepository);
      expect(exports).not.toContain(WeightFinancialObligationRepository);

      // Internal utility services must NOT be exported
      expect(exports).not.toContain(WeightAdjustmentSafetyGateService);
      expect(exports).not.toContain(WeightAdjustmentApprovalTokenService);
    });
  });

  describe('Dependency Injection Resolution', () => {
    it('TC-WP3.5-MOD-04: resolves all 6 repositories successfully without circular dependencies', () => {
      const challengeRepo = moduleRef.get(CustomerWeightApprovalChallengeRepository, { strict: false });
      const consentRepo = moduleRef.get(CustomerWeightConsentRepository, { strict: false });
      const adjustmentRepo = moduleRef.get(SeafoodOrderWeightAdjustmentRepository, { strict: false });
      const prepEventRepo = moduleRef.get(SeafoodPreparationFulfillmentEventRepository, { strict: false });
      const measureEventRepo = moduleRef.get(SeafoodWeightMeasurementEventRepository, { strict: false });
      const obligationRepo = moduleRef.get(WeightFinancialObligationRepository, { strict: false });

      expect(challengeRepo).toBeInstanceOf(CustomerWeightApprovalChallengeRepository);
      expect(consentRepo).toBeInstanceOf(CustomerWeightConsentRepository);
      expect(adjustmentRepo).toBeInstanceOf(SeafoodOrderWeightAdjustmentRepository);
      expect(prepEventRepo).toBeInstanceOf(SeafoodPreparationFulfillmentEventRepository);
      expect(measureEventRepo).toBeInstanceOf(SeafoodWeightMeasurementEventRepository);
      expect(obligationRepo).toBeInstanceOf(WeightFinancialObligationRepository);
    });

    it('TC-WP3.5-MOD-05: resolves all 8 services successfully with proper dependency wiring', () => {
      const safetyGate = moduleRef.get(WeightAdjustmentSafetyGateService, { strict: false });
      const tokenService = moduleRef.get(WeightAdjustmentApprovalTokenService, { strict: false });
      const snapshotInit = moduleRef.get(WeightAdjustmentSnapshotInitializationService);
      const measurement = moduleRef.get(SeafoodWeightMeasurementService);
      const prepService = moduleRef.get(SeafoodPreparationFulfillmentService);
      const approvalCoord = moduleRef.get(CustomerWeightApprovalCoordinationService);
      const settlement = moduleRef.get(WeightAdjustmentSettlementService);
      const releaseReadiness = moduleRef.get(WeightAdjustmentReleaseReadinessService);

      expect(safetyGate).toBeInstanceOf(WeightAdjustmentSafetyGateService);
      expect(tokenService).toBeInstanceOf(WeightAdjustmentApprovalTokenService);
      expect(snapshotInit).toBeInstanceOf(WeightAdjustmentSnapshotInitializationService);
      expect(measurement).toBeInstanceOf(SeafoodWeightMeasurementService);
      expect(prepService).toBeInstanceOf(SeafoodPreparationFulfillmentService);
      expect(approvalCoord).toBeInstanceOf(CustomerWeightApprovalCoordinationService);
      expect(settlement).toBeInstanceOf(WeightAdjustmentSettlementService);
      expect(releaseReadiness).toBeInstanceOf(WeightAdjustmentReleaseReadinessService);
    });
  });

  describe('Operational Dormancy & Isolation from Active Runtime', () => {
    it('TC-WP3.5-MOD-06: is strictly absent from the production AppModule dependency graph', () => {
      const appModulePath = resolve(__dirname, '../../../app.module.ts');
      const source = readFileSync(appModulePath, 'utf8');

      // WeightAdjustmentModule must NOT be imported or registered in AppModule
      expect(source).not.toContain('WeightAdjustmentModule');
      expect(source).not.toContain('WeightAdjustmentSnapshotInitializationService');
      expect(source).not.toContain('SeafoodWeightMeasurementService');
      expect(source).not.toContain('SeafoodPreparationFulfillmentService');
      expect(source).not.toContain('CustomerWeightApprovalCoordinationService');
      expect(source).not.toContain('WeightAdjustmentSettlementService');
      expect(source).not.toContain('WeightAdjustmentReleaseReadinessService');
    });

    it('TC-WP3.5-MOD-07: produces zero database mutations, external HTTP calls, or payments during initialization', () => {
      expect(prismaMock.$transaction).not.toHaveBeenCalled();
      expect(prismaMock.seafoodOrderWeightAdjustment.create).not.toHaveBeenCalled();
      expect(prismaMock.weightAdjustmentObligation.create).not.toHaveBeenCalled();
    });
  });
});
