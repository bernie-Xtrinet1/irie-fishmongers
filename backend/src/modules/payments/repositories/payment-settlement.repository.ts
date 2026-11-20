import { Injectable, Logger } from '@nestjs/common';
import {
  PaymentProviderName,
  PaymentSettlementEvent,
  PaymentSettlementReceipt,
  PaymentStatus,
  Prisma,
  SettlementDisposition,
  VendorOrderStatus,
} from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';
import {
  ApplyPaymentSettlementCommand,
  SettlementExecutionResult,
} from '../types/payment-settlement.types';
import {
  applyCancelledOrderLateSettlementTx,
  LockedSettlementPayment,
  recordSettlementReceiptTx,
  rejectSettlementConflictTx,
  sanitizeSettlementPayload,
} from './payment-settlement-cancelled.helper';

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
    if (tx) {
      return recordSettlementReceiptTx(tx, input);
    }
    return this.prisma.paymentSettlementReceipt.create({
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
        // Canonical pessimistic lock order: Order -> VendorOrders (id ASC) -> Payment
        const orderRows = await tx.$queryRaw<{ id: string }[]>(
          Prisma.sql`SELECT "id" FROM "orders" WHERE "id" = ${command.orderId} FOR UPDATE`,
        );
        if (orderRows.length === 0) {
          throw new Error(`Order not found: ${command.orderId}`);
        }

        const vendorOrders = await tx.$queryRaw<{ id: string; status: VendorOrderStatus }[]>(
          Prisma.sql`SELECT "id", "status" FROM "vendor_orders" WHERE "orderId" = ${command.orderId} ORDER BY "id" ASC FOR UPDATE`,
        );

        const paymentRows = await tx.$queryRaw<LockedSettlementPayment[]>(
          Prisma.sql`SELECT "id", "orderId", "provider", "merchantAccountId", "status", "amount", "currency", "providerReference" FROM "payments" WHERE "id" = ${command.paymentId} FOR UPDATE`,
        );
        if (paymentRows.length === 0) {
          throw new Error(`Payment not found: ${command.paymentId}`);
        }
        const currentPayment = paymentRows[0]!;

        if (currentPayment.orderId !== command.orderId) {
          return rejectSettlementConflictTx(
            tx,
            command,
            currentPayment,
            `Correlation mismatch: payment belongs to order ${currentPayment.orderId}, not ${command.orderId}`,
          );
        }

        if (currentPayment.provider !== command.provider) {
          return rejectSettlementConflictTx(
            tx,
            command,
            currentPayment,
            `Provider mismatch: payment is assigned to provider ${currentPayment.provider}, not ${command.provider}`,
          );
        }

        if (currentPayment.merchantAccountId !== command.merchantAccountId) {
          return rejectSettlementConflictTx(
            tx,
            command,
            currentPayment,
            `Merchant isolation mismatch: payment is assigned to ${currentPayment.merchantAccountId}, not ${command.merchantAccountId}`,
          );
        }

        if (
          currentPayment.providerReference !== null &&
          currentPayment.providerReference !== undefined &&
          currentPayment.providerReference !== command.gatewayTxnId
        ) {
          return rejectSettlementConflictTx(
            tx,
            command,
            currentPayment,
            `Conflicting provider reference: payment already established with reference ${currentPayment.providerReference}, incoming reference is ${command.gatewayTxnId}`,
          );
        }

        if (currentPayment.currency.toUpperCase() !== command.currency.toUpperCase()) {
          return rejectSettlementConflictTx(
            tx,
            command,
            currentPayment,
            `Currency mismatch: payment currency is ${currentPayment.currency}, incoming is ${command.currency}`,
          );
        }

        const commandAmountDecimal = new Prisma.Decimal(command.amount);
        if (!commandAmountDecimal.equals(currentPayment.amount)) {
          return rejectSettlementConflictTx(
            tx,
            command,
            currentPayment,
            `Amount mismatch: payment expected ${currentPayment.amount.toString()}, incoming is ${commandAmountDecimal.toString()}`,
          );
        }

        if (command.checkoutAttemptId) {
          const attemptRows = await tx.$queryRaw<{ id: string; orderId: string }[]>(
            Prisma.sql`SELECT "id", "orderId" FROM "checkout_attempts" WHERE "id" = ${command.checkoutAttemptId}`,
          );
          if (attemptRows.length > 0 && attemptRows[0]!.orderId !== command.orderId) {
            return rejectSettlementConflictTx(
              tx,
              command,
              currentPayment,
              `Checkout attempt mismatch: attempt ${command.checkoutAttemptId} does not belong to order ${command.orderId}`,
            );
          }
        }

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
            const receipt = await recordSettlementReceiptTx(tx, {
              provider: command.provider,
              merchantAccountId: command.merchantAccountId,
              eventId: command.eventId,
              gatewayTxnId: command.gatewayTxnId,
              disposition: SettlementDisposition.DUPLICATE_IGNORED,
              sourceIp: command.evidence.sourceIp,
              signatureValid: command.evidence.signatureValid ?? true,
            });
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
          }

          return rejectSettlementConflictTx(
            tx,
            command,
            currentPayment,
            'Conflicting settlement event rejected: eventId already exists with differing payload or digest.',
            { settlementEventId: existingEvent.id },
          );
        }

        if (currentPayment.status === PaymentStatus.PAID && command.outcome === PaymentStatus.FAILED) {
          return rejectSettlementConflictTx(
            tx,
            command,
            currentPayment,
            'Conflicting outcome: cannot transition terminal PAID payment to FAILED.',
            { resultingPaymentStatus: PaymentStatus.PAID },
          );
        }

        if (
          currentPayment.status === PaymentStatus.REFUNDED ||
          currentPayment.status === PaymentStatus.PARTIALLY_REFUNDED
        ) {
          return rejectSettlementConflictTx(
            tx,
            command,
            currentPayment,
            `Conflicting outcome: cannot mutate payment in terminal ${currentPayment.status} status.`,
          );
        }

        const targetProviderReference = currentPayment.providerReference ?? command.gatewayTxnId;
        const allVendorOrdersCancelled =
          vendorOrders.length > 0 &&
          vendorOrders.every((vo) => vo.status === VendorOrderStatus.CANCELLED);

        if (allVendorOrdersCancelled && command.outcome === PaymentStatus.PAID) {
          return applyCancelledOrderLateSettlementTx(
            tx,
            command,
            currentPayment,
            commandAmountDecimal,
            targetProviderReference,
          );
        }

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
            sanitizedPayload: sanitizeSettlementPayload(command.evidence.rawPayload),
            eventTimestamp: command.evidence.eventTimestamp,
          },
        });

        const receipt = await recordSettlementReceiptTx(tx, {
          provider: command.provider,
          merchantAccountId: command.merchantAccountId,
          eventId: command.eventId,
          gatewayTxnId: command.gatewayTxnId,
          disposition: SettlementDisposition.APPLIED,
          sourceIp: command.evidence.sourceIp,
          signatureValid: command.evidence.signatureValid ?? true,
        });

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
}
