# Backend Development Rules

## Technology Stack

Required:

- NestJS
- TypeScript
- Prisma ORM
- PostgreSQL
- Redis

Do not introduce alternative frameworks unless explicitly approved.

---

## Architecture

Follow:

- Clean Architecture
- Domain Driven Design
- SOLID Principles

Structure:

src/
??? modules/
??? common/
??? config/
??? database/
??? shared/

---

## Module Standards

Each module must contain:

module/
??? controllers/
??? services/
??? dto/
??? entities/
??? repositories/
??? validators/
??? tests/

---

## API Standards

All routes must use:

/api/v1/

Example:

/api/v1/products

---

## Validation

Every endpoint must validate:

- body
- params
- query strings

Use:

class-validator

Reject invalid requests.

---

## Error Handling

Never return raw exceptions.

Use standard format:

{
  "success": false,
  "message": "Validation failed",
  "errors": []
}

---

## Logging

Use structured logging.

Log:

- errors
- warnings
- payment events
- authentication events

Never log:

- passwords
- secrets
- tokens

---

## Database

Use Prisma only.

All entities must include:

id
createdAt
updatedAt

Soft delete where applicable.

---

## Performance

Avoid:

- N+1 queries
- duplicated queries
- unnecessary joins

Optimize indexes.

---

## Documentation

Every endpoint must have:

- request example
- response example
- error example
