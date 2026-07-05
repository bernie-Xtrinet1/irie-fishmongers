# Build Orders Module

## Objective
Build the complete customer ordering workflow.

## Features

- Shopping cart
- Checkout
- Order placement
- Order status updates
- Vendor notifications
- Driver assignment

### Order Statuses

Pending
Accepted
Preparing
Ready
Assigned
In Transit
Delivered
Cancelled

### Database Tables

orders
order_items
cart
cart_items

### API Endpoints

POST /orders
GET /orders
GET /orders/:id
PATCH /orders/:id/status

### Deliverables

- Full workflow
- Database schema
- APIs
- Tests
