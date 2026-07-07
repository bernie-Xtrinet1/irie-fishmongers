// Emitted by AuthService.register right after account creation. Consumed by
// NotificationsModule (see notification-standards.md "Registration Successful").
// Lives outside any feature module so emitters never need to depend on
// NotificationsModule - they only need EventEmitter2 + this payload shape.
export class RegistrationConfirmedEvent {
  static readonly eventName = 'registration.confirmed';

  constructor(
    public readonly userId: string,
    public readonly firstName: string,
    public readonly email: string,
  ) {}
}
