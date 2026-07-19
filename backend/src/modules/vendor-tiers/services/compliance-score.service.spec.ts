import { NotFoundException } from '@nestjs/common';
import { Vendor } from '@prisma/client';

import { VendorsRepository } from '../../vendors/repositories/vendors.repository';
import { ComplianceScoreSignalsRepository } from '../repositories/compliance-score-signals.repository';
import { ComplianceBand } from '../utils/compliance-score-band.util';
import { ComplianceSignals } from '../utils/compliance-score-formula.util';
import { ComplianceScoreService } from './compliance-score.service';

function cleanSignals(overrides: Partial<ComplianceSignals> = {}): ComplianceSignals {
  return {
    temperatureAlerts: { warning: 0, critical: 0, emergency: 0 },
    inspections: { rejected: 0, quarantined: 0, conditional: 0 },
    activeRecalls: 0,
    certifications: { expired: 0, requiresCertifications: false, hasActiveCertification: false },
    ...overrides,
  };
}

function buildVendor(overrides: Partial<Vendor> = {}): Vendor {
  return {
    id: 'vendor-1',
    userId: 'user-1',
    businessName: 'Test Vendor',
    description: null,
    phone: null,
    parish: 'KINGSTON',
    logoUrl: null,
    status: 'APPROVED',
    tier: 'COMMUNITY_FISHER',
    complianceScore: 88,
    complianceScoreUpdatedAt: new Date('2026-07-01'),
    termsAcceptedAt: new Date(),
    primaryZoneId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('ComplianceScoreService', () => {
  let vendorsRepository: jest.Mocked<Pick<VendorsRepository, 'findById' | 'updateComplianceScore'>>;
  let signalsRepository: jest.Mocked<Pick<ComplianceScoreSignalsRepository, 'gather'>>;
  let service: ComplianceScoreService;

  beforeEach(() => {
    vendorsRepository = { findById: jest.fn(), updateComplianceScore: jest.fn() };
    signalsRepository = { gather: jest.fn() };
    service = new ComplianceScoreService(
      vendorsRepository as unknown as VendorsRepository,
      signalsRepository as unknown as ComplianceScoreSignalsRepository,
    );
  });

  describe('recompute', () => {
    it('computes from current signals and writes the score through', async () => {
      vendorsRepository.findById.mockResolvedValue(buildVendor());
      signalsRepository.gather.mockResolvedValue(cleanSignals({ activeRecalls: 1 }));
      vendorsRepository.updateComplianceScore.mockResolvedValue(buildVendor());

      const score = await service.recompute('vendor-1');

      expect(score).toBe(80); // 100 - 20 for one active recall
      expect(vendorsRepository.updateComplianceScore).toHaveBeenCalledWith('vendor-1', 80);
    });

    it('returns null and does not write when the vendor no longer exists', async () => {
      vendorsRepository.findById.mockResolvedValue(null);

      const score = await service.recompute('gone');

      expect(score).toBeNull();
      expect(vendorsRepository.updateComplianceScore).not.toHaveBeenCalled();
    });

    it('is idempotent: two back-to-back recomputes converge on the same score', async () => {
      vendorsRepository.findById.mockResolvedValue(buildVendor());
      signalsRepository.gather.mockResolvedValue(cleanSignals({ temperatureAlerts: { warning: 2, critical: 0, emergency: 0 } }));
      vendorsRepository.updateComplianceScore.mockResolvedValue(buildVendor());

      const [a, b] = await Promise.all([service.recompute('vendor-1'), service.recompute('vendor-1')]);

      expect(a).toBe(96); // 100 - (2 * 2)
      expect(b).toBe(96);
    });
  });

  describe('describe', () => {
    it('returns the stored score, band, timestamp, and a fresh breakdown', async () => {
      const updatedAt = new Date('2026-07-01');
      vendorsRepository.findById.mockResolvedValue(buildVendor({ complianceScore: 88, complianceScoreUpdatedAt: updatedAt }));
      signalsRepository.gather.mockResolvedValue(cleanSignals({ inspections: { rejected: 1, quarantined: 0, conditional: 0 } }));

      const result = await service.describe('vendor-1');

      expect(result.score).toBe(88);
      expect(result.band).toBe(ComplianceBand.GOOD);
      expect(result.updatedAt).toBe(updatedAt);
      expect(result.breakdown.inspectionDeduction).toBe(8);
      expect(result.breakdown.score).toBe(92); // fresh compute may differ from stored 88
    });

    it('throws NotFound for a missing vendor', async () => {
      vendorsRepository.findById.mockResolvedValue(null);
      await expect(service.describe('gone')).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
