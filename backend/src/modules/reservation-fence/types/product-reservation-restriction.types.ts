import { ProductReservationRestrictionReason } from '@prisma/client';
import { createHash } from 'crypto';

declare const admissionBrand: unique symbol;
export type ProductRestrictionAdmission = { readonly [admissionBrand]: true };
export interface RestrictionObservationBinding {
  productId: string;
  reasonCategory: ProductReservationRestrictionReason;
  observationDigest: string;
}
export interface ProductRestrictionControl {
  version: 1;
  productId: string;
  state: 'ALLOW' | 'RESTRICTED';
  restrictionId: string | null;
  restrictionRevision: 0 | 1;
  incarnation: string;
  epoch: number;
}
export const productControlKey = (productId: string) => `reservation:fence:product-control:{${productId}}`;
export const restrictionDigest = (bytes: string) => createHash('sha256').update(bytes).digest('hex');
export const controlBytes = (value: ProductRestrictionControl): string => JSON.stringify({
  version: value.version, productId: value.productId, state: value.state,
  restrictionId: value.restrictionId, restrictionRevision: value.restrictionRevision,
  incarnation: value.incarnation, epoch: value.epoch,
});
