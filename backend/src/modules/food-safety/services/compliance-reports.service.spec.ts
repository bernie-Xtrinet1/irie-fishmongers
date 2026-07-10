import { LotWithVendor, SeafoodLotsRepository } from '../repositories/seafood-lots.repository';
import { RecallWithLots, RecallsRepository } from '../repositories/recalls.repository';
import { TemperatureAlertsRepository } from '../repositories/temperature-alerts.repository';
import { ComplianceReportsService } from './compliance-reports.service';

function buildLot(overrides: Partial<LotWithVendor> = {}): LotWithVendor {
  return {
    id: 'lot-1',
    lotNumber: 'LOT-2026-000001',
    publicTraceToken: 'trace-token-1',
    vendorId: 'vendor-1',
    catchItemId: null,
    species: 'Snapper',
    speciesId: null,
    storageType: 'FRESH',
    catchDate: new Date('2026-01-15T00:00:00.000Z'),
    catchLocation: 'North Coast',
    landingSite: 'Falmouth Landing Site',
    weight: { toString: () => '20' } as unknown as LotWithVendor['weight'],
    weightUnit: 'POUNDS',
    freshnessGrade: 'GRADE_A',
    qualityScore: 92,
    foodSafetyStatus: 'SAFE',
    statusNotes: null,
    createdAt: new Date('2026-01-16T00:00:00.000Z'),
    updatedAt: new Date(),
    vendor: {
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
    },
    ...overrides,
  };
}

describe('ComplianceReportsService', () => {
  let lotsRepository: jest.Mocked<Pick<SeafoodLotsRepository, 'findAllForExport'>>;
  let alertsRepository: jest.Mocked<Pick<TemperatureAlertsRepository, 'findAllForExport'>>;
  let recallsRepository: jest.Mocked<Pick<RecallsRepository, 'findAllForExport'>>;
  let service: ComplianceReportsService;

  beforeEach(() => {
    lotsRepository = { findAllForExport: jest.fn() };
    alertsRepository = { findAllForExport: jest.fn() };
    recallsRepository = { findAllForExport: jest.fn() };

    service = new ComplianceReportsService(
      lotsRepository as unknown as SeafoodLotsRepository,
      alertsRepository as unknown as TemperatureAlertsRepository,
      recallsRepository as unknown as RecallsRepository,
    );
  });

  it('maps lots to flat traceability rows', async () => {
    lotsRepository.findAllForExport.mockResolvedValue([buildLot()]);

    const rows = await service.getTraceabilityReport();

    expect(rows).toEqual([
      {
        lotNumber: 'LOT-2026-000001',
        species: 'Snapper',
        storageType: 'FRESH',
        catchDate: '2026-01-15T00:00:00.000Z',
        catchLocation: 'North Coast',
        landingSite: 'Falmouth Landing Site',
        vendorBusinessName: "Vera's Catch",
        freshnessGrade: 'GRADE_A',
        qualityScore: '92',
        foodSafetyStatus: 'SAFE',
        createdAt: '2026-01-16T00:00:00.000Z',
      },
    ]);
  });

  it('maps a lot with no grading to empty-string cells', async () => {
    lotsRepository.findAllForExport.mockResolvedValue([
      buildLot({ freshnessGrade: null, qualityScore: null, catchLocation: null, landingSite: null }),
    ]);

    const rows = await service.getTraceabilityReport();

    expect(rows[0]).toMatchObject({
      freshnessGrade: '',
      qualityScore: '',
      catchLocation: '',
      landingSite: '',
    });
  });

  it('maps temperature alerts to flat rows', async () => {
    alertsRepository.findAllForExport.mockResolvedValue([
      {
        id: 'alert-1',
        readingId: 'reading-1',
        lotId: 'lot-1',
        severity: 'CRITICAL',
        actualC: { toString: () => '9.5' } as never,
        resolved: true,
        resolvedAt: new Date('2026-01-16T01:00:00.000Z'),
        createdAt: new Date('2026-01-16T00:30:00.000Z'),
      },
    ]);

    const rows = await service.getTemperatureComplianceReport();

    expect(rows).toEqual([
      {
        lotId: 'lot-1',
        severity: 'CRITICAL',
        actualC: '9.5',
        resolved: 'true',
        resolvedAt: '2026-01-16T01:00:00.000Z',
        createdAt: '2026-01-16T00:30:00.000Z',
      },
    ]);
  });

  it('maps recalls to flat rows with an affected-lot count', async () => {
    const recall: RecallWithLots = {
      id: 'recall-1',
      severityClass: 'CLASS_I',
      status: 'ACTIVE',
      reason: 'Temperature abuse',
      rootCause: 'Reefer failure',
      resolutionNotes: null,
      createdById: 'admin-1',
      createdAt: new Date('2026-01-17T00:00:00.000Z'),
      updatedAt: new Date(),
      closedAt: null,
      lots: [
        { id: 'rl-1', recallId: 'recall-1', lotId: 'lot-1' },
        { id: 'rl-2', recallId: 'recall-1', lotId: 'lot-2' },
      ],
    };
    recallsRepository.findAllForExport.mockResolvedValue([recall]);

    const rows = await service.getRecallsReport();

    expect(rows).toEqual([
      {
        id: 'recall-1',
        severityClass: 'CLASS_I',
        status: 'ACTIVE',
        reason: 'Temperature abuse',
        rootCause: 'Reefer failure',
        affectedLotCount: '2',
        createdAt: '2026-01-17T00:00:00.000Z',
        closedAt: '',
      },
    ]);
  });
});
