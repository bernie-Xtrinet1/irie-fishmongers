import type { OrdinaryReservationCommand } from '@prisma/client';
import type { OrdinaryW1IssuanceResult } from '../services/ordinary-w1-issuance.service';

declare const admissionBrand: unique symbol;

// Runtime authority is service-local object identity, not this erased brand.
export interface OrdinaryCommandAdmission { readonly [admissionBrand]: true }

export interface ControlledOrdinaryIssuanceResult {
  issuance: OrdinaryW1IssuanceResult;
  admission: OrdinaryCommandAdmission | null;
}

// Historical insertion snapshot. It proves admission only, not current state,
// dispatch permission, freshness or convergence. Future claim must revalidate.
export type OrdinaryAdmissionBinding = Readonly<OrdinaryReservationCommand>;
