// Emitted by RecallsService.updateStatus() when a recall transitions to
// ACTIVE, once per affected customer/order - closes seafood-compliance-
// rules.md's "Notify affected customers" recall-workflow step.
export class RecallIssuedEvent {
  static readonly eventName = 'recall.issued';

  constructor(
    public readonly customerId: string,
    public readonly orderId: string,
    public readonly lotNumber: string,
    public readonly reason: string,
  ) {}
}
