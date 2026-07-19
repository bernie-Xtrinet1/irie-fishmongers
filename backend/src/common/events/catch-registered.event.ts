// Emitted by CatchesService when a fisherman registers a new catch.
// Consumed by FoodSafetyEventsListener to write the LANDING chain-of-
// custody event - CatchesModule can't call CustodyEventsRepository
// directly without a circular import (SeafoodLotsModule, which
// FoodSafetyModule composes alongside CatchesModule, already imports
// CustodyEventsModule).
export class CatchRegisteredEvent {
  static readonly eventName = 'catch.registered';

  constructor(
    public readonly catchId: string,
    public readonly fishermanUserId: string,
  ) {}
}
