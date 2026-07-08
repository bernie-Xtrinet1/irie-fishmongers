// Placeholder: a real, typed contract for a future "driver nearby"
// notification. Deliberately never emitted yet - computing "nearby" needs
// customer delivery-address geocoding (lat/lng), which this platform does
// not have (addresses are free-text + parish only).
export class DriverNearbyEvent {
  static readonly eventName = 'delivery.driver_nearby';

  constructor(
    public readonly customerId: string,
    public readonly vendorOrderId: string,
  ) {}
}
