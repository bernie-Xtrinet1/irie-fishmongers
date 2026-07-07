import { RoleName } from '@prisma/client';

import { RequestUser } from '../../../common/guards/jwt-auth.guard';
import { DowngradeVendorDto } from '../dto/downgrade-vendor.dto';
import { RequestTierUpgradeDto } from '../dto/request-tier-upgrade.dto';
import { PaginatedDowngradeEventsEntity } from '../entities/paginated-downgrade-events.entity';
import { VendorDowngradeEventResponseEntity } from '../entities/vendor-downgrade-event-response.entity';
import { VendorUpgradeRequestResponseEntity } from '../entities/vendor-upgrade-request-response.entity';
import { VendorTiersService } from '../services/vendor-tiers.service';
import { VendorTiersController } from './vendor-tiers.controller';

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

const downgradeEvent: VendorDowngradeEventResponseEntity = {
  id: 'event-1',
  vendorId: 'vendor-1',
  fromTier: 'VERIFIED_VENDOR',
  toTier: 'COMMUNITY_FISHER',
  reason: 'ADMIN_MANUAL',
  triggeredById: 'admin-1',
  notes: null,
  createdAt: new Date(),
};

const vendorUser: RequestUser = { id: 'user-1', email: 'vera@example.com', roles: [RoleName.VENDOR] };
const adminUser: RequestUser = { id: 'admin-1', email: 'admin@example.com', roles: [RoleName.ADMINISTRATOR] };

describe('VendorTiersController', () => {
  let vendorTiersService: jest.Mocked<
    Pick<VendorTiersService, 'requestUpgrade' | 'downgrade' | 'listDowngradeEvents'>
  >;
  let controller: VendorTiersController;

  beforeEach(() => {
    vendorTiersService = {
      requestUpgrade: jest.fn().mockResolvedValue(upgradeRequest),
      downgrade: jest.fn().mockResolvedValue(downgradeEvent),
      listDowngradeEvents: jest.fn().mockResolvedValue({
        items: [downgradeEvent],
        total: 1,
        page: 1,
        pageSize: 20,
      } satisfies PaginatedDowngradeEventsEntity),
    };
    controller = new VendorTiersController(vendorTiersService as unknown as VendorTiersService);
  });

  it('requests a tier upgrade for the authenticated vendor', async () => {
    const dto: RequestTierUpgradeDto = { requestedTier: 'VERIFIED_VENDOR' };

    await expect(controller.requestUpgrade(vendorUser, dto)).resolves.toEqual(upgradeRequest);
    expect(vendorTiersService.requestUpgrade).toHaveBeenCalledWith('user-1', dto);
  });

  it('downgrades a vendor (admin only)', async () => {
    const dto: DowngradeVendorDto = { toTier: 'COMMUNITY_FISHER', reason: 'ADMIN_MANUAL' };

    const result = await controller.downgrade(adminUser, 'vendor-1', dto);

    expect(result).toEqual(downgradeEvent);
    expect(vendorTiersService.downgrade).toHaveBeenCalledWith('admin-1', 'vendor-1', dto);
  });

  it("lists a vendor's downgrade history (admin only)", async () => {
    const result = await controller.listDowngradeEvents('vendor-1', { page: 1, pageSize: 20 });

    expect(result.total).toBe(1);
    expect(vendorTiersService.listDowngradeEvents).toHaveBeenCalledWith('vendor-1', {
      page: 1,
      pageSize: 20,
    });
  });
});
