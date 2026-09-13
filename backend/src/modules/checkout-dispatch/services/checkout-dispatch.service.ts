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
import { CheckoutAcquisitionService } from '../../checkout/services/checkout-acquisition.service';
import { CheckoutFailureSettlementService } from '../../checkout/services/checkout-failure-settlement.service';

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
    private readonly acquisition: CheckoutAcquisitionService,
    private readonly failureSettlement: CheckoutFailureSettlementService,
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
      if (existing.action !== 'NOT_FOUND') {
        if (existing.action === 'RESUMED_PROCESSING' && this.consistent(operation, existing.attempt) &&
          operation.selectedPath === 'CART_SCOPED' && operation.reservationExecutionEpoch !== null &&
          operation.reservationCapabilityState === 'ACTIVE') return await this.executeAcquisition(operation, input);
        return await this.replay(operation, existing);
      }

      const admitted = await this.admission.admit({
        customerId: input.customerId,
        cartId: input.cartId,
        operationId: operation.id,
      });
      if (!admitted.ok) return admitted;
      const { decision } = admitted;
      if (
        admitted.operation.id !== operation.id ||
        admitted.operation.customerId !== input.customerId ||
        admitted.operation.cartId !== input.cartId ||
        admitted.operation.operationKey !== operation.operationKey ||
        (operation.selectedPath !== null &&
          operation.selectedPath !== admitted.operation.selectedPath)
      )
        return { ok: false, code: 'PATH_MISMATCH' };
      operation = admitted.operation;
      if (decision === 'EXISTING_ATTEMPT')
        return await this.replay(
          operation,
          await this.attempts.inspectByIdempotencyKey(input.customerId, operation.operationKey),
        );
      if (decision === 'SHADOW') {
        if (admitted.durable || operation.selectedPath !== null)
          return { ok: false, code: 'PATH_MISMATCH' };
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
      if (
        !admitted.durable ||
        operation.selectedPath !== decision ||
        !['LEGACY', 'CART_SCOPED'].includes(decision)
      )
        return { ok: false, code: 'PATH_MISMATCH' };
      if (decision === 'LEGACY')
        return { ok: true, order: await this.orders.checkout(input.customerId, input.dto) };

      return await this.executeAcquisition(operation, input);
    } catch {
      return { ok: false, code: 'UNAVAILABLE' };
    }
  }

  private async executeAcquisition(operation: CheckoutOperation, input: CheckoutDispatchInput): Promise<CheckoutDispatchResult> {
    if (operation.reservationExecutionEpoch === null || operation.reservationCapabilityState !== 'ACTIVE')
      return { ok: false, code: 'PATH_MISMATCH' };
    const prepared = await this.operations.prepare(input.customerId, operation.id, input.now);
    if (!prepared.ok) return { ok: false, code: 'RECONFIRM_REQUIRED' };
    const acquired = await this.acquisition.acquire(input.customerId, operation.id);
    if (!acquired.ok) return acquired;
    const result = await this.coordinator.checkoutAcquired(
      input.customerId,
      operation.operationKey,
      input.dto,
      input.now,
      acquired.evidence,
      this.failureSettlement,
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
    if (existing.action === 'ALREADY_FAILED') {
      if (operation.selectedPath === 'CART_SCOPED' && operation.reservationExecutionEpoch !== null) {
        const settlement = await this.failureSettlement.continue(operation.customerId, operation.id);
        if (settlement.code !== 'SETTLED') return { ok: false, code: settlement.code };
      }
      return {
        ok: false,
        code: 'CHECKOUT_ALREADY_FAILED',
        failureCode: existing.attempt.failureCode,
      };
    }
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
