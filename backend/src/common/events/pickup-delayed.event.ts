// Placeholder: a real, typed contract for a future "pickup delayed"
// notification. Deliberately never emitted yet - detecting a missed
// scheduledPickupWindowEnd needs a job-queue/scheduler, which does not
// exist anywhere in this codebase (matches the documented gap for
// Inventory reconciliation and document-expiry sync, both on-demand/lazy
// for the same reason).
export class PickupDelayedEvent {
  static readonly eventName = 'delivery.pickup_delayed';

  constructor(
    public readonly vendorOrderId: string,
    public readonly scheduledPickupWindowEnd: Date,
  ) {}
}
