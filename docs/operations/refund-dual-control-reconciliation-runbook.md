# Dual-Control Refund Reconciliation & WiPay Sandbox Operator Runbook

**Work Package:** `WP4.3B.4F.7D.4B.7D` (`F-D4B3A-03`)  
**Scope:** Operations, Dual-Control Administration, Evidence Verification & Escalation  
**Status:** Fail-Closed Pre-Activation Documentation (`UNRESOLVED` — pending WiPay WAPI sandbox credentials and contract verification)

> **CRITICAL SAFETY NOTICE:**  
> This runbook governs offline/sandbox-mode verification and controlled dual-administrator reconciliation. It does **NOT** authorize production activation of `/admin/refund-reconciliation/*`, live WiPay WAPI refund/inquiry requests, live WiPay webhook ingestion, or automated refund dispatch.  
> - [`RefundReconciliationEndpointGateGuard`](file:///c:/Users/user/Documents/Bernie%20Project/Iriefishmonger%20platform/backend/src/modules/payments/guards/refund-reconciliation-endpoint-gate.guard.ts#L26-L55) unconditionally fails closed with **HTTP `501 Not Implemented`** whenever `NODE_ENV === 'production'`, even if `REFUND_RECONCILIATION_API_ENABLED=true`.  
> - [`WiPayAdapter`](file:///c:/Users/user/Documents/Bernie%20Project/Iriefishmonger%20platform/backend/src/modules/payments/providers/wipay.adapter.ts#L1-L169) rejects non-sandbox `WIPAY_API_URL` values, reports `supportsRefundStatusLookup = false`, and fails closed (`501`) on `verifyPayment`, `refundPayment`, and `verifyRefundStatus`.

---

## 1. Environment & Secret Configuration Separation

Checkout payments, refund/status APIs (**WAPI**), and **Webhooks** belong to distinct WiPay configuration surfaces and MUST NOT share credentials improperly or leak into source code, test fixtures, logs, or reports.

| Surface | Protocol / Endpoint Family | Required Configuration | Current Repository / Sandbox Status |
| :--- | :--- | :--- | :--- |
| **Hosted Checkout** | Payments API v1.0.11 (`POST /request`, `GET /returns/wipay`) | `WIPAY_API_URL` (Jamaica sandbox MUST be `https://jmsb.wipayfinancial.com/plugins/payments`), `WIPAY_FEE_STRUCTURE`, `WIPAY_ACCOUNT_NUMBER`, `WIPAY_API_KEY` (MD5 hash secret only; staging Key Vault: `wipay-account-number`, `wipay-api-key`) | `backend/.env` currently sets legacy `tx.wipayfinancial.com` (`WIPAY_FEE_STRUCTURE` unset). Outbound checkout in [`WiPayAdapter`](file:///c:/Users/user/Documents/Bernie%20Project/Iriefishmonger%20platform/backend/src/modules/payments/providers/wipay.adapter.ts#L7-L16) only permits `WIPAY_SANDBOX_API_URL`. |
| **Refund Initiation & Status Inquiry** | WiPay **WAPI** (`/wapi/transactions/createRefundRequest`, WAPI transaction retrieve) | Dedicated WAPI sandbox base URL + WAPI OAuth client/token or WAPI merchant key (distinct from `WIPAY_API_KEY`; see [`payment-providers.md`](file:///c:/Users/user/Documents/Bernie%20Project/Iriefishmonger%20platform/docs/integrations/payment-providers.md#L76-L90)) | **NOT PROVISIONED.** No WAPI environment keys exist in `EnvironmentVariables` or `backend/.env`. Live WAPI contract specs remain `PENDING` (`it.skip`). |
| **Refund / Payment Webhooks** | `POST` JSON + 5 headers (`X-WiPay-Webhook-Event`, `X-WiPay-Webhook-Id`, `X-WiPay-Webhook-Signature`, `X-WiPay-Webhook-Timestamp`, `X-WiPay-Webhook-Version`) | Dedicated webhook endpoint secret verifying `HMAC-SHA256(timestamp + "." + raw_body, endpointSecret)` (5-min replay window + `X-WiPay-Webhook-Id` idempotency) | **NOT PROVISIONED.** Legacy [`POST /payments/webhooks/wipay`](file:///c:/Users/user/Documents/Bernie%20Project/Iriefishmonger%20platform/backend/src/modules/payments/controllers/payments.controller.ts#L87-L98) expects incompatible `x-wipay-signature` and fails closed. |
| **Dual-Control Reconciliation API** | `/admin/refund-reconciliation/*` | `NODE_ENV !== 'production'` **AND** `REFUND_RECONCILIATION_API_ENABLED=true` (isolated dev/test only) | Disabled by default; `NODE_ENV=production` always returns **HTTP `501`**. |

### Credential Hygiene & Sandbox Allowlist Rules
1. Never store WiPay sandbox keys, OAuth tokens, raw webhook secrets, or unredacted customer PAN/PII in code, Prisma migrations, integration fixtures, Jira/incident tickets, or `rawEvidence` payloads. [`sanitizeRefundPayload`](file:///c:/Users/user/Documents/Bernie%20Project/Iriefishmonger%20platform/backend/src/modules/payments/repositories/refund-locks.helper.ts#L203-L240) redacts sensitive key patterns (`password`, `secret`, `token`, `api_key`, `authorization`, `signature`, `bearer`, `private_key`) before persisting audit payloads.
2. Outbound HTTP requests during sandbox validation MUST be strictly allowlisted to confirmed WiPay sandbox hosts (`jmsb.wipayfinancial.com` for checkout and the WiPay-confirmed sandbox `/wapi` host once provisioned). Never direct live or mocked calls to `jm.wipayfinancial.com` or `tx.wipayfinancial.com`.

---

## 2. Escalation Ownership & Segregation of Duties Matrix

All actions under `/admin/refund-reconciliation/*` are protected by `RefundReconciliationEndpointGateGuard`, `JwtAuthGuard`, `RolesGuard` (`@Roles(RoleName.ADMINISTRATOR)`), `ActiveAdministratorGuard` (revalidates `UserStatus.ACTIVE` + `RoleName.ADMINISTRATOR` in PostgreSQL), and rate throttling (`10` req / `60s`).

| Role | Operational Owner | Permitted Actions | Enforced Segregation Rule |
| :--- | :--- | :--- | :--- |
| **Requester (`Admin A`)** | Customer Support / Finance Ops On-Call (`ADMINISTRATOR`) | Inspect obligation/approvals, collect gateway evidence, submit `POST /approvals`, optionally revoke own unexecuted request | **Cannot** approve, reject, or execute their own request (`403 Forbidden` + DB trigger). |
| **Approver (`Admin B`)** | Finance Operations Lead / Senior Platform Admin (`ADMINISTRATOR`, `Admin B !== Admin A`) | Independently verify portal proof & canonical digest; call `POST /approvals/:id/approve` or `/reject` (or `/revoke`) | MUST be a distinct `ACTIVE` administrator at both approval and execution time. |
| **Executor (`Admin B` or `Admin C`)** | Senior Platform Admin / Release On-Call (`ADMINISTRATOR`, `Executor !== Admin A`) | Execute approved decision (`POST /approvals/:id/execute`) with optimistic revision & digest checks | `Executor !== Admin A` and both `Admin A` & `Admin B` must remain `ACTIVE` admins at execution time. |
| **Quarantine Escalation Owner** | **Payments Engineering On-Call** + **Finance Lead** | Triage `409 Conflict` (`RECONCILIATION_QUARANTINED`), stale digests, actor demotions, contradictory receipts, and double-settlement gateway anomalies | Owns root-cause diagnosis before any subsequent bound request is opened. |

---

## 3. Dual-Control Reconciliation Workflow (`/admin/refund-reconciliation`)

### Step 1 — Inspect Target Obligation & History
1. Query `GET /admin/refund-reconciliation/obligations/:obligationId` (and `GET /admin/refund-reconciliation/approvals?obligationId=<uuid>`).
2. Confirm:
   - Obligation status is NOT terminal (`FULFILLED` or `CANCELLED_VOIDED` blocks new requests).
   - No active approval already exists in `REQUESTED`, `APPROVED`, or `EXECUTING`.
   - Exact latest `RefundProviderAttempt` (`attemptId`, `attemptSequence`, `status`), linked `Refund` rows, and all `RefundEvidenceReceipt` dispositions (`APPLIED`, `IGNORED`, `CONFLICT_REJECTED`, `SIGNATURE_REJECTED`).
3. **Legacy Migration `#69` Unbound Approvals Check:** If an older `REQUESTED` or `APPROVED` row lacks Migration `#70` bindings (`paymentId`, `provider`, `merchantAccountId`, `amount`, `currency`, `requestedOutcome`, `requestDigest`, `expiresAt`), [`approveReconciliation`](file:///c:/Users/user/Documents/Bernie%20Project/Iriefishmonger%20platform/backend/src/modules/payments/repositories/refund-dual-control.repository.ts#L98-L111) and execution **reject** it. Retire the unbound row via `POST /admin/refund-reconciliation/approvals/:approvalId/revoke` (`revocationReason` >= 5 chars) to preserve immutable history before submitting a fresh `#70`-bound request. Leave historical `APPLIED` rows untouched.

### Step 2 — Collect & Hash Verified Gateway Evidence
1. Obtain independent gateway proof (e.g., WiPay merchant portal settlement export, authenticated WAPI transaction inquiry summary, or verified webhook `RefundEvidenceReceipt` UUIDs).
2. Compute or verify the 64-character lowercase hex SHA-256 `evidenceDigest`:
   - If passing `evidenceDigest` explicitly, it MUST match `^[a-fA-F0-9]{64}$` over canonical gateway proof metadata.
   - If omitting `evidenceDigest`, the repository hashes `rawEvidence` (using sorted canonical JSON via [`sha256Hex`](file:///c:/Users/user/Documents/Bernie%20Project/Iriefishmonger%20platform/backend/src/modules/payments/repositories/refund-locks.helper.ts#L200-L240)), or fallback `{ evidenceType, externalSettlementReference, receiptIds }`.
3. Verify `externalSettlementReference` integrity:
   - **Never** echo the parent customer charge `Payment.providerReference`.
   - **Never** reuse an `providerRefundReference` already on another `RefundProviderAttempt` or `externalSettlementReference` on another `APPROVED` / `EXECUTING` / `APPLIED` approval.

### Step 3 — Submit Request (`Admin A`)
- Call `POST /admin/refund-reconciliation/approvals` (`201 Created`):
  - `obligationId` (UUID), optional `attemptId` (UUID — must be latest attempt sequence if specified), `requestedOutcome` (`VERIFIED_COMPLETED` | `VERIFIED_FAILED` | `CONTINUE_QUARANTINE` | `VOID_OBLIGATION`), `evidenceType` (max 120 chars), optional `externalSettlementReference` (mandatory for `VERIFIED_COMPLETED`), optional `evidenceReceiptIds` (up to 20 UUIDs), `evidenceDigest` and/or sanitized `rawEvidence`, `rationale` (10–1000 chars), optional `ttlMs` (`1,000` to `86,400,000` ms; default `15 minutes`).
- Record returned `id` (`approvalId`), `authorizationRevision` (`1`), `evidenceDigest`, and `expiresAt`.

### Step 4 — Independent Review & Grant/Reject (`Admin B`, `Admin B !== Admin A`)
1. Retrieve `GET /admin/refund-reconciliation/approvals/:approvalId`.
2. Independently confirm in the WiPay merchant portal / settlement statement:
   - `amount`, `currency`, `merchantAccountId`, and `provider` match the settled/declined external record.
   - `externalSettlementReference` and `evidenceDigest` match the raw gateway artifact.
   - No contradictory evidence receipts arrived after `requestedAt`.
3. Either:
   - **Approve:** `POST /admin/refund-reconciliation/approvals/:approvalId/approve` with `{ expectedAuthorizationRevision: 1, expectedEvidenceDigest: "<sha256>", expiresAt?: "<ISO-8601>" }` -> transitions to `APPROVED`, increments `authorizationRevision` to `2`, writes `approvalDigest`.
   - **Reject:** `POST /admin/refund-reconciliation/approvals/:approvalId/reject` with `{ rejectionReason: "<min 5 chars>" }` -> terminal `REJECTED`.

### Step 5 — Atomic Execution (`Admin B` or `Admin C`, `Executor !== Admin A`)
- Before `expiresAt`, call `POST /admin/refund-reconciliation/approvals/:approvalId/execute` with `{ expectedAuthorizationRevision: 2, expectedEvidenceDigest: "<sha256>" }`.
- Outcomes:
  - **`200 OK` (`applied: true`)**: Atomically claims `EXECUTING` (`authorizationRevision: 3`) with `executionClaimToken`, applies financial transition inside [`executeApprovedTransitionTx`](file:///c:/Users/user/Documents/Bernie%20Project/Iriefishmonger%20platform/backend/src/modules/payments/repositories/refund-reconciliation-execution.helper.ts#L122-L380), appends `MANUAL_RECONCILIATION_APPLIED`, enqueues `PaymentOutbox`, and commits `APPLIED` (`authorizationRevision: 4`).
  - **`409 Conflict` (`code: "RECONCILIATION_APPROVAL_EXPIRED"`)**: TTL elapsed; row transitioned to terminal `EXPIRED` with zero ledger mutations. Start a fresh request if still needed.
  - **`409 Conflict` (`code: "RECONCILIATION_QUARANTINED"`)**: Integrity or staleness check tripped (Section 6); row transitioned to terminal `QUARANTINED`, `REFUND_RECONCILIATION_APPROVAL_QUARANTINED` queued in `PaymentOutbox`, zero ledger mutations.
- **Pre-Execution Abort:** Any `ACTIVE` administrator may revoke an unexecuted `REQUESTED` or `APPROVED` row via `POST /admin/refund-reconciliation/approvals/:approvalId/revoke` with `{ revocationReason }` if circumstances change prior to execution.

---

## 4. Required Evidence Before Resolution (By Outcome)

| `requestedOutcome` | Required Evidence Before Approval / Execution | Resulting Financial State |
| :--- | :--- | :--- |
| **`VERIFIED_COMPLETED`** | 1. Non-empty `externalSettlementReference` verified in WiPay portal/WAPI (distinct from parent `Payment.providerReference` and unused elsewhere).<br>2. Portal settlement receipt/statement matching `obligation.authorizedAmount` & `currency` + canonical `evidenceDigest`.<br>3. All referenced `evidenceReceiptIds` match `provider`, `merchantAccountId`, `obligationId`, and `attemptId` (if given), with **zero** `SIGNATURE_REJECTED` receipts. | Target non-terminal attempt -> `COMPLETED` (`DUAL_CONTROL_ADMIN_RECONCILIATION`), OR (if prior attempt already `FAILED` / `CANCELLED_BEFORE_DISPATCH` / null) creates replacement `Refund` (`COMPLETED`) + `MANUAL_PORTAL_SETTLEMENT` attempt; updates `Payment` (`PARTIALLY_REFUNDED` / `REFUNDED`); `RefundObligation` -> `FULFILLED`. |
| **`VERIFIED_FAILED`** | 1. Authoritative WAPI query or WiPay merchant portal confirmation that **zero funds remitted** and attempt permanently failed/absent.<br>2. Linked inquiry receipt(s) or portal screenshot/CSV hash (`evidenceDigest`) + `rationale`. | Non-terminal attempt -> `FAILED` (`PROVIDER_DEFINITIVE_DECLINE`, `retryEligible: true`), `Refund` -> `FAILED`; already-`FAILED`/`CANCELLED` attempts log audit event only; `RefundObligation` -> `OPEN`. |
| **`CONTINUE_QUARANTINE`** | 1. Incident ticket / investigation rationale (`>= 10 chars`).<br>2. Ambiguous/contradictory receipt UUIDs or summary digest explaining hold reason. | Appends `MANUAL_RECONCILIATION_APPLIED` audit event (if attempt bound) and enforces `RefundObligation.status = RECONCILE_REQUIRED` so automated retries remain blocked. |
| **`VOID_OBLIGATION`** | 1. Finance Lead written authorization reference + commercial cancellation/overpayment correction proof.<br>2. Verified **zero** active/completed attempts (`PREPARED`, `DISPATCHING`, `PROVIDER_PENDING`, `AMBIGUOUS_OUTCOME`, `COMPLETED`) and **zero** active non-failed vendor-order refund allocations. | `RefundObligation` -> `CANCELLED_VOIDED` (`voidApprovalId` recorded); `REFUND_OBLIGATION_VOIDED` outbox event emitted. |

---

## 5. Quarantine Escalation Playbook

[`checkPreExecutionIntegrityTx`](file:///c:/Users/user/Documents/Bernie%20Project/Iriefishmonger%20platform/backend/src/modules/payments/repositories/refund-dual-control-query.helper.ts#L33-L121) and [`checkStaleStateOrContradictionsTx`](file:///c:/Users/user/Documents/Bernie%20Project/Iriefishmonger%20platform/backend/src/modules/payments/repositories/refund-reconciliation-binding.helper.ts#L276-L347) fail closed by transitioning an approval to `QUARANTINED` (`409 Conflict`, `RECONCILIATION_QUARANTINED`) if any of the following occurs:

1. **Actor Eligibility Drift:** Requester or Approver ceased to be `UserStatus.ACTIVE` with `RoleName.ADMINISTRATOR` before execution.
2. **Digest / Binding Tampering:** Canonical `requestDigest`, `approvalDigest`, `expectedEvidenceDigest`, or bound financial/merchant fields (`paymentId`, `provider`, `merchantAccountId`, `amount`, `currency`) diverge from locked obligation/payment state.
3. **Reference or Receipt Invalidation:** `externalSettlementReference` echoes parent `Payment.providerReference` or collides with another attempt/approval, or a bound `RefundEvidenceReceipt` mismatches scope / holds `SIGNATURE_REJECTED`.
4. **Concurrent State Drift or Newer Attempt:** Obligation moved to `FULFILLED` or `CANCELLED_VOIDED`, target attempt moved to `COMPLETED`, or a newer `attemptSequence` was created after target selection.
5. **Contradictory Post-Request Evidence:** A newer `RefundEvidenceReceipt` (`disposition` in `APPLIED` or `CONFLICT_REJECTED`) arrived after `approval.requestedAt` and was not bound to the approval.

**Operator Response:**
1. **Do NOT retry execution or attempt to bypass via direct SQL.** Financial ledger tables enforce append-only immutability triggers (`Migrations #59–#70`).
2. Escalate to **Payments Engineering On-Call** and **Finance Lead** with `approvalId`, `obligationId`, `quarantineReason`, and the full `events` timeline from `GET /approvals/:approvalId`.
3. Run `GET /obligations/:obligationId` to identify what drifted (new webhook receipt, new attempt sequence, superseded approval, or deactivated admin).
4. If external truth remains uncertain, obtain a fresh `CONTINUE_QUARANTINE` approval to preserve an explicit investigation checkpoint until authoritative portal proof is obtained.
5. Only once the newest state and receipts are verified may `Admin A` open a new bound `REQUESTED` approval targeting the current authoritative state.

---

## 6. Late Completion After Terminal `FAILED` Playbooks

When an earlier refund `R1` / attempt `A1` transitioned to terminal `FAILED` (e.g., timeout, ambiguous disconnect, or late callback/settlement), Migration `#61` preserves `R1` permanently as immutable `FAILED`. Before submitting any reconciliation request, inspect `GET /admin/refund-reconciliation/obligations/:obligationId` to determine which of the three topologies applies:

### Scenario A — Late Completion After `FAILED` with NO Replacement (`A2`/`R2` Does Not Exist)
- **Ledger State:** `R1` (`FAILED`), `A1` (`FAILED` or `CANCELLED_BEFORE_DISPATCH`), no non-failed `Refund` or newer `attemptSequence`, `obligation.status` is `OPEN` or `RECONCILE_REQUIRED`.
- **Procedure:**
  1. Verify WiPay portal/WAPI confirms settled refund `extRef` matching `obligation.authorizedAmount` and NOT matching parent charge `Payment.providerReference`.
  2. `Admin A` requests `VERIFIED_COMPLETED` on `obligationId` (latest `attemptId = A1.id` if `A1` is latest sequence) with `externalSettlementReference = extRef` and portal proof digest. `resolveActionTypeForOutcome` automatically binds `MANUAL_OFFLINE_SETTLEMENT_COMPLETED`.
  3. `Admin B` independently verifies portal statement and approves; `Admin B`/`Admin C` executes.
- **Expected Outcome:** [`applyVerifiedCompletedTransitionTx`](file:///c:/Users/user/Documents/Bernie%20Project/Iriefishmonger%20platform/backend/src/modules/payments/repositories/refund-reconciliation-completion.helper.ts#L141-L257) leaves immutable `R1`/`A1` untouched as `FAILED`, creates replacement `Refund` `R2` (`supersedesRefundId = R1.id`, `idempotencyKey = "${obligation.obligationKey}:manual:${attemptCount + 1}"`, transitioned to `COMPLETED`) and `RefundProviderAttempt` `A2` (`executionChannel = MANUAL_PORTAL_SETTLEMENT`, `providerRefundReference = extRef`, `status = COMPLETED`, `resolvedByProvenance = DUAL_CONTROL_ADMIN_RECONCILIATION`), recalculates `Payment` (`PARTIALLY_REFUNDED` / `REFUNDED`, enforcing aggregate `<= payment.amount`), and sets `RefundObligation` -> `FULFILLED`.

### Scenario B — Late Completion After `FAILED` with an In-Flight Replacement (`A2` Active / `R2` Non-Failed)
- **Ledger State:** `R1` is `FAILED`, while a replacement `R2` (`REQUIRED` / `PROCESSING`) or `A2` (`PREPARED` / `DISPATCHING` / `PROVIDER_PENDING` / `AMBIGUOUS_OUTCOME`) already exists.
- **Safety Rule:** **NEVER finalize `A1` while `A2` is still active.** Requesting reconciliation on superseded `A1` is rejected (`superseded by a newer attempt`), and executing an older approval targeting `A1` once `A2` exists triggers automatic `QUARANTINED` (`Newer attempt(s) created on obligation "..." after approval target`).
- **Procedure:**
  1. **Quarantine Hold:** Escalate immediately to **Payments Engineering On-Call** + **Finance Lead**. If `obligation.status !== 'RECONCILE_REQUIRED'`, apply `CONTINUE_QUARANTINE` (note: targeting latest `A2` or without stale `A1`) or leave in quarantine so automated retry dispatch remains blocked.
  2. **Audit Both `A1` and `A2` at WiPay:** Check WiPay merchant portal / WAPI for BOTH `A1`'s late reference `extRef1` AND `A2`'s idempotency/transaction state.
  3. **Branch 1 (`A2` confirmed definitively NOT settled / declined / never reached gateway):** First resolve `A2` with `VERIFIED_FAILED` targeting `attemptId = A2.id` (marks `A2` + `R2` as terminal `FAILED`, keeps `obligation` `OPEN`). Then execute Scenario A (`VERIFIED_COMPLETED` referencing `extRef1` on the obligation with `A2.id` as latest attempt) to record clean `MANUAL_PORTAL_SETTLEMENT` `FULFILLED`.
  4. **Branch 2 (BOTH `A1` and `A2` remitted funds at WiPay — Gateway Double Settlement):** Execute **Scenario C** immediately (settle the ledger cleanly once if `A2` is completing, and escalate gateway over-refund to Treasury / Finance Lead for acquirer recovery).

### Scenario C — Late Completion After `FAILED` with an Already-Settled Replacement (`A2` / `R2` `COMPLETED`, `obligation = FULFILLED`)
- **Ledger State:** `R1` is `FAILED`, replacement `R2` / `A2` already settled `COMPLETED` under `extRef2`, `RefundObligation.status === FULFILLED`.
- **Safety Rule:** The API rejects all reconciliation mutations on `FULFILLED` obligations or `COMPLETED` attempts (`409 Conflict`), and `applyVerifiedCompletedTransitionTx` rejects aggregate refunds exceeding `payment.amount`. **Do NOT forge or append a second settled refund against the order.**
- **Procedure:**
  1. **Confirm Distinct Fund Movements:** Finance Lead + Payments Engineering confirm in WiPay settlement reports whether `extRef1` (late `A1`) and `extRef2` (`A2`) caused two separate payouts/debits vs a single settlement alias.
  2. **Finance / Treasury Recovery:** Open a high-priority Financial Reconciliation Incident attaching `paymentId`, `obligationId`, `A1.id`, `A2.id`, `extRef1`, `extRef2`, and bank/WiPay settlement CSV hashes. Treasury/Finance executes merchant-acquirer recall, chargeback defense, or manual general-ledger receivable booking outside the order payment status, leaving customer `Payment` accurately recorded as `REFUNDED` / `PARTIALLY_REFUNDED`.


---

## 7. Pre-Activation WiPay Jamaica Provisioning Requirements (Blocking `5A`–`5D`)

Because isolated inspection confirmed that neither `backend/.env`, environment variables, nor staging secret mappings contain WAPI sandbox settings (`5A`–`5D` remain **`PENDING`**), WiPay MUST supply all five items below before live sandbox verification can execute:

| # | Missing Provisioning Item | Isolated Sandbox Env Variable (Non-Checkout) | Isolation / Validation Constraint |
| :---: | :--- | :--- | :--- |
| 1 | Confirmed Jamaica **WAPI** sandbox base URL / origin | `WIPAY_WAPI_SANDBOX_BASE_URL` | Must be `https://`, must NOT reuse legacy `tx.wipayfinancial.com` or production (`jm.` / `tt.` / `bb.` / `gy.` / `api.`) hosts, confirmed via [`resolveIsolatedWiPayWapiSandboxConfig`](file:///c:/Users/user/Documents/Bernie%20Project/Iriefishmonger%20platform/backend/src/modules/payments/testing/wipay-wapi-sandbox-contract.helper.ts#L100-L187). |
| 2 | Sandbox WAPI merchant credentials + explicit confirmation that refund (`/wapi/transactions/createRefundRequest`) & status inquiry are enabled for the JM sandbox merchant | `WIPAY_WAPI_CLIENT_ID` + `WIPAY_WAPI_CLIENT_SECRET` *(or dedicated `WIPAY_WAPI_KEY`)* | Separate from checkout `WIPAY_API_KEY`; test harness rejects reusing `WIPAY_API_KEY`. |
| 3 | Authoritative WAPI request/response & retry contract for JM sandbox | *(Verified contract documentation)* | Exact auth header format, idempotency key parameter/header, partial-refund rules, `PENDING`/`COMPLETED`/`FAILED`/timeout codes, and guarantee that refund ID never aliases parent `transaction_id`. |
| 4 | Settled Jamaica sandbox charge eligible for refund | `WIPAY_SANDBOX_REFUNDABLE_TXN_ID` *(or sandbox checkout flow)* | Distinct charge ref; additionally `backend/.env` checkout config currently sets `WIPAY_API_URL` to `tx.wipayfinancial.com` with `WIPAY_FEE_STRUCTURE` unset (sandbox hosted checkout requires `https://jmsb.wipayfinancial.com/plugins/payments` + `WIPAY_FEE_STRUCTURE`). |
| 5 | Confirmation of sandbox refund webhook support + `X-WiPay-Webhook-Event` names + endpoint signing secret | `WIPAY_SANDBOX_WEBHOOK_SECRET` | Separate from checkout `WIPAY_API_KEY`; verified via `HMAC-SHA256(timestamp + "." + raw_body, endpointSecret)` within 300s replay window ([`verifyWiPayWapiWebhookHeaders`](file:///c:/Users/user/Documents/Bernie%20Project/Iriefishmonger%20platform/backend/src/modules/payments/testing/wipay-wapi-sandbox-contract.helper.ts#L199-L244)). |

---

## 8. Verified Offline / Mock Scope vs. Pending Live WiPay WAPI Scope

| Capability | Current Status | Verification Basis & Evidence Boundary |
| :--- | :---: | :--- |
| Real [`WiPayAdapter`](file:///c:/Users/user/Documents/Bernie%20Project/Iriefishmonger%20platform/backend/src/modules/payments/providers/wipay.adapter.ts#L1-L169) fail-closed boundary (`refundPayment`, `verifyPayment`, `verifyRefundStatus` = `501`, non-sandbox rejected) | **VERIFIED** | [`wipay.adapter.spec.ts`](file:///c:/Users/user/Documents/Bernie%20Project/Iriefishmonger%20platform/backend/src/modules/payments/providers/wipay.adapter.spec.ts), [`wipay-boundary.spec.ts`](file:///c:/Users/user/Documents/Bernie%20Project/Iriefishmonger%20platform/backend/src/modules/payments/services/wipay-boundary.spec.ts), PG spec `4A` (`0` external calls). |
| Production HTTP `501 Not Implemented` gate on `/admin/refund-reconciliation/*` | **VERIFIED** | PG spec `4D` with `NODE_ENV=production` + `REFUND_RECONCILIATION_API_ENABLED='true'` + policy override. |
| Isolated checkout vs WAPI vs webhook config loader, 5-header `HMAC-SHA256` verifier (`300s` replay), & WAPI response classifier | **VERIFIED (Offline Unit/Synthetic)** | [`wipay-wapi-sandbox-contract.spec.ts`](file:///c:/Users/user/Documents/Bernie%20Project/Iriefishmonger%20platform/backend/src/modules/payments/testing/wipay-wapi-sandbox-contract.spec.ts) (`0` network calls; synthetic vectors only). |
| Sandbox lifecycle (`PENDING` poll, duplicate webhooks, echoed ref rejection, timeout quarantine, secret redaction, dual-control settlement) | **VERIFIED (Local Mocks + PG)** | PG specs `4B`–`4C` and core recovery/evidence specs (`refund-evidence-reconciliation`, `refund-status-poll-and-outbox`); mocks used in place of live WiPay HTTP. |
| Live Jamaica WAPI auth, refund initiation, inquiry polling, retry/duplicate semantics, settlement ref uniqueness, & webhook delivery | **`PENDING`** | Placeholders `5A`–`5D` in [`wipay-sandbox-refund-reconciliation.postgres.integration.spec.ts`](file:///c:/Users/user/Documents/Bernie%20Project/Iriefishmonger%20platform/backend/src/modules/payments/testing/wipay-sandbox-refund-reconciliation.postgres.integration.spec.ts#L368-L384) remain `it.skip` until WiPay provides Section 7 items. |

---

## 9. Verified Playbooks for Pending, Duplicate, and Ambiguous Refund Outcomes

### 9.1 Pending Outcomes (`PROVIDER_PENDING` / `PENDING_PROVIDER`)
1. **Verified Ledger Behavior:** Initial asynchronous/pending gateway acceptance transitions the attempt to `PROVIDER_PENDING` (`Refund = PENDING`, `RefundObligation = PENDING_PROVIDER`) and emits `REFUND_STATUS_CHANGED`. Subsequent `PENDING` inquiry/webhook evidence handled by [`applyPendingEvidenceTx`](file:///c:/Users/user/Documents/Bernie%20Project/Iriefishmonger%20platform/backend/src/modules/payments/repositories/refund-evidence-outcomes.helper.ts#L31-L173) records `APPLIED` evidence and an attempt event without emitting duplicate `REFUND_STATUS_CHANGED` outbox rows; if the attempt is already `AMBIGUOUS_OUTCOME`, pending evidence preserves `AMBIGUOUS_OUTCOME` and `RECONCILE_REQUIRED`.
2. **Polling Serialization:** [`RefundStatusReconciliationService.reconcileAttemptStatus`](file:///c:/Users/user/Documents/Bernie%20Project/Iriefishmonger%20platform/backend/src/modules/payments/services/refund-status-reconciliation.service.ts#L53-L192) claims a `30_000 ms` `pollLockUntil` CAS lease; overlapping workers receive `SKIPPED_LEASED_OR_INELIGIBLE`, and thrown poll errors release `pollLockUntil` cleanly.
3. **Current Live Operator Action (`supportsRefundStatusLookup = false`):** Automated WiPay polling fails closed with `501 NotImplementedException`. **Never** dispatch a second refund attempt while `PENDING_PROVIDER`. Confirm status directly in the WiPay Merchant Portal and resolve via Dual Control (`VERIFIED_COMPLETED` with settlement reference, `VERIFIED_FAILED` only upon confirmed zero remittance, or `CONTINUE_QUARANTINE` if still settling).

### 9.2 Duplicate Outcomes, Replay & Identifier Collisions
1. **Exact Duplicate Webhook / Poll (`DUPLICATE_EXACT`):** Identical `(provider, merchantAccountId, providerEventId)` matching existing `attemptId`, `evidenceDigest`, `providerRefundReference`, and compatible `outcome` (per [`detectExternalEventReplayTx`](file:///c:/Users/user/Documents/Bernie%20Project/Iriefishmonger%20platform/backend/src/modules/payments/repositories/refund-evidence-validation.helper.ts#L83-L124)) is persisted as `RefundEvidenceReceipt(disposition = DUPLICATE_IGNORED)` (`applied: false, quarantined: false`) with zero ledger mutation.
2. **Benign Terminal Replay:** Repeated `COMPLETED`/`PENDING` evidence on an already-`COMPLETED` attempt (or `FAILED`/`PENDING` on `FAILED`/`CANCELLED_BEFORE_DISPATCH`) records `DUPLICATE_IGNORED`.
3. **Client `Idempotency-Key` Replay:** Replaying `refundByPaymentId` with the same idempotency key while completed, in-flight, or quarantined (`AMBIGUOUS_OUTCOME`) returns existing persisted state without calling `refundPayment` a second time.
4. **Signature / Replay-Window Rejections (`SIGNATURE_REJECTED`):** Bad `HMAC-SHA256(timestamp + "." + raw_body, endpointSecret)`, missing `X-WiPay-Webhook-*` headers, `|now - timestamp| > 300s`, or untrusted adapter provenance records `SIGNATURE_REJECTED` with zero ledger mutation. Dual-control `VERIFIED_COMPLETED` approvals cannot reference `SIGNATURE_REJECTED` receipts.
5. **Conflicting Event Reuse & Identifier Collisions (`CONFLICT_REJECTED` -> Quarantine):** Reusing `providerEventId` with mismatched digest/outcome/attempt, echoing parent `Payment.providerReference` (`parentPaymentReference`), cross-attempt `providerRefundReference` reuse, or amount/currency mismatch invokes [`recordConflictAndQuarantineTx`](file:///c:/Users/user/Documents/Bernie%20Project/Iriefishmonger%20platform/backend/src/modules/payments/repositories/refund-evidence-quarantine.helper.ts#L27-L181): logs `CONTRADICTION_QUARANTINED`, transitions non-terminal attempt -> `AMBIGUOUS_OUTCOME` (`retryEligible = false`) and non-terminal `Refund` / `RefundObligation` -> `RECONCILE_REQUIRED`, and emits `REFUND_CONTRADICTION_QUARANTINED`. Escalate immediately per Section 5.

### 9.3 Ambiguous Outcomes (`AMBIGUOUS_OUTCOME` / Timeouts / Crashes / Transient Errors)
1. **Entry Conditions:** Network timeout, transient HTTP `5xx`/`429`, unrecognized status string, missing/echoed refund ref on `COMPLETED` ([`classifyWiPayWapiRefundResponse`](file:///c:/Users/user/Documents/Bernie%20Project/Iriefishmonger%20platform/backend/src/modules/payments/testing/wipay-wapi-sandbox-contract.helper.ts#L246-L282)), expired `DISPATCHING` worker lease recovered by [`recoverExpiredDispatchingAttemptWithClient`](file:///c:/Users/user/Documents/Bernie%20Project/Iriefishmonger%20platform/backend/src/modules/payments/repositories/refund-recovery.repository.ts#L29-L100) (`PROCESS_CRASH_SUSPECTED`), or contradiction evidence (`EVIDENCE_CONTRADICTION`).
2. **Fail-Closed Safety Guards:** `retryEligible` is forced to `false`, `RefundObligation` stays `RECONCILE_REQUIRED`, client/worker retries cannot issue a second gateway refund request, `VOID_OBLIGATION` is blocked while `AMBIGUOUS_OUTCOME` attempts exist, and incoming `PENDING` webhooks cannot clear quarantine.
3. **Operator Resolution:** Escalate to **Payments Engineering On-Call** + **Finance Lead**; inspect `GET /admin/refund-reconciliation/obligations/:obligationId`; confirm actual money movement in the WiPay Merchant Portal; then execute Dual Control `VERIFIED_COMPLETED` (if settled externally with unique `externalSettlementReference`), `VERIFIED_FAILED` (only if definitively absent/declined -> reopens obligation to `OPEN`), or `CONTINUE_QUARANTINE`.
