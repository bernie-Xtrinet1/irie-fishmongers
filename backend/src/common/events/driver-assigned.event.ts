// Emitted by DeliveriesService.assign() so the customer is notified that a
// driver now has their order.
export class DriverAssignedEvent {
  static readonly eventName = 'delivery.driver_assigned';

  constructor(
    public readonly customerId: string,
    public readonly vendorOrderId: string,
    public readonly driverFirstName: string,
  ) {}
}
