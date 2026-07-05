# Driver Settlement Engine

Version: 1.0

This document is authoritative for all driver compensation calculations and takes precedence over generated implementation suggestions.

---

# Purpose

The Driver Settlement Engine calculates, tracks, approves, and pays driver compensation.

The system must support:

- Personal vehicle drivers
- Company vehicle drivers
- Single delivery orders
- Multi-vendor orders
- Weekly settlement cycles
- Distance-based compensation
- Performance bonuses

---

# Business Principles

Customer delivery pricing and driver compensation are separate calculations.

Driver compensation must support:

- Driver retention
- Customer affordability
- Platform profitability

Driver compensation shall not be calculated solely from a fixed trip fee.

The platform shall optimize compensation using:

- Delivery volume
- Distance travelled
- Load weight
- Performance metrics

---

# Driver Types

PERSONAL_VEHICLE

Driver uses own vehicle.

Driver absorbs:

- Fuel
- Maintenance
- Insurance

Compensation includes:

- Delivery fee
- Distance compensation
- Performance bonuses

---

COMPANY_VEHICLE

Driver uses company vehicle.

Company absorbs:

- Fuel
- Maintenance
- Insurance

Compensation includes:

- Delivery fee
- Performance bonuses

Distance compensation may be reduced.

---

# Compensation Components

## Base Delivery Fee

Paid for each completed delivery.

Example:

JMD 150

---

## Distance Compensation

Applied only when enabled.

Formula:

distance_km � distance_rate

Example:

12 km � JMD 20

= JMD 240

---

## Heavy Load Bonus

Applied when order weight exceeds threshold.

Example:

50 lbs seafood

Bonus:

JMD 200

---

## Peak Demand Bonus

Applied during:

- Holidays
- Weekends
- Severe weather
- High demand periods

---

## Weekly Volume Bonus

Encourages driver productivity.

Example:

20 deliveries = JMD 1,000 bonus

40 deliveries = JMD 3,000 bonus

60 deliveries = JMD 5,000 bonus

---

# Driver Settlement Formula

PERSONAL_VEHICLE

Driver Payout =

Base Delivery Fee
+ Distance Compensation
+ Heavy Load Bonus
+ Peak Demand Bonus
+ Weekly Volume Bonus

---

COMPANY_VEHICLE

Driver Payout =

Base Delivery Fee
+ Heavy Load Bonus
+ Peak Demand Bonus
+ Weekly Volume Bonus

---

# Delivery Completion Rules

Driver compensation may only be generated when:

Order Status = DELIVERED

AND

Proof Of Delivery exists.

---

# Proof Of Delivery

Supported:

- Customer signature
- Photo evidence
- OTP verification

One proof method is required.

---

# Settlement Status

PENDING

Delivery completed.

Awaiting payout processing.

---

APPROVED

Validated.

Ready for payment.

---

PAID

Funds transferred.

---

FAILED

Payment failed.

Requires review.

---

DISPUTED

Compensation under review.

---

# Settlement Cycle

Default:

Weekly

Settlement Window:

Monday 00:00
through
Sunday 23:59

Payout Date:

Wednesday

---

# Multi-Order Optimization

Multiple deliveries may be grouped into a route.

Driver compensation is based on:

Completed deliveries

not

Number of vendor pickups.

Example:

3 vendor pickups

1 customer delivery

Count as:

1 completed delivery

---

# Customer Delivery Revenue

Customer delivery fee does not directly determine driver compensation.

Example:

Customer Delivery Fee:

JMD 1,500

Driver Compensation:

JMD 700

Platform Logistics Margin:

JMD 800

---

# Driver Settlement Entity

DriverSettlement

Fields:

- id
- driver_id
- order_id
- vehicle_type
- base_fee
- distance_fee
- heavy_load_bonus
- peak_bonus
- volume_bonus
- total_payout
- status
- settlement_period
- payout_date
- created_at

---

# Audit Requirements

All compensation calculations must be stored.

Store:

- formula used
- distance used
- bonuses applied
- approval timestamp

Never overwrite calculations.

Use immutable records.

---

# Future Support

Architecture must support:

- Dynamic pricing
- Route optimization
- Driver ratings
- Incentive campaigns
- Fleet management
- Instant payouts

without schema redesign.

---

# Implementation Directive

Claude shall implement:

DriverSettlementEngine

Responsibilities:

- Calculate payouts
- Track delivery volume
- Apply bonuses
- Generate weekly settlements
- Support driver payment processing

Business services must use:

DriverSettlementEngine

and shall not implement compensation calculations directly.
