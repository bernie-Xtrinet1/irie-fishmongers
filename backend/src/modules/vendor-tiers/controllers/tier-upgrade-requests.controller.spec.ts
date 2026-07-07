import { RoleName } from '@prisma/client';

import { RequestUser } from '../../../common/guards/jwt-auth.guard';
import { ListUpgradeRequestsDto } from '../dto/list-upgrade-requests.dto';
import { ReviewUpgradeRequestDto } from '../dto/review-upgrade-request.dto';
import { PaginatedUpgradeRequestsEntity } from '../entities/paginated-upgrade-requests.entity';
import { VendorUpgradeRequestResponseEntity } from '../entities/vendor-upgrade-request-response.entity';
import { VendorTiersService } from '../services/vendor-tiers.service';
import { TierUpgradeRequestsController } from './tier-upgrade-requests.controller';

const upgradeRequest: VendorUpgradeRequestResponseEntity = {
  id: 'request-1',
  vendorId: 'vendor-1',
  requestedTier: 'VERIFIED_VENDOR',
  status: 'PENDING',
  reason: null,
  reviewedById: null,
  reviewedAt: null,
  reviewNotes: null,
  createdAt: new Date(),
};

const adminUser: RequestUser = { id: 'admin-1', email: 'admin@example.com', roles: [RoleName.ADMINISTRATOR] };

describe('TierUpgradeRequestsController', () => {
  let vendorTiersService: jest.Mocked<
    Pick<VendorTiersService, 'listUpgradeRequests' | 'reviewUpgradeRequest'>
  >;
  let controller: TierUpgradeRequestsController;

  beforeEach(() => {
    vendorTiersService = {
      listUpgradeRequests: jest.fn().mockResolvedValue({
        items: [upgradeRequest],
        total: 1,
        page: 1,
        pageSize: 20,
      } satisfies PaginatedUpgradeRequestsEntity),
      reviewUpgradeRequest: jest.fn().mockResolvedValue({ ...upgradeRequest, status: 'APPROVED' }),
    };
    controller = new TierUpgradeRequestsController(vendorTiersService as unknown as VendorTiersService);
  });

  it('lists vendor tier upgrade requests', async () => {
    const dto: ListUpgradeRequestsDto = { page: 1, pageSize: 20, status: 'PENDING' };

    const result = await controller.list(dto);

    expect(result.total).toBe(1);
    expect(vendorTiersService.listUpgradeRequests).toHaveBeenCalledWith(dto);
  });

  it('reviews a vendor tier upgrade request', async () => {
    const dto: ReviewUpgradeRequestDto = { decision: 'APPROVED' };

    const result = await controller.review(adminUser, 'request-1', dto);

    expect(result.status).toBe('APPROVED');
    expect(vendorTiersService.reviewUpgradeRequest).toHaveBeenCalledWith('admin-1', 'request-1', dto);
  });
});
