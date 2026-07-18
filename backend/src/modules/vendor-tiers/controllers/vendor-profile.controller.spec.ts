import {
  VendorComplianceStatusLabel,
  VendorProfileResponseEntity,
} from '../entities/vendor-profile-response.entity';
import { ComplianceBand } from '../utils/compliance-score-band.util';
import { VendorProfileService } from '../services/vendor-profile.service';
import { VendorProfileController } from './vendor-profile.controller';

const profile: VendorProfileResponseEntity = {
  id: 'vendor-1',
  businessName: "Vera's Catch",
  tier: 'COMMUNITY_FISHER',
  badge: '🐟 Community Fisher',
  parish: 'KINGSTON',
  complianceScore: null,
  complianceBand: ComplianceBand.NOT_YET_ASSESSED,
  complianceScoreUpdatedAt: null,
  foodSafetyStatus: VendorComplianceStatusLabel.NOT_YET_ASSESSED,
  traceabilityStatus: VendorComplianceStatusLabel.NOT_YET_ASSESSED,
  ordersCompleted: 3,
  rating: null,
  coldChainScore: null,
  recentReviews: [],
};

describe('VendorProfileController', () => {
  let vendorProfileService: jest.Mocked<Pick<VendorProfileService, 'getProfile'>>;
  let controller: VendorProfileController;

  beforeEach(() => {
    vendorProfileService = { getProfile: jest.fn().mockResolvedValue(profile) };
    controller = new VendorProfileController(
      vendorProfileService as unknown as VendorProfileService,
    );
  });

  it('gets the vendor profile', async () => {
    await expect(controller.getProfile('vendor-1')).resolves.toEqual(profile);
    expect(vendorProfileService.getProfile).toHaveBeenCalledWith('vendor-1');
  });
});
