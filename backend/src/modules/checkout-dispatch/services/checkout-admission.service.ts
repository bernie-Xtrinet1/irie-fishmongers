import { Injectable } from '@nestjs/common';

export type CheckoutAdmissionDecision = 'LEGACY' | 'CART_SCOPED' | 'SHADOW' | 'DENY';
export interface CheckoutAdmissionContext {
  customerId: string;
  cartId: string;
}

// Future server-side adapter boundary, not an HTTP DTO or participant evaluator.
export abstract class CheckoutAdmissionService {
  abstract decide(context: CheckoutAdmissionContext): Promise<CheckoutAdmissionDecision>;
}

@Injectable()
export class InactiveCheckoutAdmissionService extends CheckoutAdmissionService {
  decide(_context: CheckoutAdmissionContext): Promise<CheckoutAdmissionDecision> {
    return Promise.resolve('LEGACY');
  }
}
