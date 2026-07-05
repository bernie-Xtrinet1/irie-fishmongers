# ADR-001 Payment Provider Selection

Status:
Approved

Date:
2026-07-04

---

## Context

IrieFishmongers requires:

- Online payments
- Jamaican settlement
- Marketplace support
- Vendor allocations
- Refund processing
- Webhooks

---

## Decision

Selected Provider:

WiPay

Secondary Provider:

Fygaro

Future Provider:

Stripe Connect

---

## Reasoning

WiPay selected because:

- Operates in Jamaica
- Supports local merchants
- Supports JMD transactions
- Faster implementation

Fygaro retained as backup provider.

Stripe Connect reserved for future marketplace expansion.

---

## Architectural Requirements

Claude must design:

PaymentService

between business logic and payment providers.

Business logic must never directly call provider APIs.

---

## Consequences

Positive

- Easier provider replacement
- Reduced vendor lock-in
- Cleaner architecture

Negative

- Additional abstraction layer required

---

## Future Review

Review annually.

Review triggers:

- New provider availability
- Better marketplace functionality
- Lower transaction fees

---

## Implementation Directive

Claude shall:

- Use PaymentService abstraction
- Use provider adapters
- Support multiple providers
- Avoid provider-specific business logic

This ADR takes precedence over implementation suggestions.
