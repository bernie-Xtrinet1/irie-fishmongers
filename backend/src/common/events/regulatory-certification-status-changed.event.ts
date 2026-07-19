// Emitted by RegulatoryCertificationsService when a VENDOR certification is
// activated, suspended, revoked, or renewed (Phase 13C). Certification
// status is action-based, so the score must recompute immediately rather
// than waiting for the nightly sweep. Fisherman/landing-site certifications
// don't affect a vendor score and are not emitted. Expiry crossing a date
// boundary is time-based and stays sweep-only.
export class RegulatoryCertificationStatusChangedEvent {
  static readonly eventName = 'regulatory-certification.status-changed';

  constructor(
    public readonly vendorId: string,
    public readonly status: string,
  ) {}
}
