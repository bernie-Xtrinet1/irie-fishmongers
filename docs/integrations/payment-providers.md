# Payment Providers

Version: 1.0

## Approved Providers

Primary:
- WiPay

Secondary:
- Fygaro

Future:
- Stripe Connect

---

## Architecture Principle

The platform shall never be tightly coupled to a payment provider.

All payment processing must be performed through a Payment Service abstraction layer.

Frontend
? Payment Service
? Provider Adapter
? Payment Provider

---

## Supported Functions

All providers must support:

- Customer payments
- Payment verification
- Refunds
- Webhooks
- Settlement reconciliation

---

## Payment Flow

1. Customer submits order.
2. System calculates total.
3. Customer pays online.
4. Provider confirms payment.
5. Order becomes PAID.
6. Settlement records created.
7. Vendors receive allocations.

---

## Provider Interface

Claude must implement:

interface PaymentProvider {
  createPayment();
  verifyPayment();
  refundPayment();
  processWebhook();
}

---

## Vendor Lock Prevention

No business logic may directly reference:

- WiPay APIs
- Fygaro APIs
- Stripe APIs

All provider calls must pass through:

PaymentService

---

## Security

Never store:

- Card numbers
- CVV
- Full payment credentials

Store only:

- Transaction IDs
- Authorization IDs
- Payment status

---

## Webhooks

Webhooks are mandatory.

Supported events:

- payment.success
- payment.failed
- refund.completed

---

## Future Marketplace Support

Architecture must support future migration to:

Stripe Connect

without changing:

- Orders
- Vendors
- Settlements
- Customer accounts
