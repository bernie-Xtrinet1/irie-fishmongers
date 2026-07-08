import { AwaitingCustomerAcceptanceEvent } from '../../../common/events/awaiting-customer-acceptance.event';
import { DeliveryStatusUpdatedEvent } from '../../../common/events/delivery-status-updated.event';
import { DriverAssignedEvent } from '../../../common/events/driver-assigned.event';
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
});
