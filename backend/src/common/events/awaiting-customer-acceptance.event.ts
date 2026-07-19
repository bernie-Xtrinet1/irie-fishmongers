// Emitted by DeliveriesService.updateStatus() the moment a delivery is
// marked DELIVERED and customerAcceptanceStatus becomes PENDING, prompting
// the customer to accept or reject the order.
export class AwaitingCustomerAcceptanceEvent {
  static readonly eventName = 'delivery.awaiting_customer_acceptance';

  constructor(
    public readonly customerId: string,
    public readonly vendorOrderId: string,
  ) {}
}
