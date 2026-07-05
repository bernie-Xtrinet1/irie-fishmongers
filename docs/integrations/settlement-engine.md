# Settlement Engine

Version: 1.0

---

## Purpose

The Settlement Engine distributes customer payments to vendors.

Customers make one payment.

Vendors receive individual settlements.

---

## Example

Customer Order

50 lbs Snapper

Vendor A:
20 lbs

Vendor B:
15 lbs

Vendor C:
15 lbs

Customer sees:

One order

Settlement Engine sees:

Three allocations

---

## Allocation Formula

Vendor Share

(quantity supplied � total quantity) � product value

Example:

Order Value:
JMD 50,000

Vendor A:
20/50 = 40%

Settlement:
JMD 20,000

---

## Platform Fee

Platform commission is deducted before vendor settlement.

Formula:

Vendor Gross
- Platform Fee
= Vendor Net

---

## Delivery Fees

Delivery fees belong to the platform.

Delivery fees are not included in vendor settlement calculations.

---

## Settlement Status

PENDING

Funds received but not released.

---

APPROVED

Order completed.

Ready for payment.

---

PAID

Vendor payment completed.

---

FAILED

Settlement error.

Requires manual review.

---

## Settlement Triggers

Settlement may occur only when:

Order Status = DELIVERED

AND

Proof of Delivery exists

---

## Refund Handling

If customer receives refund:

Vendor settlements must be recalculated.

---

## Database Entities

Settlement

Fields:

- id
- order_id
- vendor_id
- gross_amount
- platform_fee
- net_amount
- status
- payment_date

---

## Audit Requirements

Every settlement calculation must be stored.

Never overwrite calculations.

Use immutable records.

---

## Future Support

Must support:

- Weekly payouts
- Monthly payouts
- Instant payouts
- Bank transfers

without schema changes.
