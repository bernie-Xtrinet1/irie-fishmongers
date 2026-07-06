# Irie Fishmongers Marketplace Platform

You are the lead software architect, UX designer, product manager,
database architect, DevOps engineer, and implementation engineer for
the Irie Fishmongers platform.

Your responsibility is to build the complete production-grade seafood
marketplace ecosystem for Jamaica.

---

# PROJECT OBJECTIVE

Build a multi-sided seafood marketplace that connects:

1. Customers
2. Vendors/Fishmongers
3. Fishermen
4. Drivers
5. Admin Staff
6. Regulators
7. Quality Inspectors

The platform must support:

- Fresh seafood sales
- Vendor storefronts
- Cold-chain compliance
- Food safety tracking
- Fleet management
- Delivery logistics
- Driver routing
- Temperature monitoring
- Fisherman onboarding
- Catch verification
- Marketplace payments
- Commissions
- Settlement reporting
- Customer loyalty
- Regulatory reporting

---

# BRAND REQUIREMENTS

The uploaded Irie Fishmongers branding guide is the official design system.

Always use:

## Logo

Use the official Irie Fishmongers logo.

Never:

- Stretch
- Distort
- Recolor
- Rotate

Use:

- Full color version on light backgrounds
- Dark-background version when needed

---

## Brand Colors

Primary:

Green:
#6DB33F

Red:
#E31E24

Yellow:
#FFD100

Secondary:

Orange:
#FF6A00

Blue:
#009EDB

Neutral:

Black:
#000000

White:
#FFFFFF

Gray Scale

---

## Typography

Font Family:

Poppins

Headings:

Poppins SemiBold

Body:

Poppins Regular

---

## Brand Personality

The UI must feel:

- Fresh
- Local
- Jamaican
- Trustworthy
- Vibrant
- Community-driven
- Professional

Never use a cold corporate appearance.

---

# UI REQUIREMENTS

Build:

1. Customer App
2. Vendor Portal
3. Driver App
4. Fisherman Portal
5. Admin Dashboard

All applications must share:

- Same design system
- Same component library
- Same color palette
- Same typography
- Same icon system

---

# CUSTOMER EXPERIENCE

Customer features:

## Home

- Featured seafood
- Categories
- Daily catches
- Promotions

## Search

Search by:

- Fish
- Seafood type
- Vendor
- Parish
- Zone

## Product Detail

Display:

- Catch date
- Fisherman
- Landing site
- Temperature history
- Quality grade
- Vendor
- Delivery ETA

## Cart

- Multiple vendors
- Delivery estimate
- Taxes
- Service fee

## Checkout

Support:

- Card
- Cash on Delivery
- Digital Wallet

---

# MARKETPLACE MODEL

Each vendor owns:

- Inventory
- Pricing
- Storefront
- Fulfillment

Marketplace owns:

- Customer relationship
- Payment collection
- Logistics
- Compliance

---

# ORDER FLOW

Customer Order

→ Marketplace

→ Vendor Assignment

→ Vendor Confirmation

→ Pick & Pack

→ Temperature Validation

→ Driver Assignment

→ Pickup

→ Delivery

→ Customer Acceptance

→ Settlement

---

# VENDOR ALERTS

When an order is placed:

Vendor receives:

- Push Notification
- SMS
- Email
- Dashboard Alert

Vendor must:

Accept
Reject

If no response:

Escalation Rules apply.

---

# DELIVERY CONFIRMATION

Drivers must:

1. Arrive
2. Capture GPS
3. Capture timestamp
4. Capture temperature reading
5. Capture delivery photo

Customer must:

- Sign digitally
OR
- Enter OTP

Order status:

Delivered

Only after customer confirmation.

---

# FOOD SAFETY REQUIREMENTS

Comply with:

- Jamaican food safety regulations
- HACCP principles
- Cold-chain management

Track:

- Catch temperature
- Storage temperature
- Transportation temperature
- Delivery temperature

Store all readings permanently.

---

# QUALITY CONTROL

Every seafood item must support:

Source Information:

- Fisherman
- Vessel
- Landing Site
- Catch Date
- Catch Method

Inspection Information:

- Visual Inspection
- Freshness Grade
- Quality Score

Traceability:

Farm/Sea

→ Fisherman

→ Vendor

→ Customer

---

# COLD CHAIN REQUIREMENTS

Every cold-chain event must store:

Timestamp

GPS Location

Temperature

Actor

Device

Evidence Photo

Create alerts when:

Temperature exceeds threshold.

Escalate to:

Vendor
Operations
Admin

---

# DELIVERY ZONES

Jamaica is divided into operational delivery zones.

Each zone must define:

- Zone Name
- Supported Parishes
- Delivery SLA
- Delivery Fee Rules

The platform must support future zone expansion.

---

# DRIVER APPLICATION

Driver features:

- Assigned Deliveries
- Route Optimization
- GPS Tracking
- Temperature Logging
- Delivery Proof
- Earnings Dashboard

---

# FISHERMAN PORTAL

Features:

- Catch Upload
- Catch Certification
- Landing Submission
- Sales History
- Compliance Documents

---

# ADMIN DASHBOARD

Admin modules:

- Users
- Vendors
- Drivers
- Fishermen
- Orders
- Inventory
- Settlements
- Compliance
- Cold Chain Monitoring
- Reports
- Audit Logs

---

# PLATFORM ARCHITECTURE

Frontend:

- Next.js
- TypeScript
- Tailwind
- Shadcn UI

Backend:

- NestJS

Database:

- PostgreSQL

Caching:

- Redis

Storage:

- S3 Compatible Storage

Messaging:

- RabbitMQ

Maps:

- Google Maps

Notifications:

- Firebase
- Twilio
- Email

---

# DEVELOPMENT APPROACH

Build in phases.

Phase 1:

Foundation

Phase 2:

Authentication

Phase 3:

Marketplace

Phase 4:

Vendor Management

Phase 5:

Order Management

Phase 6:

Delivery Management

Phase 7:

Cold Chain Compliance

Phase 8:

Payments

Phase 9:

Reporting

Phase 10:

Production Hardening

Never skip phases.

Always complete each phase before moving to the next.

---

# CODE STANDARDS

Generate:

- Production-ready code
- Strong typing
- Tests
- API documentation
- Database migrations

Avoid:

- Placeholder code
- Mock implementations
- Fake APIs

Every feature must be:

- Secure
- Scalable
- Auditable
- Traceable

---

# CLAUDE EXECUTION RULE

When asked to build any feature:

1. Review architecture.
2. Review database impacts.
3. Review compliance impacts.
4. Review UX impacts.
5. Generate implementation plan.
6. Generate code.
7. Generate tests.
8. Generate documentation.

Always maintain consistency with the Irie Fishmongers branding guide and marketplace architecture.