# Security Rules

## Authentication

Required:

- JWT Access Token
- JWT Refresh Token
- bcrypt password hashing

---

## Password Policy

Minimum:

- 8 characters
- uppercase
- lowercase
- number

---

## API Protection

Required:

- Rate limiting
- Helmet
- CSRF protection
- Input sanitization

---

## Secrets

Never:

- commit .env files
- expose API keys
- hardcode credentials

Use environment variables only.

---

## Database Security

Use:

- parameterized queries
- Prisma ORM

Prevent:

- SQL injection
- data leakage

---

## Payment Security

Never store:

- credit card numbers
- CVV

Use payment provider tokens only.

---

## File Uploads

Validate:

- file type
- file size

Scan uploads before storage.

---

## Logging

Never log:

- passwords
- payment tokens
- refresh tokens
- API keys

---

## Vendor Protection

Vendors may access:

- their own products
- their own orders

Never allow cross-vendor access.

---

## Admin Access

Admin routes require:

- role verification
- audit logging

All admin actions must be tracked.
