// Emitted by VendorOrdersService.accept once a vendor accepts their portion
// of an order.
export class OrderAcceptedEvent {
  static readonly eventName = 'order.accepted';

  constructor(
    public readonly customerId: string,
    public readonly orderId: string,
    public readonly vendorOrderId: string,
    public readonly vendorBusinessName: string,
  ) {}
}
