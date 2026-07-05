# ADR-002 Delivery Zones

Status:
Approved

Date:
2026-07-05

---

## Context

IrieFishmongers operates a multi-vendor seafood marketplace that requires:

- Cold-chain logistics
- Multi-vendor fulfillment
- Consolidated deliveries
- Scalable transportation operations

As order volume grows, managing deliveries solely through individual drivers becomes inefficient.

The business intends to:

- Reduce transportation costs
- Improve delivery consistency
- Optimize route planning
- Deploy refrigerated fleet assets
- Establish dedicated delivery zones

---

## Decision

The platform shall operate using geographic delivery zones.

Initial target:

Zone 1
Zone 2
Zone 3

Each zone represents an operational logistics region.

Future fleet planning assumes:

One refrigerated truck per zone.

---

## Business Objectives

Delivery zones exist to:

- Reduce delivery costs
- Improve route efficiency
- Consolidate deliveries
- Improve customer experience
- Support cold-chain compliance
- Improve fleet utilization

---

## Architectural Requirements

All logistics services must be zone-aware.

The following systems must support zones:

- Order Allocation Engine
- Fleet Management Engine
- Driver Settlement Engine
- Route Planning Engine
- Delivery Scheduling
- Reporting and Analytics

---

## Zone Assignment

Every delivery address must belong to a delivery zone.

Example:

Customer Address
    ↓
Zone Resolution Service
    ↓
Assigned Zone

---

## Vendor Assignment

Vendors may operate in one or more zones.

Vendor records must support:

- Primary Zone
- Secondary Zones

---

## Driver Assignment

Drivers may be assigned to:

- Single Zone
- Multiple Zones

Zone assignment shall be configurable.

---

## Fleet Assignment

Fleet assets must be assigned to zones.

Examples:

Zone 1 Truck
Zone 2 Truck
Zone 3 Truck

Fleet assignment must support:

- Company-owned vehicles
- Rented vehicles
- Driver-owned vehicles

---

## Order Allocation Rules

When allocating inventory:

Prefer vendors located within the customer's zone.

If inventory is unavailable:

Allow cross-zone allocation.

Cross-zone allocations should be minimized.

---

## Delivery Planning Rules

Route optimization shall prioritize:

1. Same-zone deliveries
2. Lowest travel distance
3. Delivery consolidation
4. Cold-chain efficiency

---

## Delivery Consolidation

Orders within the same zone may be grouped.

Example:

10 deliveries
within Zone 1

may be assigned to:

1 refrigerated truck route

instead of

10 independent trips.

---

## Future Fleet Strategy

Current State

- Driver-owned vehicles
- Rented refrigerated trucks

Target State

- One company-owned refrigerated truck per zone

Long-Term Goal

Zone 1:
1 Company Freezer Truck

Zone 2:
1 Company Freezer Truck

Zone 3:
1 Company Freezer Truck

---

## Data Model Requirements

The platform shall support:

DeliveryZone

Fields:

- id
- name
- code
- description
- active

---

Vendor

Additional Fields:

- primary_zone_id

---

Driver

Additional Fields:

- assigned_zone_id

---

FleetAsset

Additional Fields:

- zone_id

---

Order

Additional Fields:

- delivery_zone_id

---

## Reporting Requirements

The platform shall provide:

- Orders per zone
- Revenue per zone
- Delivery costs per zone
- Fleet utilization per zone
- Vendor performance per zone

---

## Consequences

Positive

- Better route optimization
- Lower delivery costs
- Improved cold-chain management
- Easier fleet scaling
- Better operational visibility

Negative

- Additional planning complexity
- Zone management required
- Cross-zone fulfillment handling required

---

## Future Review

Review annually.

Review triggers:

- New geographic expansion
- Additional delivery zones
- New fleet assets
- Regional distribution centers

---

## Implementation Directive

Claude shall:

- Treat delivery zones as first-class entities
- Build all logistics services with zone awareness
- Support future expansion beyond three zones
- Avoid hardcoded zone logic

This ADR takes precedence over generated logistics architecture suggestions.