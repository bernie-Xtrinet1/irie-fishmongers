import { createHash, randomUUID, timingSafeEqual } from 'crypto';
import {
  BadRequestException,
  BadGatewayException,
  Injectable,
} from '@nestjs/common';
import { PaymentProviderName } from '@prisma/client';
import {
  PaymentCreateInput,
  PaymentCreateResult,
  PaymentProviderAdapter,
  PaymentRefundResult,
  PaymentVerifyResult,
} from '../interfaces/payment-provider.interface';

/**
 * Supported simulation scenarios for the isolated sandbox payment gateway.
 */
export enum SimulatorScenario {
  /** 1. Normal successful payment initiation */
  SUCCESS = 'SUCCESS',
  /** 2. Confirmed gateway rejection (e.g. card declined or invalid parameters) */
  CONFIRMED_REJECTION = 'CONFIRMED_REJECTION',
  /** 3. Network timeout during initiation */
  NETWORK_TIMEOUT = 'NETWORK_TIMEOUT',
  /** 4. Upstream HTTP 502 Bad Gateway response */
  HTTP_502 = 'HTTP_502',
  /** 5. Socket connection reset (ECONNRESET) */
  CONNECTION_RESET = 'CONNECTION_RESET',
  /** 6. Gateway accepts charge remotely but socket drops before returning 200 */
  GATEWAY_SUCCESS_LOST_RESPONSE = 'GATEWAY_SUCCESS_LOST_RESPONSE',
  /** 7. Initiation returns PENDING, settlement confirmation is delayed */
  DELAYED_CONFIRMATION = 'DELAYED_CONFIRMATION',
  /** 8. Duplicate payment notifications received */
  DUPLICATE_NOTIFICATIONS = 'DUPLICATE_NOTIFICATIONS',
  /** 9. Notifications delivered out-of-order or conflicting */
  OUT_OF_ORDER_NOTIFICATIONS = 'OUT_OF_ORDER_NOTIFICATIONS',
  /** 10. Gateway processes payment but no notification ever arrives */
  MISSING_NOTIFICATION = 'MISSING_NOTIFICATION',
  /** 11. Simulated verification or settlement failure */
  PAYMENT_FAILURE = 'PAYMENT_FAILURE',
  /** 12. Simulated refund outcome */
  REFUND_OUTCOME = 'REFUND_OUTCOME',
}

export interface SimulatedGatewayTransaction {
  orderId: string;
  amount: number;
  currency: string;
  customerEmail?: string;
  providerReference: string;
  redirectUrl?: string;
  status: 'PENDING' | 'PAID' | 'FAILED';
  acceptedRemotely: boolean;
  scenario: SimulatorScenario;
  createdAt: Date;
  updatedAt: Date;
}

export interface ScenarioOptions {
  errorMessage?: string;
  verifyStatus?: 'PENDING' | 'PAID' | 'FAILED';
  refundStatus?: 'PENDING' | 'COMPLETED' | 'FAILED';
}

export interface SimulatorCallRecord {
  method: 'createPayment' | 'verifyPayment' | 'refundPayment';
  input: unknown;
  timestamp: Date;
  scenario: SimulatorScenario;
  outcome: 'RESOLVED' | 'REJECTED';
}

export const SIMULATOR_DEFAULT_API_KEY = 'sandbox-sim-test-api-key-32chars!!';

/**
 * Deterministic, isolated in-memory payment gateway simulator.
 * Implements PaymentProviderAdapter without making any external network calls
 * or requiring real merchant credentials.
 */
@Injectable()
export class SandboxPaymentGatewaySimulator implements PaymentProviderAdapter {
  readonly name: PaymentProviderName;

  private defaultScenario: SimulatorScenario = SimulatorScenario.SUCCESS;
  private defaultOptions: ScenarioOptions = {};

  private readonly queuedScenarios: Array<{
    scenario: SimulatorScenario;
    options: ScenarioOptions;
  }> = [];

  private readonly orderScenarios = new Map<
    string,
    { scenario: SimulatorScenario; options: ScenarioOptions }
  >();

  private readonly transactions = new Map<string, SimulatedGatewayTransaction>();
  private readonly transactionsByOrderId = new Map<string, SimulatedGatewayTransaction>();
  private readonly callHistory: SimulatorCallRecord[] = [];

  private apiKey: string = SIMULATOR_DEFAULT_API_KEY;

  constructor(providerName: PaymentProviderName = PaymentProviderName.WIPAY) {
    this.name = providerName;
  }

  setApiKey(key: string): void {
    this.apiKey = key;
  }

  setScenario(scenario: SimulatorScenario, options: ScenarioOptions = {}): void {
    this.defaultScenario = scenario;
    this.defaultOptions = options;
  }

  queueScenario(scenario: SimulatorScenario, options: ScenarioOptions = {}): void {
    this.queuedScenarios.push({ scenario, options });
  }

  setOrderScenario(
    orderId: string,
    scenario: SimulatorScenario,
    options: ScenarioOptions = {},
  ): void {
    this.orderScenarios.set(orderId, { scenario, options });
  }

  private resolveActiveScenario(orderId?: string): {
    scenario: SimulatorScenario;
    options: ScenarioOptions;
  } {
    if (orderId && this.orderScenarios.has(orderId)) {
      const specific = this.orderScenarios.get(orderId)!;
      return specific;
    }
    if (this.queuedScenarios.length > 0) {
      return this.queuedScenarios.shift()!;
    }
    return { scenario: this.defaultScenario, options: this.defaultOptions };
  }

  async createPayment(input: PaymentCreateInput): Promise<PaymentCreateResult> {
    const { scenario, options } = this.resolveActiveScenario(input.orderId);
    const now = new Date();
    const providerReference = `sim-ref-${input.orderId}`;
    const redirectUrl = `https://jmsb.wipayfinancial.com/test-checkout/${providerReference}`;

    switch (scenario) {
      case SimulatorScenario.CONFIRMED_REJECTION: {
        this.recordCall('createPayment', input, scenario, 'REJECTED');
        throw new BadRequestException(
          options.errorMessage ?? 'WiPay gateway confirmed rejection: card declined or invalid parameters',
        );
      }

      case SimulatorScenario.NETWORK_TIMEOUT: {
        this.recordCall('createPayment', input, scenario, 'REJECTED');
        throw new Error(
          options.errorMessage ?? 'WiPay gateway socket timeout after 10000ms',
        );
      }

      case SimulatorScenario.HTTP_502: {
        this.recordCall('createPayment', input, scenario, 'REJECTED');
        throw new BadGatewayException(
          options.errorMessage ?? 'WiPay gateway 502 Bad Gateway',
        );
      }

      case SimulatorScenario.CONNECTION_RESET: {
        this.recordCall('createPayment', input, scenario, 'REJECTED');
        throw new Error(
          options.errorMessage ?? 'read ECONNRESET',
        );
      }

      case SimulatorScenario.GATEWAY_SUCCESS_LOST_RESPONSE: {
        // The gateway created the record remotely, but socket terminated before response
        const txn: SimulatedGatewayTransaction = {
          orderId: input.orderId,
          amount: input.amount,
          currency: input.currency,
          customerEmail: input.customerEmail,
          providerReference,
          redirectUrl,
          status: 'PENDING',
          acceptedRemotely: true,
          scenario,
          createdAt: now,
          updatedAt: now,
        };
        this.transactions.set(providerReference, txn);
        this.transactionsByOrderId.set(input.orderId, txn);

        this.recordCall('createPayment', input, scenario, 'REJECTED');
        throw new Error(
          options.errorMessage ?? 'Connection terminated unexpectedly after POST',
        );
      }

      case SimulatorScenario.PAYMENT_FAILURE: {
        const txn: SimulatedGatewayTransaction = {
          orderId: input.orderId,
          amount: input.amount,
          currency: input.currency,
          customerEmail: input.customerEmail,
          providerReference,
          redirectUrl,
          status: 'FAILED',
          acceptedRemotely: false,
          scenario,
          createdAt: now,
          updatedAt: now,
        };
        this.transactions.set(providerReference, txn);
        this.transactionsByOrderId.set(input.orderId, txn);

        this.recordCall('createPayment', input, scenario, 'RESOLVED');
        return {
          providerReference,
          redirectUrl,
          status: 'PENDING',
        };
      }

      case SimulatorScenario.SUCCESS:
      case SimulatorScenario.DELAYED_CONFIRMATION:
      case SimulatorScenario.DUPLICATE_NOTIFICATIONS:
      case SimulatorScenario.OUT_OF_ORDER_NOTIFICATIONS:
      case SimulatorScenario.MISSING_NOTIFICATION:
      case SimulatorScenario.REFUND_OUTCOME:
      default: {
        const txn: SimulatedGatewayTransaction = {
          orderId: input.orderId,
          amount: input.amount,
          currency: input.currency,
          customerEmail: input.customerEmail,
          providerReference,
          redirectUrl,
          status: 'PENDING',
          acceptedRemotely: true,
          scenario,
          createdAt: now,
          updatedAt: now,
        };
        this.transactions.set(providerReference, txn);
        this.transactionsByOrderId.set(input.orderId, txn);

        this.recordCall('createPayment', input, scenario, 'RESOLVED');
        return {
          providerReference,
          redirectUrl,
          status: 'PENDING',
        };
      }
    }
  }

  async verifyPayment(providerReference: string): Promise<PaymentVerifyResult> {
    const { scenario, options } = this.resolveActiveScenario();
    this.recordCall('verifyPayment', providerReference, scenario, 'RESOLVED');

    const txn = this.transactions.get(providerReference);

    if (scenario === SimulatorScenario.PAYMENT_FAILURE) {
      return {
        providerReference,
        status: 'FAILED',
      };
    }

    if (options.verifyStatus) {
      return {
        providerReference,
        status: options.verifyStatus,
      };
    }

    return {
      providerReference,
      status: txn ? txn.status : 'PENDING',
    };
  }

  async refundPayment(
    providerReference: string,
    amount: number,
    reason: string,
  ): Promise<PaymentRefundResult> {
    const { scenario, options } = this.resolveActiveScenario();
    const outcome = options.refundStatus ?? 'COMPLETED';

    this.recordCall('refundPayment', { providerReference, amount, reason }, scenario, 'RESOLVED');

    return {
      providerReference: `sim-refund-${randomUUID()}`,
      status: outcome,
    };
  }

  /**
   * Authoritatively verifies transaction response hashes (MD5) matching WiPay's verification algorithm.
   */
  verifyTransactionResponse(
    payload: Record<string, unknown>,
    providerReference: string,
    originalTotal: string,
  ): boolean {
    if (
      payload.status !== 'success' ||
      payload.transaction_id !== providerReference ||
      !providerReference ||
      !/^\d+\.\d{2}$/.test(originalTotal) ||
      typeof payload.hash !== 'string' ||
      !/^[a-fA-F0-9]{32}$/.test(payload.hash)
    ) {
      return false;
    }

    const expected = createHash('md5')
      .update(providerReference + originalTotal + this.apiKey)
      .digest();

    return timingSafeEqual(expected, Buffer.from(payload.hash, 'hex'));
  }

  settleTransaction(providerReference: string, status: 'PAID' | 'FAILED'): void {
    const txn = this.transactions.get(providerReference);
    if (txn) {
      txn.status = status;
      txn.updatedAt = new Date();
    }
  }

  getTransaction(providerReference: string): SimulatedGatewayTransaction | undefined {
    return this.transactions.get(providerReference);
  }

  getTransactionByOrderId(orderId: string): SimulatedGatewayTransaction | undefined {
    return this.transactionsByOrderId.get(orderId);
  }

  getAllTransactions(): SimulatedGatewayTransaction[] {
    return Array.from(this.transactions.values());
  }

  getCallHistory(): SimulatorCallRecord[] {
    return [...this.callHistory];
  }

  getCallCount(method?: 'createPayment' | 'verifyPayment' | 'refundPayment'): number {
    if (!method) return this.callHistory.length;
    return this.callHistory.filter((c) => c.method === method).length;
  }

  reset(): void {
    this.defaultScenario = SimulatorScenario.SUCCESS;
    this.defaultOptions = {};
    this.queuedScenarios.length = 0;
    this.orderScenarios.clear();
    this.transactions.clear();
    this.transactionsByOrderId.clear();
    this.callHistory.length = 0;
  }

  private recordCall(
    method: 'createPayment' | 'verifyPayment' | 'refundPayment',
    input: unknown,
    scenario: SimulatorScenario,
    outcome: 'RESOLVED' | 'REJECTED',
  ): void {
    this.callHistory.push({
      method,
      input,
      timestamp: new Date(),
      scenario,
      outcome,
    });
  }
}
