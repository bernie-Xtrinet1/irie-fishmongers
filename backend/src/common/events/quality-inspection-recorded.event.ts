// Emitted by QualityInspectionsService.inspect() after the inspection and
// its lot-grading update have committed - a failed or conditional
// inspection changes the lot's owning vendor's compliance score (Phase
// 13C). Carries the vendorId directly (resolved from the inspected lot) so
// the compliance-score listener needn't re-read the lot.
export class QualityInspectionRecordedEvent {
  static readonly eventName = 'quality-inspection.recorded';

  constructor(
    public readonly vendorId: string,
    public readonly lotId: string,
    public readonly result: string,
  ) {}
}
