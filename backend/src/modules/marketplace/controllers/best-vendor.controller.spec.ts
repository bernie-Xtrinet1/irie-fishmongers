import { BestVendorResolutionEntity } from '../entities/best-vendor-resolution.entity';
import { FulfillmentDecisionsService } from '../services/fulfillment-decisions.service';
import { BestVendorController } from './best-vendor.controller';

const resolution: BestVendorResolutionEntity = {
  productId: 'product-1',
  vendorId: 'vendor-1',
  badge: '🐟 Community Fisher',
  totalScore: '82.50',
  fulfillmentDecisionId: 'decision-1',
};

const customerUser = { id: 'customer-1', email: 'c@example.com', roles: ['CUSTOMER' as const] };

describe('BestVendorController', () => {
  let fulfillmentDecisionsService: jest.Mocked<Pick<FulfillmentDecisionsService, 'resolveBestVendor'>>;
  let controller: BestVendorController;

  beforeEach(() => {
    fulfillmentDecisionsService = {
      resolveBestVendor: jest.fn().mockResolvedValue(resolution),
    };
    controller = new BestVendorController(
      fulfillmentDecisionsService as unknown as FulfillmentDecisionsService,
    );
  });

  it('resolves the best vendor for the authenticated customer', async () => {
    const dto = { productId: 'product-1', quantity: 5, deliveryParish: 'KINGSTON' as const };

    await expect(controller.resolve(customerUser, dto)).resolves.toEqual(resolution);
    expect(fulfillmentDecisionsService.resolveBestVendor).toHaveBeenCalledWith('customer-1', dto);
  });
});
