# Payment Providers

## Provider boundary

WiPay remains the selected primary provider (ADR-001); Fygaro is a future secondary
adapter and Stripe Connect a future marketplace option. Business code calls
PaymentsService and PaymentProviderAdapter. Provider selection is not a claim that
every desired capability is implemented. Orders, vendors, settlements, inventory,
reservations and payment-reconciliation ownership are unchanged by Phase F.4.

## Phase F.4: Jamaica sandbox hosted Payments API

Contract reviewed 2026-09-06 against WiPay Payments API v1.0.11:

- [Payment Request](https://docs.wipayfinancial.com/payments-api/payment-request)
- [API overview and request identification](https://docs.wipayfinancial.com/payments-api)
- [Platforms and environments](https://docs.wipayfinancial.com/platforms-and-environments)
- [Transaction Response](https://docs.wipayfinancial.com/payments-api/transaction-response)
- [Hosted checkout lifecycle](https://docs.wipayfinancial.com/hosted-checkout-flows)
- [Webhook contract](https://docs.wipayfinancial.com/webhooks)
- [WAPI authentication](https://docs.wipayfinancial.com/wapi)
- [Canonical Bruno/OpenCollection archive](https://docs.wipayfinancial.com/downloads/Payments-API.zip)
- [Generated Postman collection](https://docs.wipayfinancial.com/downloads/Payments-API.postman_collection.json)

The adapter sends one POST to
`https://jmsb.wipayfinancial.com/plugins/payments/request`, with
`Content-Type: application/x-www-form-urlencoded` and `Accept: application/json`.
It sends account_number, country_code=JM, currency=JMD, environment=sandbox,
fee_structure, method=credit_card_co, stored order_id, origin=IrieFishmongers,
response_url, original total formatted to two decimals, and the stored customer's
email. Current documentation deprecates the older `credit_card` method and lists
email as required (maximum 50 characters). No fabricated email is substituted.
Encoding review: the downloaded canonical archive's
`Payments API/Payment/Payment - Request.yml` specifies `http.body.type: form-urlencoded`.
`Payments API/opencollection.yml` supplies `Accept: application/json`; the generated
Postman request likewise uses `body.mode: urlencoded`. This is direct authoritative
support for retaining the current form encoding. The Payment Request reference also
explicitly documents an `application/json` request example. JSON is documented;
actual runtime acceptance of either encoding has not been tested here. Do not claim
JSON is rejected or that form encoding is the only accepted format. The canonical
collection supports the current implementation, so no encoding change is warranted.

`WIPAY_FEE_STRUCTURE` is required and accepts customer_pay, merchant_absorb or split.
There is no application default. Examples, CI, Docker validation, devcontainer and
Azure staging explicitly choose merchant_absorb for sandbox testing only. This is
not a production fee policy. Tier-3 Bicep requires that parameter. APP_BASE_URL is
the backend's public base URL; API_PREFIX supplies the actual route prefix.
No extra environment/country/method knobs are needed for this sandbox-only phase.
Non-Jamaica-sandbox initiation and non-JMD payments fail before any provider call.

The account number identifies the request. WIPAY_API_KEY is never sent to WiPay
as Bearer authentication or in the request body. It is server-side hash material.
Public sandbox values are account 1234567890 and verification key 123. Azure's
existing secret references remain unchanged; no secret values or deployment were
modified. Public sandbox keys cannot provide production authenticity.

The JSON bootstrap must contain a nonempty string transaction_id and an absolute
HTTPS checkout URL on the configured sandbox origin, without embedded credentials.
Malformed JSON, missing fields, unsafe URLs and non-2xx responses fail safely.
A bootstrap establishes a pending attempt, never PAID. Cross-origin checkout URLs
are conservatively rejected pending explicit provider validation.

The checkout URL validator is tied to the configured API origin and is tested for
both documented Jamaica hosts: jmsb (sandbox) and jm (live). It rejects cross-environment
URLs, credentials and non-HTTPS URLs. Separately, F.4's createPayment guard explicitly
permits sandbox initiation only. A live URL configuration alone still cannot activate
payments: a future approved production phase must update that deliberate initiation
gate and environment request field. The URL validator itself needs no sandbox-host
replacement for live use. No production configuration is enabled here.

## Browser return and payment confirmation

response_url is `${APP_BASE_URL}/${API_PREFIX}/payments/returns/wipay`, a public GET
handler for WiPay's URL-encoded query parameters. It returns a minimal JSON receipt
(`VERIFIED` or `UNVERIFIED`) with no payment/customer details, no-store caching and
no-referrer policy. A customer-facing completion page is not introduced in this
provider-boundary phase.

PaymentsService resolves only the stored provider reference and checks WIPAY
ownership. Unknown references are rejected; no Payment is created from a return.
Success requires the adapter's constant-time comparison of the documented MD5:
`transaction_id + original_total + api_key`, without separators. The reference must
match the stored bootstrap reference and original_total comes from Payment.amount,
formatted exactly as the initiation request. Returned total, currency, order_id,
customer identifiers and provider identifiers never become authoritative values.
Malformed/missing hashes fail closed. The existing atomic transitionToPaid and
PaymentConfirmed event path preserve duplicate-success idempotency.

WiPay only supplies that hash on success. Browser failed/error results are therefore
UNVERIFIED: they cause no payment mutation, event or retry, even when repeated or
received after success. They cannot downgrade PAID. Definitive failed transitions
remain available to the existing reliability machinery when authenticated evidence
is available; unsigned browser data is not that evidence.

## Separate webhooks and WAPI

The old POST /payments/webhooks/wipay route is retained solely as a disabled legacy
boundary. Missing body/header remains 400; a supplied legacy x-wipay-signature
receives 501. The legacy scheme was incompatible with the documented contract:
it used x-wipay-signature and HMAC over only the body with WIPAY_API_KEY, without
the required envelope, endpoint secret, timestamp/replay check or delivery ID.
WiPay webhooks themselves are documented; only this application's implementation
is absent. A future integration must consume a POST JSON envelope and all five
headers: X-WiPay-Webhook-Event, X-WiPay-Webhook-Id, X-WiPay-Webhook-Signature,
X-WiPay-Webhook-Timestamp and X-WiPay-Webhook-Version. Verify
`HMAC-SHA256(timestamp + "." + raw_body, endpointSecret)` against the `sha256=` hex
signature in constant time, using the endpoint-specific signing secret. Enforce
timestamp replay protection (WiPay recommends five minutes), version validation,
and durable webhook-ID idempotency. This separate lifecycle boundary is not
implemented or activated by F.4; do not register the disabled legacy route.

WAPI is a separate API family under /wapi with OAuth tokens or WAPI keys. Its
[transaction retrieve](https://docs.wipayfinancial.com/payments-api/transaction-response)
and [refund request](https://docs.wipayfinancial.com/wapi/transactions/createRefundRequest)
capabilities do not authorize use of the Payments API key as a Bearer token.

## Unsupported operations and ambiguity

verifyPayment and refundPayment fail with NotImplementedException and perform zero
network requests. The assumed Payments API GET /{reference} and POST
/{reference}/refund were not verified and are removed. WAPI onboarding, credentials,
refund semantics and lifecycle delivery are outside this integration. No refund
record or paid-state change is made when the unsupported adapter rejects a refund.

Provider-side initiation idempotency, lookup-by-order and safe create retries have
not been verified. No idempotency header, lookup endpoint or retry is invented.
HTTP redirects are not followed automatically. Ambiguous creation, including an
unusable bootstrap, remains RECONCILE_REQUIRED under the existing service; a replay
cannot create again. If persistence fails after bootstrap, INITIATING remains
unresolved. Unknown outcomes are never refunded as recovery. Reconciliation's
existing error path releases its fenced claim when unsupported verification throws;
it cannot make an unsafe provider request or fabricate a terminal status.

This is documentation-aligned sandbox code, not a completed merchant sandbox test
or production activation. Abandoned browser flows, ambiguous initiation, definitive
failure resolution and refunds require a separately verified operational capability.
Production also requires private credentials, approved fee policy and lifecycle
integration. The existing event-delivery and payment-state-machine design is unchanged.
