// Emitted by RecallsService.updateStatus() after any recall status
// transition commits - an ACTIVE/INVESTIGATING recall deducts from every
// affected vendor's compliance score, and a RESOLVED/CLOSED transition lets
// those scores recover (Phase 13C). Carries the distinct vendorIds whose
// lots the recall touches so the listener recomputes exactly those.
export class RecallStatusChangedEvent {
  static readonly eventName = 'recall.status-changed';

  constructor(
    public readonly recallId: string,
    public readonly status: string,
    public readonly vendorIds: string[],
  ) {}
}
