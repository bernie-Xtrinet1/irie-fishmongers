POST /auth/register

POST /auth/login

POST /auth/logout

POST /auth/refresh

POST /auth/forgot-password

POST /auth/reset-password

POST /auth/verify-email

GET /auth/me

POST /vendors

GET /vendors/me

PATCH /vendors/me (owning vendor only)

GET /vendors (admin only)

GET /vendors/:id/public

PATCH /vendors/:id/status (admin only)

GET /categories

POST /categories (admin only)

GET /products

GET /products/:id

GET /products/mine (vendor only)

POST /products (approved vendor only)

PATCH /products/:id (owning vendor only)

PATCH /products/:id/stock (owning vendor only)

PATCH /products/:id/deactivate (owning vendor only)

PATCH /products/:id/reactivate (owning vendor only)

GET /cart (customer only)

POST /cart/items (customer only)

PATCH /cart/items/:itemId (customer only)

DELETE /cart/items/:itemId (customer only)

POST /orders/checkout (customer only)

GET /orders (customer only)

GET /orders/:id (customer only)

POST /orders/:id/cancel (owning customer only)

POST /orders/:id/vendor-orders/:vendorOrderId/cancel (owning customer only)

GET /vendor-orders (vendor only)

PATCH /vendor-orders/:id/accept (owning vendor only)

PATCH /vendor-orders/:id/reject (owning vendor only)

PATCH /vendor-orders/:id/preparing (owning vendor only)

PATCH /vendor-orders/:id/ready (owning vendor only)

POST /payments/webhooks/wipay (public - HMAC-signed WiPay callback)

PATCH /payments/:id/mark-paid (admin only - confirm cash-on-delivery collection)

POST /payments/:id/refund (admin only - exceptional-circumstances refund)

POST /drivers (driver only - self-register a driver profile)

GET /drivers/me (driver only)

POST /drivers/me/location (approved driver only - report GPS location)

GET /drivers (admin only)

PATCH /drivers/:id/status (admin only)

GET /delivery/available (approved driver only)

POST /delivery/assign (approved driver only - claim a ready-for-pickup vendor order)

GET /delivery/mine (driver only)

PATCH /delivery/:id/status (owning driver only - PICKED_UP / DELIVERED / FAILED)

GET /delivery/track/:vendorOrderId (owning customer only)

POST /driver-settlements/generate (admin only - generate a weekly settlement batch)

GET /driver-settlements/mine (driver only)

GET /driver-settlements (admin only)

PATCH /driver-settlements/:id/status (admin only - approve / pay / fail / dispute)

GET /driver-settlements/rate-config (admin only)

POST /driver-settlements/rate-config (admin only - publish new compensation rates)

POST /vendor-settlements/generate (admin only - settle all currently-eligible vendor orders)

GET /vendor-settlements/mine (vendor only)

GET /vendor-settlements (admin only)

PATCH /vendor-settlements/:id/status (admin only - approve / pay / fail)

POST /vendor-settlements/:id/adjustments (admin only - manual correction, e.g. after a refund)

GET /vendor-settlements/commission-rate (admin only)

POST /vendor-settlements/commission-rate (admin only - publish new commission rate)

---

All routes are mounted under the API prefix, e.g. /api/v1/auth/register.
Full request/response schemas and try-it-out docs are served by Swagger at
/api/v1/docs once the backend is running.
