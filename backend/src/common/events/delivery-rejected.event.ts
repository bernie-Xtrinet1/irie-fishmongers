// Emitted by DeliveriesService when a customer rejects a delivered order.
// Consumed by FoodSafetyEventsListener to raise a quality incident per
// distinct seafood lot in the rejected vendor order, and by
// NotificationEventsListener to notify the vendor - a customer rejecting a
// delivered order is operationally significant for them (a quality
// incident is being raised against their product), so they are the
// recipient, not the customer who already knows they rejected it.
export class DeliveryRejectedEvent {
  static readonly eventName = 'delivery.rejected';

  constructor(
    public readonly customerId: string,
    public readonly vendorOrderId: string,
    public readonly reason: string,
    public readonly vendorUserId: string,
  ) {}
}
