// Emitted by PaymentsService whenever a payment transitions to PAID -
// covers both online-provider confirmation (WiPay webhook) and manual
// cash-on-delivery confirmation.
export class PaymentConfirmedEvent {
  static readonly eventName = 'payment.confirmed';

  constructor(
    public readonly customerId: string,
    public readonly orderId: string,
    public readonly amount: string,
    public readonly currency: string,
  ) {}
}
