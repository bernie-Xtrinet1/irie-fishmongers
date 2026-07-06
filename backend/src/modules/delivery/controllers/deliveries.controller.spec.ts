import { DeliveryTrackingEntity } from '../entities/delivery-tracking.entity';
import { DriverDeliveryResponseEntity } from '../entities/driver-delivery-response.entity';
import { DeliveriesService } from '../services/deliveries.service';
import { DeliveriesController } from './deliveries.controller';

const delivery: DriverDeliveryResponseEntity = {
  id: 'delivery-1',
  vendorOrderId: 'vo-1',
  driverId: 'driver-1',
  stage: 'ASSIGNED',
  pickupVendorName: "Vera's Catch",
  pickupParish: 'KINGSTON',
  items: [],
  deliveryAddressLine1: '1 Ocean View Road',
  deliveryAddressLine2: null,
  deliveryParish: 'KINGSTON',
  deliveryPhone: '+18765551234',
  assignedAt: new Date(),
  pickedUpAt: null,
  deliveredAt: null,
  failedAt: null,
  failureReason: null,
  proofType: null,
  proofUrl: null,
};

const tracking: DeliveryTrackingEntity = {
  vendorOrderId: 'vo-1',
  stage: 'ASSIGNED',
  driverFirstName: 'Dana',
  driverPhone: '+18765550000',
  driverVehicleType: 'CAR',
  driverLicensePlate: 'AB 1234',
  latestLocation: null,
  assignedAt: new Date(),
  pickedUpAt: null,
  deliveredAt: null,
  failedAt: null,
};

const driverUser = { id: 'driver-user-1', email: 'a@b.com', roles: ['DRIVER' as const] };
const customerUser = { id: 'customer-1', email: 'c@d.com', roles: ['CUSTOMER' as const] };

describe('DeliveriesController', () => {
  let deliveriesService: jest.Mocked<
    Pick<DeliveriesService, 'getAvailable' | 'assign' | 'getMine' | 'updateStatus' | 'track'>
  >;
  let controller: DeliveriesController;

  beforeEach(() => {
    deliveriesService = {
      getAvailable: jest.fn().mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 }),
      assign: jest.fn().mockResolvedValue(delivery),
      getMine: jest.fn().mockResolvedValue({ items: [delivery], total: 1, page: 1, pageSize: 20 }),
      updateStatus: jest.fn().mockResolvedValue({ ...delivery, stage: 'PICKED_UP' }),
      track: jest.fn().mockResolvedValue(tracking),
    };
    controller = new DeliveriesController(deliveriesService as unknown as DeliveriesService);
  });

  it('lists available deliveries', async () => {
    const result = await controller.getAvailable(driverUser, { page: 1, pageSize: 20 });
    expect(result.total).toBe(0);
    expect(deliveriesService.getAvailable).toHaveBeenCalledWith('driver-user-1', {
      page: 1,
      pageSize: 20,
    });
  });

  it('assigns a delivery', async () => {
    const dto = { vendorOrderId: 'vo-1' };
    await expect(controller.assign(driverUser, dto)).resolves.toEqual(delivery);
    expect(deliveriesService.assign).toHaveBeenCalledWith('driver-user-1', dto);
  });

  it("lists the driver's own deliveries", async () => {
    const result = await controller.getMine(driverUser, { page: 1, pageSize: 20 });
    expect(result.total).toBe(1);
  });

  it('updates a delivery status', async () => {
    const dto = { action: 'PICKED_UP' as const };
    const result = await controller.updateStatus(driverUser, 'delivery-1', dto);
    expect(result.stage).toBe('PICKED_UP');
    expect(deliveriesService.updateStatus).toHaveBeenCalledWith('driver-user-1', 'delivery-1', dto);
  });

  it('tracks a delivery for the owning customer', async () => {
    await expect(controller.track(customerUser, 'vo-1')).resolves.toEqual(tracking);
    expect(deliveriesService.track).toHaveBeenCalledWith('customer-1', 'vo-1');
  });
});
