// Emitted by PaymentsService.executeRefund once a refund attempt has a result.
export class RefundStatusChangedEvent {
  static readonly eventName = 'refund.status_changed';

  constructor(
    public readonly customerId: string,
    public readonly amount: string,
    public readonly status: string,
  ) {}
}
