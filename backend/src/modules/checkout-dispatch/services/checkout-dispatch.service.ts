import { Injectable } from '@nestjs/common';
import { CheckoutOperation } from '@prisma/client';
import { isUUID, validateSync } from 'class-validator';
import { CheckoutOperationService } from '../../checkout-operation/services/checkout-operation.service';
import { CheckoutAttemptService } from '../../checkout-attempt/services/checkout-attempt.service';
import {
  CheckoutAttemptSummary,
  InspectCheckoutAttemptResult,
} from '../../checkout-attempt/types/checkout-attempt.types';
import { CheckoutCoordinatorService } from '../../checkout/services/checkout-coordinator.service';
import { CheckoutCoordinatorResult } from '../../checkout/types/checkout-coordinator.types';
import { OrdersService } from '../../orders/services/orders.service';
import { CheckoutDto } from '../../orders/dto/checkout.dto';
import { OrderResponseEntity } from '../../orders/entities/order-response.entity';
import { CheckoutShadowComparisonService } from '../../checkout-shadow/services/checkout-shadow-comparison.service';
import { CheckoutAdmissionService } from './checkout-admission.service';

export interface CheckoutDispatchInput {
  customerId: string;
  cartId: string;
  retryKey: string;
  dto: CheckoutDto;
  now: Date;
}
export type CheckoutDispatchResult =
  | CheckoutCoordinatorResult
  | { ok: true; order: OrderResponseEntity }
  | {
      ok: false;
      code:
        | 'INVALID_INPUT'
        | 'OPERATION_REJECTED'
        | 'PATH_MISMATCH'
        | 'ADMISSION_DENIED'
        | 'UNAVAILABLE'
        | 'RECONFIRM_REQUIRED';
    };

@Injectable()
export class CheckoutDispatchService {
  constructor(
    private readonly operations: CheckoutOperationService,
    private readonly attempts: CheckoutAttemptService,
    private readonly coordinator: CheckoutCoordinatorService,
    private readonly orders: OrdersService,
    private readonly admission: CheckoutAdmissionService,
    private readonly shadow: CheckoutShadowComparisonService,
  ) {}

  async checkout(input: CheckoutDispatchInput): Promise<CheckoutDispatchResult> {
    if (!this.validInput(input)) return { ok: false, code: 'INVALID_INPUT' };
    try {
      const issued = await this.operations.issue({
        customerId: input.customerId,
        cartId: input.cartId,
        retryKey: input.retryKey,
      });
      if (!issued.ok) return { ok: false, code: 'OPERATION_REJECTED' };
      let operation = issued.operation;
      if (operation.customerId !== input.customerId || operation.cartId !== input.cartId)
        return { ok: false, code: 'PATH_MISMATCH' };
      // Mandatory ordering: a committed checkout may already have cleared its
      // cart. Resolve all existing attempt states BEFORE policy or preparation.
      const existing = await this.attempts.inspectByIdempotencyKey(
        input.customerId,
        operation.operationKey,
      );
      if (existing.action !== 'NOT_FOUND') return await this.replay(operation, existing);

      const decision = await this.admission.decide({
        customerId: input.customerId,
        cartId: input.cartId,
      });
      if (decision === 'DENY') return { ok: false, code: 'ADMISSION_DENIED' };
      if (!['LEGACY', 'CART_SCOPED', 'SHADOW'].includes(decision))
        return { ok: false, code: 'UNAVAILABLE' };
      const executablePath = decision === 'SHADOW' ? 'LEGACY' : decision;
      if (operation.selectedPath !== null && operation.selectedPath !== executablePath)
        return { ok: false, code: 'PATH_MISMATCH' };
      if (decision === 'SHADOW') {
        try {
          await this.shadow.compare({
            authenticatedCustomerId: input.customerId,
            cartId: input.cartId,
          });
        } catch {
          /* Observation is never execution authority. */
        }
        return { ok: true, order: await this.orders.checkout(input.customerId, input.dto) };
      }
      const assigned = await this.operations.assignPath(input.customerId, operation.id, decision);
      if (!assigned.ok) return { ok: false, code: 'PATH_MISMATCH' };
      operation = assigned.operation;
      if (operation.selectedPath !== decision) return { ok: false, code: 'PATH_MISMATCH' };
      if (decision === 'LEGACY')
        return { ok: true, order: await this.orders.checkout(input.customerId, input.dto) };

      const prepared = await this.operations.prepare(input.customerId, operation.id, input.now);
      if (!prepared.ok) return { ok: false, code: 'RECONFIRM_REQUIRED' };
      const result = await this.coordinator.checkout(
        input.customerId,
        operation.operationKey,
        input.dto,
        input.now,
      );
      const after = await this.attempts.inspectByIdempotencyKey(
        input.customerId,
        operation.operationKey,
      );
      if (after.action === 'NOT_FOUND')
        return result.ok ? { ok: false, code: 'PATH_MISMATCH' } : result;
      if (!('attempt' in after) || !this.consistent(operation, after.attempt))
        return { ok: false, code: 'PATH_MISMATCH' };
      if (
        result.ok &&
        (after.attempt.status !== 'COMMITTED' || after.attempt.orderId !== result.order.id)
      )
        return { ok: false, code: 'PATH_MISMATCH' };
      return result;
    } catch {
      return { ok: false, code: 'UNAVAILABLE' };
    }
  }

  private consistent(operation: CheckoutOperation, attempt: CheckoutAttemptSummary): boolean {
    return (
      attempt.customerId === operation.customerId &&
      attempt.cartId === operation.cartId &&
      attempt.idempotencyKey === operation.operationKey &&
      (attempt.selectedPath === 'LEGACY' || attempt.selectedPath === 'CART_SCOPED') &&
      operation.selectedPath === attempt.selectedPath
    );
  }

  private async replay(
    operation: CheckoutOperation,
    existing: InspectCheckoutAttemptResult,
  ): Promise<CheckoutDispatchResult> {
    if (!('attempt' in existing) || !this.consistent(operation, existing.attempt))
      return { ok: false, code: 'PATH_MISMATCH' };
    if (existing.action === 'RESUMED_PROCESSING')
      return { ok: false, code: 'CHECKOUT_ALREADY_IN_PROGRESS' };
    if (existing.action === 'ALREADY_FAILED')
      return {
        ok: false,
        code: 'CHECKOUT_ALREADY_FAILED',
        failureCode: existing.attempt.failureCode,
      };
    if (existing.action !== 'ALREADY_COMMITTED' || !existing.attempt.orderId)
      return { ok: false, code: 'PATH_MISMATCH' };
    // Same read-only order boundary used by the coordinator's committed replay.
    return {
      ok: true,
      order: await this.orders.getCustomerOrderById(operation.customerId, existing.attempt.orderId),
    };
  }

  private validInput(input: CheckoutDispatchInput): boolean {
    if (
      !input ||
      Object.keys(input).some(
        (key) => !['customerId', 'cartId', 'retryKey', 'dto', 'now'].includes(key),
      ) ||
      !isUUID(input.customerId) ||
      !isUUID(input.cartId) ||
      typeof input.retryKey !== 'string' ||
      !(input.now instanceof Date) ||
      !Number.isFinite(input.now.getTime()) ||
      !input.dto ||
      typeof input.dto !== 'object' ||
      Array.isArray(input.dto)
    )
      return false;
    if (
      Object.keys(input.dto).some(
        (key) =>
          ![
            'deliveryAddressLine1',
            'deliveryAddressLine2',
            'deliveryParish',
            'deliveryPhone',
            'paymentMethod',
          ].includes(key),
      )
    )
      return false;
    return validateSync(Object.assign(new CheckoutDto(), input.dto)).length === 0;
  }
}
