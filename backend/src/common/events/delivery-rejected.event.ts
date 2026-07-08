// Emitted by DeliveriesService when a customer rejects a delivered order.
// Consumed by FoodSafetyEventsListener to raise a quality incident per
// distinct seafood lot in the rejected vendor order.
export class DeliveryRejectedEvent {
  static readonly eventName = 'delivery.rejected';

  constructor(
    public readonly customerId: string,
    public readonly vendorOrderId: string,
    public readonly reason: string,
  ) {}
}
