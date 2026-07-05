# IrieFishmongers System Architecture

Version: 1.0

---

# Architecture Philosophy

The platform shall be built as:

- Modular Monolith (Phase 1)
- Service-Oriented Architecture Ready
- Event-Driven Ready
- API-First
- Cloud-Native
- Mobile-First

The architecture must support future migration to microservices without requiring major redesign.

---

# High-Level System Overview

?????????????????????????
? Web Application       ?
?????????????????????????
           ?
?????????????????????????
? API Gateway           ?
?????????????????????????
           ?
 ??????????????????????
 ?         ?          ?
 ?         ?          ?

Auth   Products   Orders

 ?         ?          ?

Payments Delivery Vendors

           ?

Dashboard / Analytics

           ?

PostgreSQL + Redis

---

# Client Applications

## Customer Web

Purpose:

- Browse products
- Place orders
- Track deliveries
- Manage account

Location:

apps/web

---

## Customer Mobile

Purpose:

- Mobile ordering
- Real-time tracking

Location:

apps/customer-mobile

---

## Vendor Mobile

Purpose:

- Manage inventory
- Accept orders
- View reports

Location:

apps/vendor-mobile

---

## Driver Mobile

Purpose:

- Manage deliveries
- Update status
- Navigation

Location:

apps/driver-mobile

---

# Backend Architecture

Location:

backend/api

Pattern:

Modular NestJS Architecture

Modules:

- Authentication
- Users
- Vendors
- Products
- Inventory
- Orders
- Payments
- Settlements
- Delivery
- Notifications
- Reviews
- Analytics
- Admin

Each module is self-contained.

---

# Authentication Module

Responsibilities:

- Registration
- Login
- Token management
- Password reset
- Role authorization

Roles:

- Customer
- Vendor
- Driver
- Administrator

---

# Vendor Module

Responsibilities:

- Vendor registration
- Vendor approval
- Store management
- Vendor analytics

Relationships:

Vendor ? Products
Vendor ? Orders
Vendor ? Settlements

---

# Product Module

Responsibilities:

- Product catalog
- Product search
- Product images
- Inventory display

Relationships:

Vendor ? Products

---

# Inventory Module

Responsibilities:

- Inventory management
- Stock reservation
- Inventory allocation

Must support:

- Single vendor fulfillment
- Multi-vendor fulfillment

Inventory may never become negative.

---

# Order Module

Responsibilities:

- Cart management
- Order creation
- Order lifecycle
- Multi-vendor allocation

Order states:

Pending
Accepted
Preparing
ReadyForPickup
Assigned
InTransit
Delivered
Cancelled

---

# Multi-Vendor Fulfillment Engine

Purpose:

Aggregate inventory from multiple vendors.

Example:

Customer requests:

50 lbs Snapper

Vendor A = 20 lbs
Vendor B = 15 lbs
Vendor C = 15 lbs

System creates:

Master Order
Vendor Order A
Vendor Order B
Vendor Order C

Customer sees:

1 Order

Platform manages:

3 Vendor Orders

---

# Location-Aware Allocation Engine

Purpose:

Optimize vendor selection.

Priority:

1. Delivery Zone
2. Distance To Customer
3. Inventory Availability
4. Vendor Rating
5. Delivery Cost

Goal:

Minimize delivery cost and travel time.

---

# Payment Module

Responsibilities:

- Payment processing
- Payment verification
- Refund processing

Providers:

- WiPay
- Stripe

Customer pays once.

System distributes funds internally.

---

# Settlement Engine

Purpose:

Automatic vendor payouts.

Example:

Order Total = JMD $10,000

Vendor A = $4,000
Vendor B = $3,500
Vendor C = $2,500

Platform Fee = $500

System records:

Vendor Settlement A
Vendor Settlement B
Vendor Settlement C

Settlement processing may occur:

- Immediately
- Daily
- Weekly

Configurable.

---

# Delivery Module

Responsibilities:

- Driver assignment
- Route management
- Delivery tracking
- Proof of delivery

Supports:

- Single Vendor Pickup
- Multi-Vendor Pickup

---

# Delivery Consolidation Engine

Purpose:

Reduce customer delivery costs.

Rule:

If multiple vendors exist within a configurable radius:

Example:

5 km

System attempts:

- Single driver
- Consolidated pickup route

Result:

One delivery fee
One customer delivery

---

# Notification Module

Responsibilities:

- Email notifications
- Push notifications
- Future SMS

Events:

Order Created
Payment Received
Vendor Accepted
Driver Assigned
Delivered

---

# Review Module

Responsibilities:

- Product reviews
- Vendor reviews

Requirements:

Delivered orders only.

---

# Analytics Module

Provides:

- Revenue reporting
- Vendor performance
- Customer trends
- Delivery metrics

---

# Admin Module

Responsibilities:

- Vendor approval
- User management
- Dispute resolution
- System monitoring

---

# Data Architecture

Primary Database:

PostgreSQL

Purpose:

- Transactional data
- Orders
- Payments
- Vendors
- Customers

---

# Cache Layer

Redis

Purpose:

- Sessions
- Rate limiting
- Search caching
- Queue management

---

# Storage Architecture

AWS S3

Stores:

- Product images
- Vendor documents
- Delivery proof images

---

# Search Architecture

Phase 1

PostgreSQL Full Text Search

Phase 2

Elasticsearch

Search Targets:

- Products
- Vendors
- Locations

---

# Event Architecture

Future Ready

Events:

OrderCreated
OrderAccepted
PaymentReceived
InventoryReserved
DriverAssigned
OrderDelivered
SettlementCreated

Use:

BullMQ + Redis

---

# Security Architecture

Authentication:

JWT

Authorization:

Role-Based Access Control

Security Controls:

- Helmet
- Rate Limiting
- Input Validation
- Audit Logging

---

# Scalability Strategy

Phase 1

Modular Monolith

Phase 2

Extract Services:

- Payments
- Notifications
- Delivery

Phase 3

Full Service-Oriented Architecture

---

# Deployment Architecture

Development

Docker Compose

Services:

- API
- PostgreSQL
- Redis

---

# Staging

AWS

- ECS
- RDS
- ElastiCache

---

# Production

AWS

- ECS/EKS
- RDS PostgreSQL
- ElastiCache Redis
- S3
- CloudFront

---

# Regional Expansion Architecture

The system must support:

- Multiple countries
- Multiple currencies
- Multiple tax configurations
- Multiple delivery providers
- Multiple payment providers

No module may hardcode:

- Jamaica
- JMD
- WiPay
- Delivery zones

All must be configurable.

---

# Claude Code Architecture Directive

When building features:

1. Preserve modular boundaries.
2. Never bypass service layers.
3. Design APIs for future mobile use.
4. Support multi-vendor fulfillment.
5. Support payment splitting.
6. Support delivery consolidation.
7. Support regional expansion.
8. Prefer reusable modules over duplication.
9. Maintain clean architecture principles.
10. Optimize for scalability, security, and maintainability. Frontend:
Next.js

Backend:
NestJS

Database:
PostgreSQL

ORM:
Prisma

Mobile:
Expo React Native

Storage:
AWS S3

Cache:
Redis
