// Emitted by VendorsService when a vendor's status transitions to APPROVED.
export class VendorApprovedEvent {
  static readonly eventName = 'vendor.approved';

  constructor(
    public readonly userId: string,
    public readonly businessName: string,
  ) {}
}
