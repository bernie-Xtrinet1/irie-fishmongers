// Emitted by FleetMaintenanceService when a maintenance record's status
// becomes OVERDUE - notifies the vehicle's current driver (the one direct,
// known recipient), not "all administrators": this codebase has no
// recipient lookup for an entire role yet (same gap noted by
// ColdChainAlertRaisedEvent), and building one is out of scope for wiring
// this single event. Operations-wide visibility comes from the Delivery
// Operations Center dashboard surfacing overdue records directly, not a
// push notification with no admin recipient to send to.
export class FleetMaintenanceOverdueEvent {
  static readonly eventName = 'fleet-maintenance.overdue';

  constructor(
    public readonly driverUserId: string,
    public readonly licensePlate: string,
    public readonly nextServiceDue: string | null,
  ) {}
}
