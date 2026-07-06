import { PaymentResponseEntity } from './payment-response.entity';

export interface PaymentInitiationResponseEntity {
  payment: PaymentResponseEntity;
  redirectUrl?: string;
}
