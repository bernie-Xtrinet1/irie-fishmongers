import { VendorTier } from '@prisma/client';

import { VendorsRepository } from '../../vendors/repositories/vendors.repository';
import { ComplianceScoreCronService } from './compliance-score-cron.service';
import { ComplianceScoreService } from './compliance-score.service';

function approvedVendor(id: string): { id: string; tier: VendorTier } {
  return { id, tier: 'COMMUNITY_FISHER' };
}

describe('ComplianceScoreCronService', () => {
  let vendorsRepository: jest.Mocked<Pick<VendorsRepository, 'findApprovedIds'>>;
  let complianceScoreService: jest.Mocked<Pick<ComplianceScoreService, 'recompute'>>;
  let service: ComplianceScoreCronService;

  beforeEach(() => {
    vendorsRepository = { findApprovedIds: jest.fn() };
    complianceScoreService = { recompute: jest.fn().mockResolvedValue(90) };
    service = new ComplianceScoreCronService(
      vendorsRepository as unknown as VendorsRepository,
      complianceScoreService as unknown as ComplianceScoreService,
    );
  });

  it('pages through every approved vendor and recomputes each once', async () => {
    // First page full (100), second page partial -> terminates.
    const firstPage = Array.from({ length: 100 }, (_, i) => approvedVendor(`v${i}`));
    vendorsRepository.findApprovedIds
      .mockResolvedValueOnce(firstPage)
      .mockResolvedValueOnce([approvedVendor('v100')])
      .mockResolvedValueOnce([]);

    const summary = await service.runBatchRecompute();

    expect(summary).toEqual({ processed: 101, failed: 0 });
    expect(complianceScoreService.recompute).toHaveBeenCalledTimes(101);
  });

  it('isolates a per-vendor failure and keeps going', async () => {
    vendorsRepository.findApprovedIds
      .mockResolvedValueOnce([approvedVendor('v0'), approvedVendor('v1'), approvedVendor('v2')])
      .mockResolvedValueOnce([]);
    complianceScoreService.recompute
      .mockResolvedValueOnce(90)
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(80);

    const summary = await service.runBatchRecompute();

    expect(summary).toEqual({ processed: 2, failed: 1 });
    expect(complianceScoreService.recompute).toHaveBeenCalledTimes(3);
  });

  it('refuses to start a second run while one is already in progress', async () => {
    let releaseFirst: () => void = () => undefined;
    vendorsRepository.findApprovedIds.mockImplementation(async () => {
      // Hold the first run open until we have launched the second.
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      return [];
    });

    const firstRun = service.runBatchRecompute();
    const secondRun = await service.runBatchRecompute();

    expect(secondRun).toEqual({ processed: 0, failed: 0 });
    // The second run bailed without paging.
    expect(vendorsRepository.findApprovedIds).toHaveBeenCalledTimes(1);

    releaseFirst();
    await firstRun;
  });
});
