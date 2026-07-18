// The compliance score is a pure function of a vendor's current
// food-safety signal counts (Phase 13C). It starts at a 100 baseline and
// deducts per category, with each category capped so no single runaway
// category can zero a vendor on its own, then clamps to [0, 100].
//
// Kept deliberately dependency-free (no Prisma, no Nest) so it is trivially
// unit-testable and can be reused unchanged by both the write-through
// recompute path and the on-demand explain() breakdown.

export const COMPLIANCE_BASELINE = 100;
export const COMPLIANCE_FLOOR = 0;

// Temperature alerts (unresolved, last 90 days): each severity deducts and
// is capped independently.
export const TEMPERATURE_WEIGHTS = {
  warning: { per: 2, cap: 10 },
  critical: { per: 5, cap: 20 },
  emergency: { per: 10, cap: 30 },
} as const;

// Failed quality inspections (last 180 days): a single combined cap across
// the three failing results.
export const INSPECTION_WEIGHTS = {
  rejected: 8,
  quarantined: 6,
  conditional: 2,
  cap: 25,
} as const;

// Active recalls (status ACTIVE or INVESTIGATING), counted once per recall.
export const RECALL_WEIGHTS = { per: 20, cap: 40 } as const;

// Certifications: each EXPIRED cert deducts (capped); a vendor whose tier
// requires certifications but holds zero ACTIVE ones takes a flat hit.
export const CERTIFICATION_WEIGHTS = {
  expiredPer: 10,
  expiredCap: 20,
  missingRequired: 15,
} as const;

export interface ComplianceSignals {
  temperatureAlerts: { warning: number; critical: number; emergency: number };
  inspections: { rejected: number; quarantined: number; conditional: number };
  activeRecalls: number;
  certifications: { expired: number; requiresCertifications: boolean; hasActiveCertification: boolean };
}

export interface ComplianceScoreBreakdown {
  score: number;
  temperatureDeduction: number;
  inspectionDeduction: number;
  recallDeduction: number;
  certificationDeduction: number;
}

function cap(value: number, max: number): number {
  return Math.min(value, max);
}

function temperatureDeduction(signals: ComplianceSignals['temperatureAlerts']): number {
  return (
    cap(signals.warning * TEMPERATURE_WEIGHTS.warning.per, TEMPERATURE_WEIGHTS.warning.cap) +
    cap(signals.critical * TEMPERATURE_WEIGHTS.critical.per, TEMPERATURE_WEIGHTS.critical.cap) +
    cap(signals.emergency * TEMPERATURE_WEIGHTS.emergency.per, TEMPERATURE_WEIGHTS.emergency.cap)
  );
}

function inspectionDeduction(signals: ComplianceSignals['inspections']): number {
  return cap(
    signals.rejected * INSPECTION_WEIGHTS.rejected +
      signals.quarantined * INSPECTION_WEIGHTS.quarantined +
      signals.conditional * INSPECTION_WEIGHTS.conditional,
    INSPECTION_WEIGHTS.cap,
  );
}

function recallDeduction(activeRecalls: number): number {
  return cap(activeRecalls * RECALL_WEIGHTS.per, RECALL_WEIGHTS.cap);
}

function certificationDeduction(signals: ComplianceSignals['certifications']): number {
  const expired = cap(signals.expired * CERTIFICATION_WEIGHTS.expiredPer, CERTIFICATION_WEIGHTS.expiredCap);
  const missing =
    signals.requiresCertifications && !signals.hasActiveCertification
      ? CERTIFICATION_WEIGHTS.missingRequired
      : 0;
  return expired + missing;
}

export function computeComplianceScore(signals: ComplianceSignals): ComplianceScoreBreakdown {
  const temperature = temperatureDeduction(signals.temperatureAlerts);
  const inspection = inspectionDeduction(signals.inspections);
  const recall = recallDeduction(signals.activeRecalls);
  const certification = certificationDeduction(signals.certifications);

  const raw = COMPLIANCE_BASELINE - (temperature + inspection + recall + certification);
  const score = Math.max(COMPLIANCE_FLOOR, Math.min(COMPLIANCE_BASELINE, raw));

  return {
    score,
    temperatureDeduction: temperature,
    inspectionDeduction: inspection,
    recallDeduction: recall,
    certificationDeduction: certification,
  };
}
