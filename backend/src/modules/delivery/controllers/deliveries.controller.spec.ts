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
  scheduledPickupWindowStart: null,
  scheduledPickupWindowEnd: null,
  customerDeliveryWindowStart: null,
  customerDeliveryWindowEnd: null,
  vendorConfirmedAt: null,
  vendorConfirmedById: null,
  customerAcceptanceStatus: 'PENDING',
  customerAcceptedAt: null,
  customerRejectedAt: null,
  rejectionReason: null,
  assignedAt: new Date(),
  pickedUpAt: null,
  deliveredAt: null,
  failedAt: null,
  failureReason: null,
  proofType: null,
  proofUrl: null,
  exceptions: [],
  routeHistory: null,
};

const tracking: DeliveryTrackingEntity = {
  vendorOrderId: 'vo-1',
  stage: 'ASSIGNED',
  driverFirstName: 'Dana',
  driverPhone: '+18765550000',
  driverVehicleType: 'CAR',
  driverLicensePlate: 'AB 1234',
  latestLocation: null,
  customerDeliveryWindowStart: null,
  customerDeliveryWindowEnd: null,
  assignedAt: new Date(),
  pickedUpAt: null,
  deliveredAt: null,
  failedAt: null,
};

const driverUser = { id: 'driver-user-1', email: 'a@b.com', roles: ['DRIVER' as const] };
const customerUser = { id: 'customer-1', email: 'c@d.com', roles: ['CUSTOMER' as const] };
const vendorUser = { id: 'vendor-user-1', email: 'v@d.com', roles: ['VENDOR' as const] };

describe('DeliveriesController', () => {
  let deliveriesService: jest.Mocked<
    Pick<
      DeliveriesService,
      | 'getAvailable'
      | 'assign'
      | 'getMine'
      | 'updateStatus'
      | 'updateSchedule'
      | 'confirmVendorPickup'
      | 'recordCustomerAcceptance'
      | 'track'
    >
  >;
  let controller: DeliveriesController;

  beforeEach(() => {
    deliveriesService = {
      getAvailable: jest.fn().mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 }),
      assign: jest.fn().mockResolvedValue(delivery),
      getMine: jest.fn().mockResolvedValue({ items: [delivery], total: 1, page: 1, pageSize: 20 }),
      updateStatus: jest.fn().mockResolvedValue({ ...delivery, stage: 'PICKED_UP' }),
      updateSchedule: jest.fn().mockResolvedValue({
        ...delivery,
        scheduledPickupWindowStart: new Date('2026-07-10T10:00:00.000Z'),
      }),
      confirmVendorPickup: jest.fn().mockResolvedValue({ ...delivery, vendorConfirmedAt: new Date() }),
      recordCustomerAcceptance: jest.fn().mockResolvedValue({
        ...delivery,
        customerAcceptanceStatus: 'ACCEPTED',
      }),
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

  it('updates a delivery schedule', async () => {
    const dto = { scheduledPickupWindowStart: '2026-07-10T10:00:00.000Z' };
    const result = await controller.updateSchedule(driverUser, 'delivery-1', dto);
    expect(result.scheduledPickupWindowStart).not.toBeNull();
    expect(deliveriesService.updateSchedule).toHaveBeenCalledWith('driver-user-1', 'delivery-1', dto);
  });

  it('confirms vendor pickup', async () => {
    const result = await controller.confirmVendorPickup(vendorUser, 'delivery-1');
    expect(result.vendorConfirmedAt).not.toBeNull();
    expect(deliveriesService.confirmVendorPickup).toHaveBeenCalledWith('vendor-user-1', 'delivery-1');
  });

  it('records a customer acceptance decision', async () => {
    const dto = { decision: 'ACCEPTED' as const };
    const result = await controller.recordCustomerAcceptance(customerUser, 'delivery-1', dto);
    expect(result.customerAcceptanceStatus).toBe('ACCEPTED');
    expect(deliveriesService.recordCustomerAcceptance).toHaveBeenCalledWith(
      'customer-1',
      'delivery-1',
      dto,
    );
  });

  it('tracks a delivery for the owning customer', async () => {
    await expect(controller.track(customerUser, 'vo-1')).resolves.toEqual(tracking);
    expect(deliveriesService.track).toHaveBeenCalledWith('customer-1', 'vo-1');
  });
});
