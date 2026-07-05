# IrieFishmongers Platform Business Rules

Version: 1.0

---

# Platform Purpose

IrieFishmongers connects customers with independent fish vendors across Jamaica through a digital marketplace that facilitates ordering, payment, and delivery of fresh seafood products.

The platform serves:

- Customers
- Vendors
- Drivers
- Administrators

---

# User Roles

## Customer

Customers may:

- Create accounts
- Browse products
- Place orders
- Make payments
- Track deliveries
- Submit reviews

Customers may not:

- Access vendor information beyond public profiles
- Modify completed orders
- Access administrative functions

---

## Vendor

Vendors may:

- Register for vendor accounts
- Manage their own products
- Manage inventory
- Accept or reject orders
- View their own sales reports

Vendors may not:

- Access another vendor's products
- Access another vendor's customer data
- Modify completed payments
- View platform-wide analytics

---

## Driver

Drivers may:

- Accept assigned deliveries
- Update delivery status
- View assigned delivery information
- Use GPS tracking features

Drivers may not:

- Access vendor management functions
- Access payment information
- Access customer purchase history

---

## Administrator

Administrators may:

- Manage users
- Approve vendors
- Suspend accounts
- View platform analytics
- Resolve disputes

Administrators may not:

- Alter payment records
- Delete completed order history

---

# Vendor Registration Rules

All vendors must:

- Complete registration
- Provide valid identification
- Provide business information
- Accept platform terms and conditions

Vendor accounts remain inactive until approved by an administrator.

Only approved vendors may:

- Create listings
- Receive orders
- Receive payments

---

# Product Rules

Products must include:

- Name
- Description
- Price
- Unit of measure
- Quantity available
- Product image

Products may be sold:

- Per pound
- Per kilogram
- Per package
- Per item

Inventory cannot be negative.

Unavailable products must not appear in search results.

Inactive products cannot be purchased.

---

# Inventory Rules

Inventory must update automatically when:

- Orders are placed
- Orders are cancelled
- Refunds are processed

If stock reaches zero:

- Product status becomes Out Of Stock

Customers cannot purchase more inventory than available.

---

# Customer Order Rules

Customers may:

- Add products to cart
- Place orders
- Cancel eligible orders

Orders may only be cancelled before vendor acceptance.

Once accepted by a vendor:

- Customer cancellation is restricted

Completed orders cannot be edited.

---

# Order Status Workflow

Orders must follow this sequence:

Pending

?

Accepted

?

Preparing

?

Ready For Pickup

?

Assigned To Driver

?

In Transit

?

Delivered

Alternative status:

Pending

?

Cancelled

Order status history must be retained permanently.

---

# Payment Rules

Supported payment methods:

- WiPay
- Stripe
- Cash On Delivery

Payment must be verified before order processing begins.

Online payments must be completed before:

- Vendor acceptance
- Delivery assignment

Failed payments do not create active orders.

---

# Refund Rules

Refunds may be issued for:

- Cancelled orders
- Failed deliveries
- Approved disputes

Refund requests require:

- Reason
- Order reference
- Administrator review when applicable

Refunds must be logged.

---

# Delivery Rules

Delivery may only be assigned after:

- Order acceptance
- Payment verification

Drivers may only access assigned deliveries.

Customers may track deliveries in real time.

Delivery status options:

- Assigned
- Picked Up
- In Transit
- Delivered

Proof of delivery is required.

Accepted proof:

- Signature
- Photo confirmation

---

# Review Rules

Customers may review:

- Products
- Vendors

Reviews are allowed only after:

- Successful delivery

Reviews cannot be edited after a defined period.

Fake reviews are prohibited.

Administrators may remove inappropriate reviews.

---

# Search Rules

Search results prioritize:

1. Product availability
2. Vendor rating
3. Distance to customer
4. Freshness indicators

Out-of-stock products should not rank highly.

---

# Notification Rules

Notifications must be sent for:

- Registration confirmation
- Vendor approval
- Order placement
- Order acceptance
- Payment confirmation
- Delivery updates
- Refund status changes

Channels:

- Email
- SMS (future)
- Push notifications

---

# Data Privacy Rules

Personal customer data must remain private.

Vendors may only access customer information required to fulfill an order.

Drivers may only access information required for delivery.

Personal information must never be shared with unauthorized parties.

---

# Reporting Rules

Vendors may access:

- Sales reports
- Product performance
- Order history

Administrators may access:

- Platform revenue
- Vendor performance
- Customer growth
- Delivery metrics

---

# Dispute Resolution Rules

Customers may submit disputes.

Disputes may involve:

- Product quality
- Delivery issues
- Incorrect orders

Administrators are responsible for final dispute decisions.

All disputes must be logged.

---

# Jamaica Market Rules

Primary operating region:

Jamaica

Primary currency:

JMD

Future expansion target:

CARICOM Member States

System design must support:

- Multi-country operations
- Multi-currency support
- Regional tax configuration

without requiring major redesign.

---

# Platform Principle

Every platform feature must support:

- Fresh seafood commerce
- Vendor empowerment
- Customer convenience
- Delivery efficiency
- Secure digital transactions
- Future CARICOM expansion

No feature should be implemented that conflicts with these principles.
