// Emitted by TemperatureMonitoringService.recordReading() whenever a
// temperature reading breaches its threshold - closes cold-chain-
// management.md's "Notify Vendor" automated action, which applies at
// every severity tier. That doc's CRITICAL/EMERGENCY escalation to
// Operations/Admin is intentionally not wired here: this codebase has no
// "all administrators" recipient lookup yet (confirmed: no repository
// method anywhere queries users by role), and building one is out of
// scope for wiring this single event - it needs its own task.
export class ColdChainAlertRaisedEvent {
  static readonly eventName = 'cold-chain.alert-raised';

  constructor(
    public readonly vendorUserId: string,
    public readonly lotNumber: string,
    public readonly severity: string,
    public readonly temperatureC: string,
    public readonly checkpoint: string,
  ) {}
}
