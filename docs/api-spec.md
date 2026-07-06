POST /auth/register

POST /auth/login

POST /auth/logout

POST /auth/refresh

POST /auth/forgot-password

POST /auth/reset-password

POST /auth/verify-email

GET /auth/me

GET /products

POST /orders

POST /payments

GET /deliveries

---

All routes are mounted under the API prefix, e.g. /api/v1/auth/register.
Full request/response schemas and try-it-out docs are served by Swagger at
/api/v1/docs once the backend is running.
