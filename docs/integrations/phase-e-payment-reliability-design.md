# Phase E Payment Reliability Design

Status: Proposed for review

Scope: Design and documentation only. This document does not authorize
CheckoutModule activation, controller cutover, Web checkout activation,
database migration, WiPay production use, or Azure deployment.

## 1. Purpose

Phase E closes the payment reliability gap recorded by ADR-007 after the
durable checkout transaction.

The checkout coordinator intentionally creates and commits the durable Order
and transitions CheckoutAttempt to COMMITTED before payment initiation.
Payment initiation remains outside the order database transaction because an
external payment-provider request must not execute inside that transaction.

The unresolved failure window is:

1. Order and CheckoutAttempt commit successfully.
2. Reservation finalization is attempted.
3. Payment initiation begins.
4. The provider call fails, times out, or returns an ambiguous result.
5. The committed Order must remain valid.
6. Checkout replay must not recreate the Order, decrement inventory again, or
   blindly initiate another payment.

Phase E defines forward-only payment recovery for this condition.

## 2. Authoritative invariants

### 2.1 Committed checkout is final

A payment-initiation failure MUST NOT:

- delete or roll back a committed Order;
- restore inventory already durably consumed by the committed Order;
- rebuild the customer's Cart;
- transition a COMMITTED CheckoutAttempt back to PROCESSING or FAILED;
- rerun the durable checkout transaction.

Payment recovery is a separate post-commit concern.

### 2.2 Checkout idempotency remains unchanged

CheckoutAttempt continues to own checkout idempotency.

An ALREADY_COMMITTED checkout replay returns the existing Order and MUST NOT:

- create another Order;
- decrement inventory again;
- emit another OrderPlacedEvent;
- blindly call payment initiation again.

Phase E must not weaken these guarantees.

### 2.3 One local Payment per Order

The existing unique Payment.orderId constraint remains authoritative.

Phase E MUST preserve one local Payment record per Order.

The application must handle concurrent payment-initiation attempts without
creating multiple local Payment records or multiple logical payment
obligations for the same Order.

### 2.4 Payment recovery is forward-only

Once an Order is committed, payment recovery proceeds toward a terminal
payment state. Recovery does not compensate by undoing the Order.

For online payment, an uncertain provider result is not equivalent to a
confirmed failure. It must be reconciled before another provider-side payment
creation attempt is allowed.

## 3. Payment initiation state model

The existing PaymentStatus values describe business payment outcome but do
not fully describe provider-initiation reliability.

Phase E implementation must introduce or otherwise persist enough durable
state to distinguish at least these initiation conditions:

NOT_STARTED
    No provider initiation has been attempted.

INITIATING
    A durable initiation record/state exists before an external provider call
    begins.

PENDING
    The provider accepted the payment request and the payment is awaiting
    customer/provider completion.

PAID
    Payment has been confirmed. This is monotonic for payment confirmation:
    duplicate or older callbacks cannot downgrade it.

FAILED
    The provider has definitively reported failure and recovery policy permits
    another payment attempt.

RECONCILE_REQUIRED
    The external request may have reached the provider but the local system
    does not know the authoritative outcome. No blind provider-create retry
    is permitted from this state.

The exact schema representation is an implementation decision for the Phase E
implementation unit. A migration is not authorized by this design document.

## 4. Provider-call ordering

For a missing payment, the current unsafe sequence is conceptually:

provider create
then
persist local Payment

Phase E must change the reliability boundary so durable local intent exists
before an external provider-side payment creation request can produce an
irrecoverable ambiguity.

The required conceptual order is:

1. Load committed Order and existing Payment state.
2. Establish or claim durable payment-initiation state.
3. Commit that local state.
4. Call the external provider.
5. Persist provider reference and provider outcome.
6. Return redirect/payment information.

A crash or timeout between steps 4 and 5 MUST lead to RECONCILE_REQUIRED or
an equivalent durable condition, never an automatic blind provider-create
retry.

## 5. WiPay uncertainty rule

No implementation may assume WiPay supports provider-side idempotency unless
the actual merchant sandbox/API contract confirms it.

Before production WiPay activation, the integration must establish whether
WiPay supports one or more of:

- merchant-supplied idempotency key;
- merchant-supplied unique transaction reference;
- lookup by merchant Order reference;
- safe status lookup after an ambiguous request;
- deterministic retry semantics.

If provider-side idempotency is available, Irie Fishmongers should bind it to
a stable payment-attempt identifier.

If provider-side idempotency is not available, an ambiguous create request
must be reconciled with WiPay before another create request is issued.

The current adapter's assumed endpoint and callback contract is not sufficient
authority for production activation.

## 6. Callback transition rules

Payment callbacks and manual payment confirmation MUST be transition
idempotent.

Required behavior:

Current state: PENDING or valid equivalent
Incoming success:
    Transition to PAID and emit PaymentConfirmedEvent exactly once.

Current state: PAID
Incoming duplicate success:
    Acknowledge successfully.
    Do not update paidAt unnecessarily.
    Do not emit PaymentConfirmedEvent again.

Current state: PAID
Incoming failed callback:
    Do not downgrade to FAILED.
    Record/log the contradictory callback as appropriate.

Current state: FAILED
Incoming duplicate failed callback:
    Acknowledge without duplicating side effects.

Unknown provider reference:
    Acknowledge or handle according to the verified provider contract without
    creating an unrelated Payment row from untrusted callback data.

Invalid signature:
    Reject.

Provider callbacks MUST NOT be able to change the Order's customer, amount,
currency, or provider identity.

## 7. Cash on Delivery

Cash on Delivery remains a post-order Payment with no external gateway.

COD payment creation must remain deterministic for the Order.

Manual or delivery-triggered confirmation must be idempotent:

PENDING -> PAID
    Update once and emit PaymentConfirmedEvent once.

PAID -> PAID
    Return the already-paid result without emitting PaymentConfirmedEvent
    again.

A non-COD Payment cannot be confirmed through the COD confirmation path.

## 8. Same-order concurrent initiation

Two concurrent requests attempting to initialize payment for the same Order
must converge on one durable local Payment/payment-attempt authority.

The unique Payment.orderId constraint remains the final database backstop.

Application logic must treat a unique-constraint race as a replay/reload
condition, not as permission to create another provider payment.

The provider call must occur only for the request that successfully owns the
durable initiation transition.

## 9. Payment recovery

A committed Order with no usable payment outcome must be recoverable without
rerunning checkout.

Phase E implementation must provide a payment-recovery operation that:

- loads the already-committed Order;
- verifies customer/order ownership where customer-accessible;
- reads the durable Payment/initiation state;
- returns an existing usable payment/redirect result when available;
- reconciles ambiguous provider state when required;
- initiates a new provider attempt only when the previous attempt is
  definitively safe to replace;
- never recreates the Order or reruns inventory consumption.

The exact public API surface is not authorized by this document and requires
a separate implementation review.

## 10. Refund boundary

Refund behavior remains separate from payment-initiation recovery.

Phase E must not use a refund as the automatic response to a provider request
whose outcome is unknown.

A refund is appropriate only after a payment is authoritatively known to have
been captured/paid and business rules require money to be returned.

## 11. Required implementation tests

Before Phase E implementation can be accepted, automated tests must prove:

1. Payment intent/state is durable before provider creation.
2. Two concurrent initiations for one Order cannot create two local Payments.
3. Two concurrent initiations cannot result in two provider-create calls
   under the application's controllable concurrency boundary.
4. Provider failure before request transmission is safely retryable.
5. Timeout/exception after possible provider acceptance produces an ambiguous
   recovery state rather than blind retry.
6. Reconciliation can recover an ambiguous online payment.
7. ALREADY_COMMITTED checkout replay still performs zero payment initiation.
8. Duplicate WiPay success callback emits PaymentConfirmedEvent once.
9. Success followed by failed callback cannot downgrade PAID.
10. Duplicate failed callback has no duplicated business side effects.
11. COD repeated mark-paid emits PaymentConfirmedEvent once.
12. Existing Payment.orderId uniqueness remains enforced.
13. Payment amount, currency, provider, and Order identity cannot be mutated by
    untrusted callback payload.
14. Existing checkout idempotency, inventory, reservation, and order tests
    remain green.
15. Real provider integration is not considered production-ready until WiPay
    sandbox/API behavior is verified separately.

## 12. Phase E versus Phase F

Phase E owns payment initiation reliability, payment reconciliation, payment
state transitions, and payment callback idempotency.

Phase F owns checkout/reservation operational recovery such as heartbeat
recovery, stale CheckoutAttempt handling, Redis checkout-pending cleanup, and
its approved scheduler/locking mechanism.

A payment-recovery worker must not be silently implemented as part of Phase F
without a separately reviewed design.

## 13. Remaining activation blockers

Completion of this Phase E design does not authorize production checkout
cutover.

ADR-007's other activation blockers remain independent, including the
remaining Phase C/D activation conditions, rollout mechanism, cart mutation
semantics, shadow/allow-list validation, and eventual reservation-engine
cutover gates.

The customer Web "Place order" action remains disabled until the checkout
activation plan is separately approved.

## 14. Open Decision 5 resolution proposal

ADR-007 Open Decision 5 should be resolved as follows:

"Payment failure after durable checkout commit uses forward-only,
idempotent payment recovery. A committed Order and COMMITTED CheckoutAttempt
are never rolled back solely because payment initiation fails. Provider
ambiguity is persisted and reconciled before another external create attempt.
Payment callbacks and COD confirmation are transition-idempotent, and
PaymentConfirmedEvent is emitted only on the first authoritative transition
to PAID."

This resolution is proposed by this document and becomes authoritative only
after review and the corresponding ADR-007 update is approved.

## 15. Explicit non-authorization

This document does not authorize:

- CheckoutModule import into AppModule;
- creation or activation of a CheckoutController;
- replacement of POST /orders/checkout;
- Web Place Order activation;
- payment-method UI activation;
- Prisma/schema migration;
- WiPay sandbox or production calls;
- Azure deployment;
- removal of legacy checkout;
- reservation-engine production cutover.
