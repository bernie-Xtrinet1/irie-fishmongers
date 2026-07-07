# VENDOR TIER RULES
# Irie Fishmongers Marketplace

Version: 1.0

---

# PURPOSE

This document defines:

- Vendor permissions
- Vendor restrictions
- Vendor capabilities
- Compliance requirements
- Marketplace access rules

Claude must use this document when implementing:

- Registration
- Verification
- Marketplace Access
- Dashboard Features
- Product Listings
- Order Fulfillment
- Compliance Validation
- Feature Flags

This file is the authoritative source for all vendor tier permissions.

---

# TIER DEFINITIONS

TIER_1

COMMUNITY_FISHER

TIER_2

VERIFIED_VENDOR

TIER_3

COMMERCIAL_SUPPLIER

TIER_4

ENTERPRISE_SUPPLIER

---

# TIER 1
# COMMUNITY FISHER

Purpose:

Support small-scale fishers and fish ground vendors.

Required:

- Government ID
- Phone Verification
- Address
- Fishing Area Declaration
- Food Safety Agreement

Optional:

- Business Registration
- Insurance
- Tax Compliance

---

Permissions

Retail Sales

YES

Marketplace Listings

YES

Customer Orders

YES

Local Deliveries

YES

---

Wholesale Orders

NO

Hotel Orders

NO

Restaurant Contracts

NO

Government Contracts

NO

Export Sales

NO

---

Promotions

NO

Sponsored Listings

NO

Advanced Analytics

NO

API Access

NO

---

Daily Sales Limit

Configurable

Default:

JMD $50,000

---

Monthly Sales Limit

Configurable

Default:

JMD $500,000

---

Maximum Active Listings

50

---

Badge

🐟 Community Fisher

---

# TIER 2
# VERIFIED VENDOR

Required:

- Government ID
- Business Registration

Optional:

- Tax Compliance
- Insurance

---

Permissions

Retail Sales

YES

Marketplace Listings

YES

Promotions

YES

Featured Listings

YES

Analytics

Basic

---

Wholesale Orders

NO

Hotel Orders

NO

Government Contracts

NO

Export Sales

NO

---

Maximum Active Listings

500

---

Badge

✓ Verified Vendor

---

# TIER 3
# COMMERCIAL SUPPLIER

Required:

- Business Registration
- Tax Compliance
- Insurance
- Food Safety Documentation

---

Permissions

Retail Sales

YES

Wholesale

YES

Restaurants

YES

Hotels

YES

Bulk Orders

YES

Promotions

YES

Analytics

Advanced

---

Export Sales

NO

Government Contracts

YES

---

Maximum Listings

Unlimited

---

Badge

✓ Commercial Supplier

---

# TIER 4
# ENTERPRISE SUPPLIER

Required:

- Full Compliance Package
- Regulatory Certifications
- Insurance
- Audit Compliance

---

Permissions

Retail

YES

Wholesale

YES

Hotels

YES

Restaurants

YES

Government

YES

Exports

YES

API Access

YES

Multi-Zone Operations

YES

Advanced Reporting

YES

---

Badge

✓ Enterprise Supplier

---

# FEATURE FLAG RULES

Claude must implement feature access using feature flags.

Never hardcode vendor tier checks.

---

Required Functions

canSellRetail()

canSellWholesale()

canAcceptHotelOrders()

canAcceptRestaurantOrders()

canAcceptGovernmentOrders()

canExportProducts()

canAccessAnalytics()

canAccessPromotions()

canUseApiAccess()

canOperateMultipleZones()

---

Example

DO NOT:

if vendor.tier === "ENTERPRISE"

DO:

permissions = getVendorTierPermissions()

if permissions.canExportProducts

---

# REGISTRATION RULES

Registration forms must dynamically adapt.

Only request documents required by tier.

Never require:

Tax Compliance

Insurance

Business Registration

for Community Fisher vendors.

---

# DASHBOARD RULES

Dashboard widgets must adapt based on tier.

Community Fisher:

Orders

Sales

Ratings

Listings

---

Verified Vendor:

Orders

Sales

Listings

Promotions

Basic Analytics

---

Commercial Supplier:

Orders

Revenue

Inventory

Compliance

Cold Chain

Analytics

---

Enterprise Supplier:

Orders

Revenue

Compliance

Cold Chain

Multi-Zone Management

API Integrations

Executive Reporting

---

# SEARCH AND FILTER RULES

Marketplace must support:

Filter By Vendor Tier

Filter By Verification Status

Display Vendor Badge

Display Compliance Status

---

# UPGRADE RULES

Vendor may request tier upgrade.

Requirements:

All required documents submitted.

Admin approval completed.

Compliance score above threshold.

---

# DOWNGRADE RULES

Automatic review triggered by:

Expired Documents

Food Safety Violations

Repeated Delivery Failures

Fraud Reports

Compliance Breaches

---

# COMPLIANCE RULES

Compliance requirements are tier-aware.

Community Fisher vendors must not be evaluated against Enterprise Supplier requirements.

Compliance engine must load requirements from vendor tier configuration.

---

# DATABASE REQUIREMENTS

Create:

vendor_tiers

vendor_permissions

vendor_tier_limits

vendor_tier_features

vendor_upgrade_requests

vendor_downgrade_events

---

# AUDIT REQUIREMENTS

All changes must be logged.

Track:

Tier Changes

Permission Changes

Feature Changes

Upgrade Requests

Downgrade Actions

Admin Approvals

---

# CLAUDE EXECUTION RULE

Before implementing any vendor feature:

1. Load vendor tier.
2. Load vendor permissions.
3. Load vendor limits.
4. Load vendor compliance requirements.
5. Apply feature flags.
6. Apply restrictions.
7. Log all decisions.

Never hardcode tier logic.

All vendor capabilities must be configuration-driven.