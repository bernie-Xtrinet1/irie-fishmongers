import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';

import { AwaitingCustomerAcceptanceEvent } from '../../../common/events/awaiting-customer-acceptance.event';
import { DeliveryStatusUpdatedEvent } from '../../../common/events/delivery-status-updated.event';
import { DriverAssignedEvent } from '../../../common/events/driver-assigned.event';
import { OrderAcceptedEvent } from '../../../common/events/order-accepted.event';
import { OrderPlacedEvent } from '../../../common/events/order-placed.event';
import { PaymentConfirmedEvent } from '../../../common/events/payment-confirmed.event';
import { RefundStatusChangedEvent } from '../../../common/events/refund-status-changed.event';
import { RegistrationConfirmedEvent } from '../../../common/events/registration-confirmed.event';
import { VendorApprovedEvent } from '../../../common/events/vendor-approved.event';
import { NotificationsService } from './notifications.service';

/**
 * The listening half of the event-driven architecture notification-
 * standards.md requires: every module below only emits a plain event
 * (via EventEmitter2) and has no dependency on NotificationsModule at all.
 * This is the one place that translates each event into a category/priority/
 * template-variables call to NotificationsService.notify.
 */
@Injectable()
export class NotificationEventsListener {
  constructor(private readonly notificationsService: NotificationsService) {}

  @OnEvent(RegistrationConfirmedEvent.eventName)
  async onRegistrationConfirmed(event: RegistrationConfirmedEvent): Promise<void> {
    await this.notificationsService.notify({
      userId: event.userId,
      category: 'ACCOUNT',
      eventType: 'REGISTRATION_CONFIRMED',
      priority: 'NORMAL',
      variables: { firstName: event.firstName },
    });
  }

  @OnEvent(VendorApprovedEvent.eventName)
  async onVendorApproved(event: VendorApprovedEvent): Promise<void> {
    await this.notificationsService.notify({
      userId: event.userId,
      category: 'VENDOR',
      eventType: 'VENDOR_APPROVED',
      priority: 'HIGH',
      variables: { businessName: event.businessName },
    });
  }

  @OnEvent(OrderPlacedEvent.eventName)
  async onOrderPlaced(event: OrderPlacedEvent): Promise<void> {
    await this.notificationsService.notify({
      userId: event.customerId,
      category: 'ORDER',
      eventType: 'ORDER_PLACED',
      priority: 'NORMAL',
      variables: {
        orderId: event.orderId,
        totalAmount: event.totalAmount,
        itemCount: String(event.itemCount),
      },
    });
  }

  @OnEvent(OrderAcceptedEvent.eventName)
  async onOrderAccepted(event: OrderAcceptedEvent): Promise<void> {
    await this.notificationsService.notify({
      userId: event.customerId,
      category: 'ORDER',
      eventType: 'ORDER_ACCEPTED',
      priority: 'NORMAL',
      variables: { orderId: event.orderId, vendorBusinessName: event.vendorBusinessName },
    });
  }

  @OnEvent(PaymentConfirmedEvent.eventName)
  async onPaymentConfirmed(event: PaymentConfirmedEvent): Promise<void> {
    await this.notificationsService.notify({
      userId: event.customerId,
      category: 'PAYMENT',
      eventType: 'PAYMENT_CONFIRMED',
      priority: 'HIGH',
      variables: { orderId: event.orderId, amount: event.amount, currency: event.currency },
    });
  }

  @OnEvent(DeliveryStatusUpdatedEvent.eventName)
  async onDeliveryStatusUpdated(event: DeliveryStatusUpdatedEvent): Promise<void> {
    await this.notificationsService.notify({
      userId: event.customerId,
      category: 'DELIVERY',
      eventType: 'DELIVERY_STATUS_UPDATED',
      priority: event.stage === 'FAILED' ? 'CRITICAL' : 'NORMAL',
      variables: { vendorOrderId: event.vendorOrderId, stage: event.stage },
    });
  }

  @OnEvent(RefundStatusChangedEvent.eventName)
  async onRefundStatusChanged(event: RefundStatusChangedEvent): Promise<void> {
    await this.notificationsService.notify({
      userId: event.customerId,
      category: 'PAYMENT',
      eventType: 'REFUND_STATUS_CHANGED',
      priority: 'HIGH',
      variables: { amount: event.amount, status: event.status },
    });
  }

  @OnEvent(DriverAssignedEvent.eventName)
  async onDriverAssigned(event: DriverAssignedEvent): Promise<void> {
    await this.notificationsService.notify({
      userId: event.customerId,
      category: 'DELIVERY',
      eventType: 'DRIVER_ASSIGNED',
      priority: 'NORMAL',
      variables: { vendorOrderId: event.vendorOrderId, driverFirstName: event.driverFirstName },
    });
  }

  @OnEvent(AwaitingCustomerAcceptanceEvent.eventName)
  async onAwaitingCustomerAcceptance(event: AwaitingCustomerAcceptanceEvent): Promise<void> {
    await this.notificationsService.notify({
      userId: event.customerId,
      category: 'DELIVERY',
      eventType: 'AWAITING_CUSTOMER_ACCEPTANCE',
      priority: 'NORMAL',
      variables: { vendorOrderId: event.vendorOrderId },
    });
  }
}
