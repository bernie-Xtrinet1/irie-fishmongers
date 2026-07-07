// Emitted by DeliveriesService whenever a delivery's stage changes
// (PICKED_UP, IN_TRANSIT, DELIVERED, FAILED).
export class DeliveryStatusUpdatedEvent {
  static readonly eventName = 'delivery.status_updated';

  constructor(
    public readonly customerId: string,
    public readonly vendorOrderId: string,
    public readonly stage: string,
  ) {}
}
