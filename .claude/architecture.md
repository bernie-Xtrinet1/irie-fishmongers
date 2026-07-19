# # IRIE FISHMONGERS PLATFORM
# SYSTEM ARCHITECTURE

Version: 2.0

---

# PURPOSE

This document defines the authoritative software architecture for the
Irie Fishmongers Marketplace.

Claude must use this architecture when implementing every module.

The platform is designed as a modular, domain-driven seafood marketplace.

Never implement tightly coupled modules.

Always preserve modular boundaries.

---

# ARCHITECTURAL PRINCIPLES

The platform must be:

• Modular

• Domain Driven

• API First

• Mobile First

• Event Driven

• Secure by Design

• Cloud Ready

• Horizontally Scalable

• Testable

• Configuration Driven

---

# CORE BUSINESS DOMAINS

Authentication

↓

Marketplace

↓

Inventory

↓

Orders

↓

Delivery

↓

Payments

↓

Settlement

↓

Food Safety

↓

Traceability

↓

Notifications

↓

Reporting

↓

Administration

---

# HIGH LEVEL ARCHITECTURE

Customer Apps

Vendor Apps

Driver Apps

Admin Portal

↓

API Gateway

↓

Backend Services

↓

Database

↓

Redis

↓

Storage

↓

Notification Services

---

# APPLICATIONS

apps/

customer-web

vendor-web

admin-web

driver-mobile

customer-mobile

backend-api

---

# BACKEND MODULES

Authentication

Users

Roles

Marketplace

Products

Categories

Inventory

Orders

Delivery

Drivers

Payments

Settlement

Compliance

Food Safety

Cold Chain

Traceability

Notifications

Reporting

Audit

Administration

---

# SHARED PACKAGES

packages/

ui

database

shared

config

types

utilities

---

# DATABASE

PostgreSQL

Primary relational database.

Use Prisma ORM.

---

# CACHE

Redis

Used for:

Stock Reservation

Rate Limiting

Queues

Session Cache

Notifications

Reservation Timers

---

# STORAGE

Object Storage

Vendor Documents

Product Images

Compliance Documents

Invoices

Delivery Proof

Temperature Logs

---

# EVENT ARCHITECTURE

Major modules communicate through events.

Examples:

InventoryReserved

OrderCreated

VendorApproved

DriverAssigned

PaymentCaptured

SettlementCompleted

TemperatureAlert

---

# INVENTORY MODEL

Inventory consists of:

Total Stock

Reserved Stock

Available Stock

Sold Stock

Quarantined Stock

Expired Stock

Available Inventory

=

Total

-

Reserved

---

# ORDER MODEL

Customer Order

↓

Vendor Orders

↓

Driver Assignment

↓

Delivery

↓

Settlement

---

# MULTI VENDOR MODEL

One customer order may become many vendor orders.

One payment.

Many vendors.

Many drivers.

One customer experience.

---

# PAYMENT MODEL

Customer

↓

Marketplace

↓

Settlement Engine

↓

Vendor

↓

Driver

↓

Platform Commission

---

# DELIVERY MODEL

Delivery Zones

↓

Drivers

↓

Pickup

↓

Cold Chain

↓

Delivery Confirmation

↓

Customer Acceptance

---

# FOOD SAFETY MODEL

Catch

↓

Landing

↓

Inspection

↓

Inventory

↓

Reservation

↓

Packing

↓

Pickup

↓

Delivery

↓

Acceptance

↓

Archive

---

# TRACEABILITY

Every seafood item must be traceable.

Track:

Vendor

Catch Date

Catch Location

Landing Site

Batch

Temperature

Driver

Customer

---

# SECURITY

JWT

RBAC

Audit Logs

Encrypted Secrets

Rate Limiting

Document Verification

---

# UI PRINCIPLES

Responsive

Mobile First

Accessibility

Reusable Components

Consistent Branding

---

# DATABASE PRINCIPLES

No duplicated data.

Soft deletes where appropriate.

Audit all financial operations.

Atomic inventory updates.

Never allow negative stock.

---

# CLAUDE EXECUTION RULE

Before implementing any feature:

Identify the affected domain.

Locate related markdown specifications.

Reuse existing services.

Avoid duplicate functionality.

Respect module boundaries.

Never bypass business rules.

Never violate food safety rules.

Never hardcode business logic that should be configurable.