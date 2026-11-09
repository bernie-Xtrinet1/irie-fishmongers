import { Injectable, Logger } from '@nestjs/common';
import {
  PaymentProviderName,
  PaymentSettlementEvent,
  PaymentSettlementReceipt,
  PaymentStatus,
  Prisma,
  RefundStatus,
  SettlementDisposition,
  VendorOrderStatus,
} from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';
import {
  ApplyPaymentSettlementCommand,
  SettlementExecutionResult,
} from '../types/payment-settlement.types';

export interface RecordReceiptInput {
  provider: PaymentProviderName;
  merchantAccountId: string;
  eventId: string;
  gatewayTxnId: string;
  disposition: SettlementDisposition;
  sourceIp?: string | null;
  signatureValid?: boolean;
}

@Injectable()
export class PaymentSettlementRepository {
  private readonly logger = new Logger(PaymentSettlementRepository.name);

  constructor(private readonly prisma: PrismaService) {}

  async recordReceipt(
    input: RecordReceiptInput,
    tx?: Prisma.TransactionClient,
  ): Promise<PaymentSettlementReceipt> {
    const client = tx ?? this.prisma;
    return client.paymentSettlementReceipt.create({
      data: {
        provider: input.provider,
        merchantAccountId: input.merchantAccountId,
        eventId: input.eventId,
        gatewayTxnId: input.gatewayTxnId,
        disposition: input.disposition,
        sourceIp: input.sourceIp ?? null,
        signatureValid: input.signatureValid ?? false,
      },
    });
  }

  async findEventByIdentity(
    provider: PaymentProviderName,
    merchantAccountId: string,
    eventId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<PaymentSettlementEvent | null> {
    const client = tx ?? this.prisma;
    return client.paymentSettlementEvent.findUnique({
      where: {
        provider_merchantAccountId_eventId: {
          provider,
          merchantAccountId,
          eventId,
        },
      },
    });
  }

  async executeSettlementTransaction(
    command: ApplyPaymentSettlementCommand,
  ): Promise<SettlementExecutionResult> {
    return this.prisma.$transaction(
      async (tx) => {
        // --- CANONICAL PESSIMISTIC LOCK SEQUENCE ---
        // 1. Lock the order parent row
        const orderRows = await tx.$queryRaw<{ id: string }[]>(
          Prisma.sql`SELECT "id" FROM "orders" WHERE "id" = ${command.orderId} FOR UPDATE`,
        );
        if (orderRows.length === 0) {
          throw new Error(`Order not found: ${command.orderId}`);
        }

        // 2. Lock the vendor_orders child rows in deterministic ascending ID order
        const vendorOrders = await tx.$queryRaw<{ id: string; status: VendorOrderStatus }[]>(
          Prisma.sql`SELECT "id", "status" FROM "vendor_orders" WHERE "orderId" = ${command.orderId} ORDER BY "id" ASC FOR UPDATE`,
        );

        // 3. Lock the payment row
        const paymentRows = await tx.$queryRaw<{
          id: string;
          orderId: string;
          provider: PaymentProviderName;
          merchantAccountId: string;
          status: PaymentStatus;
          amount: Prisma.Decimal;
          currency: string;
          providerReference: string | null;
        }[]>(
          Prisma.sql`SELECT "id", "orderId", "provider", "merchantAccountId", "status", "amount", "currency", "providerReference" FROM "payments" WHERE "id" = ${command.paymentId} FOR UPDATE`,
        );
        if (paymentRows.length === 0) {
          throw new Error(`Payment not found: ${command.paymentId}`);
        }
        const currentPayment = paymentRows[0]!;

        // 4. Invariant and Correlation Checks
        // A. Order Ownership
        if (currentPayment.orderId !== command.orderId) {
          const receipt = await this.recordReceipt(
            {
              provider: command.provider,
              merchantAccountId: command.merchantAccountId,
              eventId: command.eventId,
              gatewayTxnId: command.gatewayTxnId,
              disposition: SettlementDisposition.CONFLICT_REJECTED,
              sourceIp: command.evidence.sourceIp,
              signatureValid: command.evidence.signatureValid ?? false,
            },
            tx,
          );
          return {
            applied: false,
            disposition: SettlementDisposition.CONFLICT_REJECTED,
            paymentId: currentPayment.id,
            orderId: currentPayment.orderId,
            resultingPaymentStatus: currentPayment.status,
            receiptId: receipt.id,
            message: `Correlation mismatch: payment belongs to order ${currentPayment.orderId}, not ${command.orderId}`,
          };
        }

        // B. Provider Identity Enforcement (F-02 Correction)
        if (currentPayment.provider !== command.provider) {
          const receipt = await this.recordReceipt(
            {
              provider: command.provider,
              merchantAccountId: command.merchantAccountId,
              eventId: command.eventId,
              gatewayTxnId: command.gatewayTxnId,
              disposition: SettlementDisposition.CONFLICT_REJECTED,
              sourceIp: command.evidence.sourceIp,
              signatureValid: command.evidence.signatureValid ?? false,
            },
            tx,
          );
          return {
            applied: false,
            disposition: SettlementDisposition.CONFLICT_REJECTED,
            paymentId: currentPayment.id,
            orderId: currentPayment.orderId,
            resultingPaymentStatus: currentPayment.status,
            receiptId: receipt.id,
            message: `Provider mismatch: payment is assigned to provider ${currentPayment.provider}, not ${command.provider}`,
          };
        }

        // C. Merchant Account Isolation
        if (currentPayment.merchantAccountId !== command.merchantAccountId) {
          const receipt = await this.recordReceipt(
            {
              provider: command.provider,
              merchantAccountId: command.merchantAccountId,
              eventId: command.eventId,
              gatewayTxnId: command.gatewayTxnId,
              disposition: SettlementDisposition.CONFLICT_REJECTED,
              sourceIp: command.evidence.sourceIp,
              signatureValid: command.evidence.signatureValid ?? false,
            },
            tx,
          );
          return {
            applied: false,
            disposition: SettlementDisposition.CONFLICT_REJECTED,
            paymentId: currentPayment.id,
            orderId: currentPayment.orderId,
            resultingPaymentStatus: currentPayment.status,
            receiptId: receipt.id,
            message: `Merchant isolation mismatch: payment is assigned to ${currentPayment.merchantAccountId}, not ${command.merchantAccountId}`,
          };
        }

        // D. Provider Reference Protection (F-03 Correction)
        // If an established reference is non-null and conflicts with incoming authoritative reference, reject settlement.
        // If it matches, preserve it. If null, permit initial binding.
        if (
          currentPayment.providerReference !== null &&
          currentPayment.providerReference !== undefined &&
          currentPayment.providerReference !== command.gatewayTxnId
        ) {
          const receipt = await this.recordReceipt(
            {
              provider: command.provider,
              merchantAccountId: command.merchantAccountId,
              eventId: command.eventId,
              gatewayTxnId: command.gatewayTxnId,
              disposition: SettlementDisposition.CONFLICT_REJECTED,
              sourceIp: command.evidence.sourceIp,
              signatureValid: command.evidence.signatureValid ?? false,
            },
            tx,
          );
          return {
            applied: false,
            disposition: SettlementDisposition.CONFLICT_REJECTED,
            paymentId: currentPayment.id,
            orderId: currentPayment.orderId,
            resultingPaymentStatus: currentPayment.status,
            receiptId: receipt.id,
            message: `Conflicting provider reference: payment already established with reference ${currentPayment.providerReference}, incoming reference is ${command.gatewayTxnId}`,
          };
        }

        // E. Currency Matching
        if (currentPayment.currency.toUpperCase() !== command.currency.toUpperCase()) {
          const receipt = await this.recordReceipt(
            {
              provider: command.provider,
              merchantAccountId: command.merchantAccountId,
              eventId: command.eventId,
              gatewayTxnId: command.gatewayTxnId,
              disposition: SettlementDisposition.CONFLICT_REJECTED,
              sourceIp: command.evidence.sourceIp,
              signatureValid: command.evidence.signatureValid ?? false,
            },
            tx,
          );
          return {
            applied: false,
            disposition: SettlementDisposition.CONFLICT_REJECTED,
            paymentId: currentPayment.id,
            orderId: currentPayment.orderId,
            resultingPaymentStatus: currentPayment.status,
            receiptId: receipt.id,
            message: `Currency mismatch: payment currency is ${currentPayment.currency}, incoming is ${command.currency}`,
          };
        }

        // F. Exact Decimal Amount Matching
        const commandAmountDecimal = new Prisma.Decimal(command.amount);
        if (!commandAmountDecimal.equals(currentPayment.amount)) {
          const receipt = await this.recordReceipt(
            {
              provider: command.provider,
              merchantAccountId: command.merchantAccountId,
              eventId: command.eventId,
              gatewayTxnId: command.gatewayTxnId,
              disposition: SettlementDisposition.CONFLICT_REJECTED,
              sourceIp: command.evidence.sourceIp,
              signatureValid: command.evidence.signatureValid ?? false,
            },
            tx,
          );
          return {
            applied: false,
            disposition: SettlementDisposition.CONFLICT_REJECTED,
            paymentId: currentPayment.id,
            orderId: currentPayment.orderId,
            resultingPaymentStatus: currentPayment.status,
            receiptId: receipt.id,
            message: `Amount mismatch: payment expected ${currentPayment.amount.toString()}, incoming is ${commandAmountDecimal.toString()}`,
          };
        }

        // G. Optional Checkout Attempt Ownership Correlation
        if (command.checkoutAttemptId) {
          const attemptRows = await tx.$queryRaw<{ id: string; orderId: string }[]>(
            Prisma.sql`SELECT "id", "orderId" FROM "checkout_attempts" WHERE "id" = ${command.checkoutAttemptId}`,
          );
          if (attemptRows.length > 0 && attemptRows[0]!.orderId !== command.orderId) {
            const receipt = await this.recordReceipt(
              {
                provider: command.provider,
                merchantAccountId: command.merchantAccountId,
                eventId: command.eventId,
                gatewayTxnId: command.gatewayTxnId,
                disposition: SettlementDisposition.CONFLICT_REJECTED,
                sourceIp: command.evidence.sourceIp,
                signatureValid: command.evidence.signatureValid ?? false,
              },
              tx,
            );
            return {
              applied: false,
              disposition: SettlementDisposition.CONFLICT_REJECTED,
              paymentId: currentPayment.id,
              orderId: currentPayment.orderId,
              resultingPaymentStatus: currentPayment.status,
              receiptId: receipt.id,
              message: `Checkout attempt mismatch: attempt ${command.checkoutAttemptId} does not belong to order ${command.orderId}`,
            };
          }
        }

        // 5. Existing Event Check (Idempotency & Immutability Guard)
        const existingEvent = await tx.paymentSettlementEvent.findUnique({
          where: {
            provider_merchantAccountId_eventId: {
              provider: command.provider,
              merchantAccountId: command.merchantAccountId,
              eventId: command.eventId,
            },
          },
        });

        if (existingEvent) {
          const isIdentical =
            existingEvent.evidenceDigest === command.evidence.evidenceDigest &&
            existingEvent.outcome === command.outcome &&
            existingEvent.amount.equals(commandAmountDecimal) &&
            existingEvent.gatewayTxnId === command.gatewayTxnId;

          if (isIdentical) {
            const receipt = await this.recordReceipt(
              {
                provider: command.provider,
                merchantAccountId: command.merchantAccountId,
                eventId: command.eventId,
                gatewayTxnId: command.gatewayTxnId,
                disposition: SettlementDisposition.DUPLICATE_IGNORED,
                sourceIp: command.evidence.sourceIp,
                signatureValid: command.evidence.signatureValid ?? true,
              },
              tx,
            );

            return {
              applied: false,
              disposition: SettlementDisposition.DUPLICATE_IGNORED,
              paymentId: currentPayment.id,
              orderId: currentPayment.orderId,
              resultingPaymentStatus: currentPayment.status,
              settlementEventId: existingEvent.id,
              receiptId: receipt.id,
              message: 'Duplicate settlement event ignored.',
            };
          } else {
            const receipt = await this.recordReceipt(
              {
                provider: command.provider,
                merchantAccountId: command.merchantAccountId,
                eventId: command.eventId,
                gatewayTxnId: command.gatewayTxnId,
                disposition: SettlementDisposition.CONFLICT_REJECTED,
                sourceIp: command.evidence.sourceIp,
                signatureValid: command.evidence.signatureValid ?? false,
              },
              tx,
            );

            return {
              applied: false,
              disposition: SettlementDisposition.CONFLICT_REJECTED,
              paymentId: currentPayment.id,
              orderId: currentPayment.orderId,
              resultingPaymentStatus: currentPayment.status,
              settlementEventId: existingEvent.id,
              receiptId: receipt.id,
              message: 'Conflicting settlement event rejected: eventId already exists with differing payload or digest.',
            };
          }
        }

        // 6. Terminal Payment State Guards
        if (currentPayment.status === PaymentStatus.PAID && command.outcome === PaymentStatus.FAILED) {
          const receipt = await this.recordReceipt(
            {
              provider: command.provider,
              merchantAccountId: command.merchantAccountId,
              eventId: command.eventId,
              gatewayTxnId: command.gatewayTxnId,
              disposition: SettlementDisposition.CONFLICT_REJECTED,
              sourceIp: command.evidence.sourceIp,
              signatureValid: command.evidence.signatureValid ?? false,
            },
            tx,
          );

          return {
            applied: false,
            disposition: SettlementDisposition.CONFLICT_REJECTED,
            paymentId: currentPayment.id,
            orderId: currentPayment.orderId,
            resultingPaymentStatus: PaymentStatus.PAID,
            receiptId: receipt.id,
            message: 'Conflicting outcome: cannot transition terminal PAID payment to FAILED.',
          };
        }

        if (
          currentPayment.status === PaymentStatus.REFUNDED ||
          currentPayment.status === PaymentStatus.PARTIALLY_REFUNDED
        ) {
          const receipt = await this.recordReceipt(
            {
              provider: command.provider,
              merchantAccountId: command.merchantAccountId,
              eventId: command.eventId,
              gatewayTxnId: command.gatewayTxnId,
              disposition: SettlementDisposition.CONFLICT_REJECTED,
              sourceIp: command.evidence.sourceIp,
              signatureValid: command.evidence.signatureValid ?? false,
            },
            tx,
          );

          return {
            applied: false,
            disposition: SettlementDisposition.CONFLICT_REJECTED,
            paymentId: currentPayment.id,
            orderId: currentPayment.orderId,
            resultingPaymentStatus: currentPayment.status,
            receiptId: receipt.id,
            message: `Conflicting outcome: cannot mutate payment in terminal ${currentPayment.status} status.`,
          };
        }

        // Established reference preservation or initial null binding (F-03)
        const targetProviderReference = currentPayment.providerReference ?? command.gatewayTxnId;

        // 7. Cancelled Order Late Settlement Branch
        const allVendorOrdersCancelled =
          vendorOrders.length > 0 &&
          vendorOrders.every((vo) => vo.status === VendorOrderStatus.CANCELLED);

        if (allVendorOrdersCancelled && command.outcome === PaymentStatus.PAID) {
          // Late settlement for cancelled order:
          // Update Payment to PAID and preserve/bind providerReference
          await tx.payment.update({
            where: { id: currentPayment.id },
            data: {
              status: PaymentStatus.PAID,
              paidAt: new Date(),
              providerReference: targetProviderReference,
              failureReason: null,
            },
          });

          // Insert immutable Settlement Event with SETTLED_AFTER_CANCELLATION
          const settlementEvent = await tx.paymentSettlementEvent.create({
            data: {
              provider: command.provider,
              merchantAccountId: command.merchantAccountId,
              eventId: command.eventId,
              paymentId: currentPayment.id,
              orderId: currentPayment.orderId,
              checkoutAttemptId: command.checkoutAttemptId ?? null,
              gatewayTxnId: command.gatewayTxnId,
              amount: commandAmountDecimal,
              currency: command.currency,
              outcome: PaymentStatus.PAID,
              provenance: command.evidence.provenance,
              disposition: SettlementDisposition.SETTLED_AFTER_CANCELLATION,
              evidenceDigest: command.evidence.evidenceDigest,
              sanitizedPayload: this.sanitizePayload(command.evidence.rawPayload),
              eventTimestamp: command.evidence.eventTimestamp,
            },
          });

          // Idempotent Refund Generation with REQUIRED status
          const refundKey = `refund_post_cancel_${currentPayment.id}`;
          let refund = await tx.refund.findUnique({
            where: { idempotencyKey: refundKey },
          });
          if (!refund) {
            refund = await tx.refund.create({
              data: {
                idempotencyKey: refundKey,
                paymentId: currentPayment.id,
                amount: commandAmountDecimal,
                reason: 'Late settlement for cancelled order',
                status: RefundStatus.REQUIRED,
                providerReference: targetProviderReference,
              },
            });
          }

          // Insert audit receipt
          const receipt = await this.recordReceipt(
            {
              provider: command.provider,
              merchantAccountId: command.merchantAccountId,
              eventId: command.eventId,
              gatewayTxnId: command.gatewayTxnId,
              disposition: SettlementDisposition.SETTLED_AFTER_CANCELLATION,
              sourceIp: command.evidence.sourceIp,
              signatureValid: command.evidence.signatureValid ?? true,
            },
            tx,
          );

          // Insert outbox event
          const outbox = await tx.paymentOutbox.create({
            data: {
              aggregateId: currentPayment.id,
              aggregateType: 'Payment',
              eventType: 'PAYMENT_SETTLED_AFTER_CANCELLATION',
              payload: {
                paymentId: currentPayment.id,
                orderId: currentPayment.orderId,
                amount: commandAmountDecimal.toString(),
                currency: command.currency,
                settlementEventId: settlementEvent.id,
                refundId: refund.id,
                refundStatus: refund.status,
                timestamp: new Date().toISOString(),
              },
              published: false,
            },
          });

          return {
            applied: true,
            disposition: SettlementDisposition.SETTLED_AFTER_CANCELLATION,
            paymentId: currentPayment.id,
            orderId: currentPayment.orderId,
            resultingPaymentStatus: PaymentStatus.PAID,
            settlementEventId: settlementEvent.id,
            receiptId: receipt.id,
            refundId: refund.id,
            refundStatus: refund.status,
            outboxEventId: outbox.id,
            message: 'Payment settled after order cancellation. Refund required generated.',
          };
        }

        // 8. Normal Active Settlement (or recovery from FAILED to PAID, or transition to FAILED)
        if (command.outcome === PaymentStatus.PAID) {
          await tx.payment.update({
            where: { id: currentPayment.id },
            data: {
              status: PaymentStatus.PAID,
              paidAt: new Date(),
              providerReference: targetProviderReference,
              failureReason: null,
            },
          });
        } else {
          // FAILED
          const failureReason =
            typeof command.evidence.rawPayload === 'string'
              ? command.evidence.rawPayload.slice(0, 500)
              : JSON.stringify(command.evidence.rawPayload).slice(0, 500);

          await tx.payment.update({
            where: { id: currentPayment.id },
            data: {
              status: PaymentStatus.FAILED,
              providerReference: targetProviderReference,
              failureReason,
            },
          });
        }

        // Insert immutable Settlement Event
        const settlementEvent = await tx.paymentSettlementEvent.create({
          data: {
            provider: command.provider,
            merchantAccountId: command.merchantAccountId,
            eventId: command.eventId,
            paymentId: currentPayment.id,
            orderId: currentPayment.orderId,
            checkoutAttemptId: command.checkoutAttemptId ?? null,
            gatewayTxnId: command.gatewayTxnId,
            amount: commandAmountDecimal,
            currency: command.currency,
            outcome: command.outcome,
            provenance: command.evidence.provenance,
            disposition: SettlementDisposition.APPLIED,
            evidenceDigest: command.evidence.evidenceDigest,
            sanitizedPayload: this.sanitizePayload(command.evidence.rawPayload),
            eventTimestamp: command.evidence.eventTimestamp,
          },
        });

        // Insert audit receipt
        const receipt = await this.recordReceipt(
          {
            provider: command.provider,
            merchantAccountId: command.merchantAccountId,
            eventId: command.eventId,
            gatewayTxnId: command.gatewayTxnId,
            disposition: SettlementDisposition.APPLIED,
            sourceIp: command.evidence.sourceIp,
            signatureValid: command.evidence.signatureValid ?? true,
          },
          tx,
        );

        // Insert outbox event
        const outbox = await tx.paymentOutbox.create({
          data: {
            aggregateId: currentPayment.id,
            aggregateType: 'Payment',
            eventType:
              command.outcome === PaymentStatus.PAID ? 'PAYMENT_SETTLED' : 'PAYMENT_FAILED',
            payload: {
              paymentId: currentPayment.id,
              orderId: currentPayment.orderId,
              amount: commandAmountDecimal.toString(),
              currency: command.currency,
              outcome: command.outcome,
              settlementEventId: settlementEvent.id,
              timestamp: new Date().toISOString(),
            },
            published: false,
          },
        });

        return {
          applied: true,
          disposition: SettlementDisposition.APPLIED,
          paymentId: currentPayment.id,
          orderId: currentPayment.orderId,
          resultingPaymentStatus: command.outcome,
          settlementEventId: settlementEvent.id,
          receiptId: receipt.id,
          outboxEventId: outbox.id,
          message: `Payment settlement successfully applied with outcome ${command.outcome}.`,
        };
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
        timeout: 10000,
      },
    );
  }

  private sanitizePayload(payload: Record<string, unknown> | string): Prisma.InputJsonValue {
    try {
      let obj: Record<string, unknown>;
      if (typeof payload === 'string') {
        obj = JSON.parse(payload);
      } else if (typeof payload === 'object' && payload !== null) {
        obj = { ...payload };
      } else {
        return { raw: String(payload) };
      }

      const sensitivePatterns = [
        'cvv',
        'cvc',
        'cardnumber',
        'pan',
        'securitycode',
        'password',
        'token',
        'secret',
        'apikey',
        'authorization',
      ];

      const redact = (target: any): any => {
        if (target === null || target === undefined) return target;
        if (typeof target !== 'object') return target;
        if (Array.isArray(target)) return target.map(redact);

        const copy: Record<string, unknown> = {};
        for (const [key, val] of Object.entries(target)) {
          const lowerKey = key.toLowerCase();
          if (sensitivePatterns.some((p) => lowerKey.includes(p))) {
            copy[key] = '***REDACTED***';
          } else if (typeof val === 'object' && val !== null) {
            copy[key] = redact(val);
          } else {
            copy[key] = val;
          }
        }
        return copy;
      };

      return redact(obj) as Prisma.InputJsonValue;
    } catch {
      return { raw: '***UNPARSEABLE_PAYLOAD***' };
    }
  }
}
