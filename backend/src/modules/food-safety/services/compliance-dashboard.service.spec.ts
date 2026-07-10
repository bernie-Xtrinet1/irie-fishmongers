import { FishermenRepository } from '../../catches/repositories/fishermen.repository';
import { VendorsRepository } from '../../vendors/repositories/vendors.repository';
import { QualityInspectionsRepository } from '../repositories/quality-inspections.repository';
import { RecallsRepository } from '../repositories/recalls.repository';
import { SeafoodLotsRepository } from '../repositories/seafood-lots.repository';
import { TemperatureAlertsRepository } from '../repositories/temperature-alerts.repository';
import { ComplianceDashboardService } from './compliance-dashboard.service';

describe('ComplianceDashboardService', () => {
  let alertsRepository: jest.Mocked<Pick<TemperatureAlertsRepository, 'countUnresolvedBySeverity'>>;
  let inspectionsRepository: jest.Mocked<Pick<QualityInspectionsRepository, 'countFailedSince'>>;
  let lotsRepository: jest.Mocked<Pick<SeafoodLotsRepository, 'countByStatus'>>;
  let recallsRepository: jest.Mocked<Pick<RecallsRepository, 'countByStatus'>>;
  let vendorsRepository: jest.Mocked<Pick<VendorsRepository, 'getComplianceSummary'>>;
  let fishermenRepository: jest.Mocked<Pick<FishermenRepository, 'countByStatus'>>;
  let service: ComplianceDashboardService;

  beforeEach(() => {
    alertsRepository = { countUnresolvedBySeverity: jest.fn() };
    inspectionsRepository = { countFailedSince: jest.fn() };
    lotsRepository = { countByStatus: jest.fn() };
    recallsRepository = { countByStatus: jest.fn() };
    vendorsRepository = { getComplianceSummary: jest.fn() };
    fishermenRepository = { countByStatus: jest.fn() };

    service = new ComplianceDashboardService(
      alertsRepository as unknown as TemperatureAlertsRepository,
      inspectionsRepository as unknown as QualityInspectionsRepository,
      lotsRepository as unknown as SeafoodLotsRepository,
      recallsRepository as unknown as RecallsRepository,
      vendorsRepository as unknown as VendorsRepository,
      fishermenRepository as unknown as FishermenRepository,
    );
  });

  it('composes the dashboard from every source in parallel', async () => {
    alertsRepository.countUnresolvedBySeverity.mockResolvedValue({ WARNING: 2, CRITICAL: 1, EMERGENCY: 0 });
    inspectionsRepository.countFailedSince.mockResolvedValue(3);
    lotsRepository.countByStatus.mockResolvedValue(4);
    recallsRepository.countByStatus.mockResolvedValue(1);
    vendorsRepository.getComplianceSummary.mockResolvedValue({
      countByStatus: { PENDING: 2, APPROVED: 10, SUSPENDED: 1, REJECTED: 0 },
      averageComplianceScore: 87.5,
    });
    fishermenRepository.countByStatus.mockResolvedValue({ PENDING: 1, APPROVED: 5, SUSPENDED: 0, REJECTED: 0 });

    const result = await service.getDashboard();

    expect(result.activeAlertsBySeverity).toEqual({ WARNING: 2, CRITICAL: 1, EMERGENCY: 0 });
    expect(result.failedInspectionsLast30Days).toBe(3);
    expect(result.lotsPendingReview).toBe(4);
    expect(result.activeRecalls).toBe(1);
    expect(result.vendorCompliance.averageComplianceScore).toBe(87.5);
    expect(result.fishermenByStatus.APPROVED).toBe(5);
    expect(result.generatedAt).toBeInstanceOf(Date);

    expect(lotsRepository.countByStatus).toHaveBeenCalledWith('UNDER_REVIEW');
    expect(recallsRepository.countByStatus).toHaveBeenCalledWith('ACTIVE');
  });
});
