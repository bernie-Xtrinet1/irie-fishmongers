import { Injectable } from '@nestjs/common';
import { CheckoutOperation } from '@prisma/client';

export type CheckoutAdmissionDecision = 'LEGACY' | 'CART_SCOPED' | 'SHADOW' | 'DENY';
export interface CheckoutAdmissionContext {
  customerId: string;
  cartId: string;
  operationId: string;
}

export type CheckoutAdmissionResult =
  | { ok: true; decision: 'LEGACY' | 'CART_SCOPED'; operation: CheckoutOperation; durable: true }
  | { ok: true; decision: 'SHADOW'; operation: CheckoutOperation; durable: false }
  | { ok: true; decision: 'EXISTING_ATTEMPT'; operation: CheckoutOperation; durable: true }
  | { ok: false; code: 'ADMISSION_DENIED' | 'UNAVAILABLE' | 'PATH_MISMATCH' };

// Future server-side adapter boundary, not an HTTP DTO or participant evaluator.
export abstract class CheckoutAdmissionService {
  abstract admit(context: CheckoutAdmissionContext): Promise<CheckoutAdmissionResult>;
}

@Injectable()
export class InactiveCheckoutAdmissionService extends CheckoutAdmissionService {
  admit(_context: CheckoutAdmissionContext): Promise<CheckoutAdmissionResult> {
    // A detached/default provider cannot grant executable ownership.
    return Promise.resolve({ ok: false, code: 'UNAVAILABLE' });
  }
}
