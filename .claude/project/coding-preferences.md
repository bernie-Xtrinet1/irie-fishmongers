# Coding Preferences

## Project

Name: IrieFishmongers

Architecture:
Monorepo

Backend:
NestJS
TypeScript
Prisma
PostgreSQL

Frontend:
Next.js
TypeScript
TailwindCSS

Mobile:
React Native (Expo)

## General Rules

- TypeScript only
- Strict typing enabled
- No use of "any"
- No duplicate code
- Follow SOLID principles
- Follow Clean Architecture
- Follow Domain Driven Design

## File Organization

One responsibility per file.

Maximum file size:
300 lines

Maximum function size:
50 lines

Maximum component size:
200 lines

## Naming Conventions

Classes:
PascalCase

Variables:
camelCase

Constants:
UPPER_SNAKE_CASE

Files:
kebab-case

Folders:
kebab-case

## API Standards

REST API

Version all routes:

/api/v1/

Example:

/api/v1/products

## Validation

Use Zod or class-validator.

Validate:

- Request body
- Query params
- Route params

## Security

Use:

- Helmet
- Rate limiting
- CSRF protection
- JWT
- bcrypt

Never:

- Store plaintext passwords
- Expose secrets
- Commit .env files

## Database Standards

Use Prisma ORM.

Every table must contain:

- id
- createdAt
- updatedAt

Use soft deletes where appropriate.

## Testing

Minimum coverage:

80%

Required:

- Unit tests
- Integration tests
- E2E tests

## Documentation

Every module must include:

- README
- API examples
- Test examples

## Git Standards

Branch Source:
develop

Merge Target:
develop

Commit Format:

feat:
fix:
refactor:
test:
docs:

## Claude Code Behavior

Before writing code:

1. Analyze requirements.
2. Generate implementation plan.
3. Verify dependencies.
4. Create tests.
5. Generate code.

After writing code:

1. Run validation.
2. Run tests.
3. Check linting.
4. Verify security.
5. Update documentation.

Never generate incomplete modules.
Never skip tests.
Never bypass validation.
