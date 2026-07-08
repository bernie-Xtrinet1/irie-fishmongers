# STOCK RESERVATION ENGINE
# Irie Fishmongers

Version: 1.0

---

# IMPLEMENTATION NOTE (Inventory Management phase, shipped)

The reservation lifecycle, dual-quantity model (Available = Total -
Reserved), and 15-minute default duration described below are all real and
implemented. One divergence: reservations are **Redis-only** - there is no
`StockReservation` Postgres table. Each product gets one Redis hash
(`inv:reserved:{productId}`, field = cartId, value = `{quantity, expiresAt}`)
via `InventoryReservationsService`
(`backend/src/modules/inventory/services/inventory-reservations.service.ts`).
Expiry is enforced by comparing `expiresAt` on every read (lazy expiry), not
a scheduled sweep. Reservation happens on cart add/update
(`POST /cart/items`, `PATCH /cart/items/:itemId`), matching this doc's
"Reservation occurs when: Customer adds product to cart" rule. Full
rationale in `docs/database-design.md`'s "Inventory Management Tables"
section.

---

# PURPOSE

Prevent overselling by reserving inventory when customers
place items into their shopping cart.

Stock must NOT remain available after reservation.

Reservations guarantee inventory for a limited period.

---

# RESERVATION LIFECYCLE

AVAILABLE

↓

RESERVED

↓

CHECKOUT

↓

SOLD

OR

↓

EXPIRED

↓

AVAILABLE

---

# RESERVATION RULES

Reservation occurs when:

- Customer adds product to cart.

Reservation quantity:

Requested Quantity

Reservation must immediately reduce
Available Inventory.

---

# INVENTORY CALCULATION

Available Stock

=

Total Stock

-

Reserved Stock

---

# EXAMPLE

Vendor Inventory

Total

100 lb

Reserved

15 lb

Sold

20 lb

Available

65 lb

---

# MULTIPLE CUSTOMERS

Customer A

Reserve 20 lb

↓

Available decreases immediately

Customer B

Can only purchase remaining inventory.

---

# RESERVATION LIMIT

Reservation duration

15 Minutes

Configurable.

---

# RESERVATION STATUS

ACTIVE

CHECKED_OUT

EXPIRED

CANCELLED

---

# RESERVATION EVENTS

Created

Extended

Released

Expired

Converted To Sale

Cancelled

---

# DATABASE TABLE

StockReservation

Fields

id

productId

vendorId

customerId

cartId

quantity

status

expiresAt

createdAt

updatedAt

---

# CLAUDE EXECUTION RULE

Never allow checkout against Total Stock.

Always validate against Available Stock.

Reservation logic must be transactional.

Never oversell inventory.