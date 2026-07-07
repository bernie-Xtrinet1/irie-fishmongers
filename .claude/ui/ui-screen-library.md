# UI SCREEN LIBRARY
# Irie Fishmongers Marketplace

Version: 1.0

---

# PURPOSE

This document defines every application screen.

Claude must follow these specifications when generating:

- UI Components
- Pages
- Navigation
- Mobile Screens
- Responsive Layouts

All screens must use the UI Design System.

---

# BRANDING

Use:

Irie Fishmongers Logo

Primary Color:
Ocean Blue

Secondary Color:
Seafoam Green

Accent:
Fresh Coral

Background:
White

Typography:
Modern Sans Serif

---

# USER TYPES

1. Customer
2. Vendor
3. Driver
4. Administrator
5. Quality Inspector

Display only features relevant to user role.

---

# AUTHENTICATION SCREENS

## Login

Fields:

- Email
- Password

Actions:

- Login
- Forgot Password
- Create Account

---

## Registration

Customer Registration

Fields:

- Name
- Email
- Phone
- Address
- Password

---

Vendor Registration

Fields:

- Business Name
- Contact Person
- TRN
- Email
- Phone
- Address

---

Driver Registration

Fields:

- Name
- Driver License
- Phone
- Email

---

# CUSTOMER SCREENS

## Customer Dashboard

Display:

- Featured Seafood
- Categories
- Recommended Products
- Current Orders
- Recent Purchases

Widgets:

- Search
- Promotions
- Vendor Spotlight

---

## Marketplace

Display:

- Product Grid

Filters:

- Fish Type
- Vendor
- Fresh/Frozen
- Price
- Availability
- Parish

Sort:

- Price
- Popularity
- Newest

---

## Product Details

Display:

- Product Image
- Product Name
- Vendor
- Price
- Weight
- Availability
- Catch Date
- Freshness Score

Buttons:

- Add To Cart
- Buy Now

---

## Shopping Cart

Display:

- Products
- Quantity
- Price
- Delivery Fee

Actions:

- Update Quantity
- Remove Item
- Checkout

---

## Checkout

Sections:

Delivery Address

Payment Method

Order Summary

Special Instructions

Actions:

Place Order

---

## Order Tracking

Display:

Order Status

Vendor Confirmation

Driver Assignment

Driver Location

Estimated Arrival

Delivery Confirmation

---

## Customer Profile

Display:

Personal Information

Saved Addresses

Payment Methods

Order History

Favorites

---

# VENDOR SCREENS

## Vendor Dashboard

Display:

Today's Orders

Revenue

Inventory Status

Compliance Alerts

Temperature Alerts

---

## Order Management

Display:

New Orders

Accepted Orders

Packing Orders

Dispatched Orders

Completed Orders

Rejected Orders

Actions:

Accept Order

Reject Order

Mark Packed

Mark Ready

---

## Inventory Management

Display:

Inventory List

Lot Tracking

Expiration Dates

Stock Levels

Temperature Records

Actions:

Add Product

Update Inventory

Quarantine Product

---

## Product Management

Display:

Product Catalog

Actions:

Add Product

Edit Product

Deactivate Product

---

## Compliance Dashboard

Display:

Food Safety Score

Vendor Rating

Temperature Compliance

Inspection Results

Audit History

---

# DRIVER SCREENS

## Driver Dashboard

Display:

Assigned Deliveries

Delivery Queue

Today's Earnings

Compliance Tasks

---

## Delivery Details

Display:

Customer

Address

Products

Temperature Requirements

Special Instructions

Actions:

Start Delivery

Navigate

Capture Temperature

Complete Delivery

---

## Proof Of Delivery

Capture:

Customer Signature

Customer Photo

Delivered Product Photo

GPS Location

Timestamp

Temperature Reading

---

# ADMIN SCREENS

## Admin Dashboard

Display:

Revenue

Orders

Vendors

Drivers

Compliance Alerts

System Health

---

## Vendor Management

Display:

Vendor List

Status

Compliance Score

Actions:

Approve

Suspend

Deactivate

---

## Driver Management

Display:

Driver List

Status

Performance

Compliance

Actions:

Approve

Suspend

Deactivate

---

## Delivery Zone Management

Display:

Zones

Parishes

Coverage Areas

Drivers

Vehicles

Actions:

Create Zone

Assign Driver

Assign Vehicle

---

## Cold Chain Monitoring

Display:

Live Temperature Events

Violations

Incidents

Alerts

Quarantine Inventory

---

## Recall Management

Display:

Recall Cases

Affected Products

Affected Vendors

Affected Orders

Customer Notifications

Actions:

Initiate Recall

Close Recall

---

# INSPECTOR SCREENS

## Inspection Dashboard

Display:

Pending Inspections

Completed Inspections

Violations

Risk Scores

---

## Inspection Report

Capture:

Photos

Temperature Checks

Facility Assessment

Product Assessment

Corrective Actions

---

# MOBILE REQUIREMENTS

All screens must support:

Mobile Phone

Tablet

Desktop

Responsive Layout Required

---

# NOTIFICATIONS

Support:

Email

SMS

Push Notifications

In-App Notifications

---

# ACCESSIBILITY

Must Support:

Keyboard Navigation

Screen Readers

High Contrast Mode

Large Text

WCAG Compliance

---

# UI COMPONENTS

Reusable Components:

Navbar

Sidebar

Search Bar

Product Card

Vendor Card

Order Card

Delivery Card

Compliance Alert

Temperature Alert

Notification Panel

Data Tables

Pagination

Charts

Maps

Forms

Modals

---

# CLAUDE EXECUTION RULE

Before creating a new screen:

1. Check this library.
2. Reuse existing components.
3. Follow UI Design System.
4. Maintain role-based access.
5. Ensure responsive design.
6. Ensure food safety workflows remain visible.
7. Ensure cold-chain status is visible where applicable.

# COMPONENT

Vendor Tier Badge

Types

- Community Fisher
- Verified Vendor
- Commercial Supplier
- Enterprise Supplier

Display:

Badge
Color
Tooltip
Compliance Status

---

# COMPONENT

Vendor Selection Card

Fields

- Vendor Name
- Tier Badge
- Rating
- Delivery ETA
- Compliance Status
- Price

Actions

- Select Vendor
- View Profile