import { createHash, randomUUID } from 'crypto';
import { SIMULATOR_DEFAULT_API_KEY } from './sandbox-payment-gateway.simulator';

export interface WiPayEventPayload {
  status: 'success' | 'failed' | 'error';
  transaction_id: string;
  order_id?: string;
  total?: string;
  hash?: string;
  date?: string;
  [key: string]: unknown;
}

export interface DeliveredEventRecord {
  id: string;
  eventType: 'SUCCESS' | 'FAILED' | 'DUPLICATE' | 'DELAYED' | 'OUT_OF_ORDER' | 'CONFLICTING';
  payload: WiPayEventPayload;
  deliveredAt: Date;
  dispatchIndex: number;
}

/**
 * Isolated, test-only event delivery mechanism capable of generating and recording
 * settlement notifications across various edge cases (success, failed, duplicate, delayed,
 * out-of-order, conflicting).
 *
 * Isolated from production HTTP routes; never exposes a live webhook endpoint.
 */
export class PaymentEventDeliveryHarness {
  private readonly deliveredEvents: DeliveredEventRecord[] = [];
  private apiKey: string = SIMULATOR_DEFAULT_API_KEY;

  constructor(apiKey?: string) {
    if (apiKey) {
      this.apiKey = apiKey;
    }
  }

  setApiKey(key: string): void {
    this.apiKey = key;
  }

  computeHash(transactionId: string, total: string): string {
    return createHash('md5')
      .update(transactionId + total + this.apiKey)
      .digest('hex');
  }

  createSuccessSettlementEvent(params: {
    transactionId: string;
    orderId?: string;
    amount: string; // Must be normalized to 2 decimal places e.g. "1200.00"
  }): WiPayEventPayload {
    const hash = this.computeHash(params.transactionId, params.amount);
    return {
      status: 'success',
      transaction_id: params.transactionId,
      order_id: params.orderId,
      total: params.amount,
      hash,
      date: new Date().toISOString(),
    };
  }

  createFailedPaymentEvent(params: {
    transactionId: string;
    orderId?: string;
  }): WiPayEventPayload {
    return {
      status: 'failed',
      transaction_id: params.transactionId,
      order_id: params.orderId,
      date: new Date().toISOString(),
    };
  }

  createDuplicateNotifications(
    event: WiPayEventPayload,
    count = 2,
  ): WiPayEventPayload[] {
    const duplicates: WiPayEventPayload[] = [];
    for (let i = 0; i < count; i++) {
      duplicates.push({ ...event });
    }
    return duplicates;
  }

  createDelayedNotification(
    event: WiPayEventPayload,
    delayMs: number,
  ): { payload: WiPayEventPayload; deliverAt: Date; delayMs: number } {
    return {
      payload: { ...event },
      deliverAt: new Date(Date.now() + delayMs),
      delayMs,
    };
  }

  createOutOfOrderNotifications(params: {
    transactionId: string;
    orderId?: string;
    amount: string;
  }): WiPayEventPayload[] {
    // Generates an out-of-order sequence: refund/unverified event first, then the success settlement event
    const failureEvent: WiPayEventPayload = {
      status: 'error',
      transaction_id: params.transactionId,
      order_id: params.orderId,
      date: new Date().toISOString(),
    };
    const successEvent = this.createSuccessSettlementEvent(params);
    return [failureEvent, successEvent];
  }

  createConflictingNotifications(params: {
    transactionId: string;
    orderId?: string;
    amountA: string;
    amountB: string;
  }): [WiPayEventPayload, WiPayEventPayload] {
    const eventA = this.createSuccessSettlementEvent({
      transactionId: params.transactionId,
      orderId: params.orderId,
      amount: params.amountA,
    });
    // Event B has conflicting amount and mismatched hash
    const eventB: WiPayEventPayload = {
      status: 'success',
      transaction_id: params.transactionId,
      order_id: params.orderId,
      total: params.amountB,
      hash: this.computeHash(params.transactionId, params.amountB),
      date: new Date().toISOString(),
    };
    return [eventA, eventB];
  }

  async deliver(
    eventType: DeliveredEventRecord['eventType'],
    payload: WiPayEventPayload,
    handler?: (payload: Record<string, unknown>) => Promise<unknown>,
  ): Promise<unknown> {
    const record: DeliveredEventRecord = {
      id: randomUUID(),
      eventType,
      payload,
      deliveredAt: new Date(),
      dispatchIndex: this.deliveredEvents.length + 1,
    };
    this.deliveredEvents.push(record);

    if (handler) {
      return handler(payload);
    }
    return undefined;
  }

  getDeliveredEvents(): DeliveredEventRecord[] {
    return [...this.deliveredEvents];
  }

  getDeliveredEventsByTransactionId(transactionId: string): DeliveredEventRecord[] {
    return this.deliveredEvents.filter((e) => e.payload.transaction_id === transactionId);
  }

  clear(): void {
    this.deliveredEvents.length = 0;
  }
}
