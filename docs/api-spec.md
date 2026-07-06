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

POST /orders

POST /payments

GET /deliveries

---

All routes are mounted under the API prefix, e.g. /api/v1/auth/register.
Full request/response schemas and try-it-out docs are served by Swagger at
/api/v1/docs once the backend is running.
