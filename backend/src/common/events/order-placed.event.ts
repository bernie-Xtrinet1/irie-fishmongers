// Emitted by OrdersService.checkout once an order has been created.
export class OrderPlacedEvent {
  static readonly eventName = 'order.placed';

  constructor(
    public readonly customerId: string,
    public readonly orderId: string,
    public readonly totalAmount: string,
    public readonly itemCount: number,
  ) {}
}
