// Placeholder: a real, typed contract for a future "delivery delayed"
// notification. Deliberately never emitted yet - same missing
// job-queue/scheduler infrastructure as PickupDelayedEvent, needed here to
// detect a missed customerDeliveryWindowEnd.
export class DeliveryDelayedEvent {
  static readonly eventName = 'delivery.delivery_delayed';

  constructor(
    public readonly customerId: string,
    public readonly vendorOrderId: string,
    public readonly customerDeliveryWindowEnd: Date,
  ) {}
}
