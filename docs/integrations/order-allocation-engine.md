# Order Allocation Engine

Version: 1.0

## Purpose

This document is authoritative for all order allocation logic and takes precedence over generated implementation suggestions.

The Order Allocation Engine determines how customer orders are fulfilled when inventory is distributed across multiple vendors.

Customers see:

- One order
- One payment
- One delivery experience

The platform manages:

- Vendor allocation
- Inventory reservation
- Fulfillment coordination
- Settlement calculations

---

## Core Principles

1. Customer experience is prioritized.
2. Minimize number of vendors used.
3. Minimize delivery distance.
4. Preserve inventory accuracy.
5. Reduce logistics costs.
6. Support partial vendor fulfillment.

---

## Allocation Workflow

Customer places order.

Order enters:

PENDING_ALLOCATION

System evaluates:

- Available inventory
- Vendor location
- Vendor status
- Vendor reliability
- Delivery constraints

System creates:

Order Allocations

Order becomes:

ALLOCATED

---

## Allocation Priority

The engine must allocate inventory in the following order:

1. Single vendor fulfillment
2. Closest vendor combination
3. Lowest delivery cost
4. Highest vendor reliability
5. Lowest number of vendor splits

---

## Example

Customer requests:

50 lbs Snapper

Inventory:

Vendor A = 20 lbs
Vendor B = 15 lbs
Vendor C = 40 lbs

Preferred Allocation:

Vendor C = 40 lbs
Vendor B = 10 lbs

Avoid:

Vendor A = 20 lbs
Vendor B = 15 lbs
Vendor C = 15 lbs

Reason:

Fewer vendors involved.

---

## Inventory Reservation

Once allocated:

Inventory must be reserved immediately.

Inventory Status:

AVAILABLE
RESERVED
COMMITTED
RELEASED

---

## Reservation Timeout

Reserved inventory expires after:

30 minutes

if payment is not completed.

Expired reservations return inventory to AVAILABLE.

---

## Allocation Entity

OrderAllocation

Fields:

- id
- order_id
- vendor_id
- product_id
- allocated_quantity
- fulfilled_quantity
- status
- allocated_at

---

## Allocation Status

PENDING

Inventory identified.

---

RESERVED

Inventory reserved.

---

CONFIRMED

Payment successful.

---

FULFILLED

Vendor completed supply.

---

FAILED

Vendor unable to fulfill.

---

CANCELLED

Allocation removed.

---

## Vendor Reliability Score

Each vendor has:

reliability_score

Range:

0-100

Based on:

- Fulfillment success rate
- Cancellation rate
- Delivery compliance
- Quality complaints

When allocations are equal:

Choose higher reliability score.

---

## Distance Optimization

When multiple vendors can satisfy an order:

Prefer vendors closest to:

- Customer delivery location
- Distribution hub
- Consolidation center

---

## Consolidated Delivery

Multiple vendor allocations should be combined into a single delivery whenever possible.

Customer should not receive:

- Multiple invoices
- Multiple payments
- Multiple delivery charges

---

## Reallocation

If vendor becomes unavailable:

System must automatically:

1. Release allocation
2. Search alternate vendors
3. Reallocate inventory
4. Update settlement records

---

## Shortage Handling

If total inventory is insufficient:

Order enters:

BACKORDER_REVIEW

Customer must be notified.

Order cannot proceed automatically.

---

## Multi-Vendor Fulfillment

Supported:

One order
Many vendors

One payment
Many settlements

One delivery
Many inventory sources

---

## Settlement Integration

Every allocation creates:

Settlement Allocation Records

Settlement amounts must be based on:

Actual fulfilled quantity

not

Originally allocated quantity.

---

## Audit Requirements

Allocation decisions must be stored.

Record:

- Allocation timestamp
- Vendor selected
- Quantities assigned
- Optimization factors used

Never overwrite allocation history.

Use immutable audit records.

---

## Future Support

Architecture must support:

- AI allocation optimization
- Route optimization
- Dynamic pricing
- Real-time inventory feeds
- Cold chain logistics

without major schema redesign.

---

## Implementation Directive

Claude shall implement:

AllocationEngine

Responsibilities:

- Allocate inventory
- Reserve stock
- Reallocate shortages
- Generate settlement allocations
- Support multi-vendor fulfillment

Business services must use:

AllocationEngine

and must not implement allocation logic directly.
