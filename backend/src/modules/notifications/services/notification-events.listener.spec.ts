import { AwaitingCustomerAcceptanceEvent } from '../../../common/events/awaiting-customer-acceptance.event';
import { ColdChainAlertRaisedEvent } from '../../../common/events/cold-chain-alert-raised.event';
import { DeliveryRejectedEvent } from '../../../common/events/delivery-rejected.event';
import { DeliveryStatusUpdatedEvent } from '../../../common/events/delivery-status-updated.event';
import { DriverAssignedEvent } from '../../../common/events/driver-assigned.event';
import { FleetMaintenanceOverdueEvent } from '../../../common/events/fleet-maintenance-overdue.event';
import { OrderAcceptedEvent } from '../../../common/events/order-accepted.event';
import { OrderPlacedEvent } from '../../../common/events/order-placed.event';
import { PaymentConfirmedEvent } from '../../../common/events/payment-confirmed.event';
import { RefundStatusChangedEvent } from '../../../common/events/refund-status-changed.event';
import { RegistrationConfirmedEvent } from '../../../common/events/registration-confirmed.event';
import { VendorApprovedEvent } from '../../../common/events/vendor-approved.event';
import { NotificationEventsListener } from './notification-events.listener';
import { NotificationsService } from './notifications.service';

describe('NotificationEventsListener', () => {
  let notificationsService: jest.Mocked<Pick<NotificationsService, 'notify'>>;
  let listener: NotificationEventsListener;

  beforeEach(() => {
    notificationsService = { notify: jest.fn() };
    listener = new NotificationEventsListener(notificationsService as unknown as NotificationsService);
  });

  it('maps RegistrationConfirmedEvent to an ACCOUNT/REGISTRATION_CONFIRMED/NORMAL notify call', async () => {
    const event = new RegistrationConfirmedEvent('user-1', 'Jane', 'jane@example.com');

    await listener.onRegistrationConfirmed(event);

    expect(notificationsService.notify).toHaveBeenCalledWith({
      userId: 'user-1',
      category: 'ACCOUNT',
      eventType: 'REGISTRATION_CONFIRMED',
      priority: 'NORMAL',
      variables: { firstName: 'Jane' },
    });
  });

  it('maps VendorApprovedEvent to a VENDOR/VENDOR_APPROVED/HIGH notify call', async () => {
    const event = new VendorApprovedEvent('user-1', "Vera's Catch");

    await listener.onVendorApproved(event);

    expect(notificationsService.notify).toHaveBeenCalledWith({
      userId: 'user-1',
      category: 'VENDOR',
      eventType: 'VENDOR_APPROVED',
      priority: 'HIGH',
      variables: { businessName: "Vera's Catch" },
    });
  });

  it('maps OrderPlacedEvent to an ORDER/ORDER_PLACED/NORMAL notify call', async () => {
    const event = new OrderPlacedEvent('customer-1', 'order-1', '5000.00', 3);

    await listener.onOrderPlaced(event);

    expect(notificationsService.notify).toHaveBeenCalledWith({
      userId: 'customer-1',
      category: 'ORDER',
      eventType: 'ORDER_PLACED',
      priority: 'NORMAL',
      variables: { orderId: 'order-1', totalAmount: '5000.00', itemCount: '3' },
    });
  });

  it('maps OrderAcceptedEvent to an ORDER/ORDER_ACCEPTED/NORMAL notify call', async () => {
    const event = new OrderAcceptedEvent('customer-1', 'order-1', 'vo-1', "Vera's Catch");

    await listener.onOrderAccepted(event);

    expect(notificationsService.notify).toHaveBeenCalledWith({
      userId: 'customer-1',
      category: 'ORDER',
      eventType: 'ORDER_ACCEPTED',
      priority: 'NORMAL',
      variables: { orderId: 'order-1', vendorBusinessName: "Vera's Catch" },
    });
  });

  it('maps PaymentConfirmedEvent to a PAYMENT/PAYMENT_CONFIRMED/HIGH notify call', async () => {
    const event = new PaymentConfirmedEvent('customer-1', 'order-1', '5000.00', 'JMD');

    await listener.onPaymentConfirmed(event);

    expect(notificationsService.notify).toHaveBeenCalledWith({
      userId: 'customer-1',
      category: 'PAYMENT',
      eventType: 'PAYMENT_CONFIRMED',
      priority: 'HIGH',
      variables: { orderId: 'order-1', amount: '5000.00', currency: 'JMD' },
    });
  });

  describe('onDeliveryStatusUpdated', () => {
    it('maps a FAILED stage to CRITICAL priority', async () => {
      const event = new DeliveryStatusUpdatedEvent('customer-1', 'vo-1', 'FAILED');

      await listener.onDeliveryStatusUpdated(event);

      expect(notificationsService.notify).toHaveBeenCalledWith({
        userId: 'customer-1',
        category: 'DELIVERY',
        eventType: 'DELIVERY_STATUS_UPDATED',
        priority: 'CRITICAL',
        variables: { vendorOrderId: 'vo-1', stage: 'FAILED' },
      });
    });

    it.each(['PICKED_UP', 'IN_TRANSIT', 'DELIVERED'])(
      'maps a %s stage to NORMAL priority',
      async (stage) => {
        const event = new DeliveryStatusUpdatedEvent('customer-1', 'vo-1', stage);

        await listener.onDeliveryStatusUpdated(event);

        expect(notificationsService.notify).toHaveBeenCalledWith({
          userId: 'customer-1',
          category: 'DELIVERY',
          eventType: 'DELIVERY_STATUS_UPDATED',
          priority: 'NORMAL',
          variables: { vendorOrderId: 'vo-1', stage },
        });
      },
    );
  });

  it('maps RefundStatusChangedEvent to a PAYMENT/REFUND_STATUS_CHANGED/HIGH notify call', async () => {
    const event = new RefundStatusChangedEvent('customer-1', '2500.00', 'COMPLETED');

    await listener.onRefundStatusChanged(event);

    expect(notificationsService.notify).toHaveBeenCalledWith({
      userId: 'customer-1',
      category: 'PAYMENT',
      eventType: 'REFUND_STATUS_CHANGED',
      priority: 'HIGH',
      variables: { amount: '2500.00', status: 'COMPLETED' },
    });
  });

  it('maps DriverAssignedEvent to a DELIVERY/DRIVER_ASSIGNED/NORMAL notify call', async () => {
    const event = new DriverAssignedEvent('customer-1', 'vo-1', 'Dana');

    await listener.onDriverAssigned(event);

    expect(notificationsService.notify).toHaveBeenCalledWith({
      userId: 'customer-1',
      category: 'DELIVERY',
      eventType: 'DRIVER_ASSIGNED',
      priority: 'NORMAL',
      variables: { vendorOrderId: 'vo-1', driverFirstName: 'Dana' },
    });
  });

  it('maps AwaitingCustomerAcceptanceEvent to a DELIVERY/AWAITING_CUSTOMER_ACCEPTANCE/NORMAL notify call', async () => {
    const event = new AwaitingCustomerAcceptanceEvent('customer-1', 'vo-1');

    await listener.onAwaitingCustomerAcceptance(event);

    expect(notificationsService.notify).toHaveBeenCalledWith({
      userId: 'customer-1',
      category: 'DELIVERY',
      eventType: 'AWAITING_CUSTOMER_ACCEPTANCE',
      priority: 'NORMAL',
      variables: { vendorOrderId: 'vo-1' },
    });
  });

  describe('onColdChainAlertRaised', () => {
    it.each([
      ['WARNING', 'NORMAL'],
      ['CRITICAL', 'HIGH'],
      ['EMERGENCY', 'CRITICAL'],
    ])('maps a %s severity to %s priority', async (severity, priority) => {
      const event = new ColdChainAlertRaisedEvent('vendor-user-1', 'LOT-2026-000001', severity, '11', 'VENDOR_STORAGE');

      await listener.onColdChainAlertRaised(event);

      expect(notificationsService.notify).toHaveBeenCalledWith({
        userId: 'vendor-user-1',
        category: 'VENDOR',
        eventType: 'COLD_CHAIN_ALERT_RAISED',
        priority,
        variables: {
          lotNumber: 'LOT-2026-000001',
          severity,
          temperatureC: '11',
          checkpoint: 'VENDOR_STORAGE',
        },
      });
    });
  });

  it('maps FleetMaintenanceOverdueEvent to a DELIVERY/FLEET_MAINTENANCE_OVERDUE/HIGH notify call', async () => {
    const event = new FleetMaintenanceOverdueEvent('driver-user-1', 'FL 1234', '2026-07-01T00:00:00.000Z');

    await listener.onFleetMaintenanceOverdue(event);

    expect(notificationsService.notify).toHaveBeenCalledWith({
      userId: 'driver-user-1',
      category: 'DELIVERY',
      eventType: 'FLEET_MAINTENANCE_OVERDUE',
      priority: 'HIGH',
      variables: { licensePlate: 'FL 1234', nextServiceDue: '2026-07-01T00:00:00.000Z' },
    });
  });

  it('falls back to "unscheduled" when FleetMaintenanceOverdueEvent has no nextServiceDue', async () => {
    const event = new FleetMaintenanceOverdueEvent('driver-user-1', 'FL 1234', null);

    await listener.onFleetMaintenanceOverdue(event);

    expect(notificationsService.notify).toHaveBeenCalledWith(
      expect.objectContaining({ variables: { licensePlate: 'FL 1234', nextServiceDue: 'unscheduled' } }),
    );
  });

  it('maps DeliveryRejectedEvent to a DELIVERY/DELIVERY_REJECTED/HIGH notify call to the vendor', async () => {
    const event = new DeliveryRejectedEvent('customer-1', 'vo-1', 'Package arrived warm', 'vendor-user-1');

    await listener.onDeliveryRejected(event);

    expect(notificationsService.notify).toHaveBeenCalledWith({
      userId: 'vendor-user-1',
      category: 'DELIVERY',
      eventType: 'DELIVERY_REJECTED',
      priority: 'HIGH',
      variables: { vendorOrderId: 'vo-1', reason: 'Package arrived warm' },
    });
  });
});
