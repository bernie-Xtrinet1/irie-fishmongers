# IRIEFISHMONGERS PLATFORM
# GLOBAL ENGINEERING CONSTITUTION

Version: 1.0
Project: IrieFishmongers Marketplace
Authority: Highest

This document governs ALL Claude Code agents operating within this repository.

No agent may violate these rules.

Before implementation, read:
/rules/S.md
--------------------------------------------------
MISSION
--------------------------------------------------

Build a production-grade seafood marketplace platform for Jamaica and international customers.

Platform Components:

- Customer Website
- Customer Mobile App
- Vendor Mobile App
- Driver Mobile App
- Admin Dashboard
- Backend APIs
- Authentication Services
- Delivery Services
- Payment Services
- Analytics Services
- Notification Services

The platform must be:

- Secure
- Scalable
- Modular
- Maintainable
- Testable
- Deployable




--------------------------------------------------
PRIMARY STACK
--------------------------------------------------

Frontend:

- Next.js 15
- React 19
- TypeScript
- TailwindCSS
- ShadCN

Mobile:

- React Native
- Expo
- TypeScript

Backend:

- NestJS
- Prisma
- PostgreSQL
- Redis

Infrastructure:

- Docker
- AWS
- GitHub Actions

Testing:

- Vitest
- Jest
- Playwright








--------------------------------------------------
MANDATORY PRINCIPLES
--------------------------------------------------

1. NEVER GENERATE MOCK IMPLEMENTATIONS
2. NEVER LEAVE TODO COMMENTS
3. NEVER CREATE PLACEHOLDER SERVICES
4. NEVER CREATE UNUSED FILES
5. NEVER GENERATE DEAD CODE
6. NEVER DUPLICATE BUSINESS LOGIC
7. ALWAYS CREATE PRODUCTION CODE

--------------------------------------------------
SECURITY RULES
--------------------------------------------------

Always:

- Hash passwords
- Validate inputs
- Sanitize inputs
- Use DTO validation
- Protect APIs
- Enforce authorization

Never:

- Store plaintext passwords
- Expose secrets
- Hardcode credentials
- Disable validation













--------------------------------------------------
DATABASE RULES
--------------------------------------------------

All schema changes must:

- Include migration
- Include Prisma model
- Include validation

Relationships must be explicit.

No nullable fields unless justified.

--------------------------------------------------
API RULES
--------------------------------------------------

Every endpoint must include:

- DTOs
- Validation
- Error handling
- Swagger documentation
- Tests

All endpoints must return:

{
  success: boolean,
  data: object | null,
  error: string | null
}











--------------------------------------------------
UI RULES
--------------------------------------------------

Every screen must:

- Be responsive
- Be accessible
- Be typed
- Use shared components

Never:

- Inline styles
- Duplicate components

--------------------------------------------------
MOBILE RULES
--------------------------------------------------

Apps:

- Customer App
- Vendor App
- Driver App

Shared packages required.

All navigation must use Expo Router.

All forms require validation.













--------------------------------------------------
TESTING RULES
--------------------------------------------------

Minimum Coverage:

90%

Required:

- Unit Tests
- Integration Tests
- E2E Tests

No module may be marked complete without tests.

--------------------------------------------------
ARCHITECTURE RULES
--------------------------------------------------

Use:

Feature-first architecture

Example:

src/modules/orders

src/modules/orders/controllers
src/modules/orders/services
src/modules/orders/entities
src/modules/orders/dto
src/modules/orders/tests

Never create God services.

Maximum service size:

500 lines

Maximum file size:

400 lines

--------------------------------------------------
CODE QUALITY
--------------------------------------------------

Required:

- ESLint clean
- TypeScript strict mode
- No warnings
- No any types

Forbidden:

any
@ts-ignore
eslint-disable

unless approved.

--------------------------------------------------
GIT RULES
--------------------------------------------------

Every change:

1. Build passes
2. Tests pass
3. Lint passes

Commit format:

feat:
fix:
refactor:
test:
docs:








--------------------------------------------------
DOMAIN MODEL
--------------------------------------------------

Core Entities:

User
Customer
Vendor
Driver
Product
Inventory
Order
Payment
Delivery
Review
Notification

These are protected domain objects.

Changes require impact review.

--------------------------------------------------
PAYMENT RULES
--------------------------------------------------

Supported:

Stripe
PayPal
WiPay
Lynk

Payment logic must be isolated.

Never mix payment logic into controllers.








--------------------------------------------------
DELIVERY RULES
--------------------------------------------------

Delivery calculations belong only in:

Delivery Engine

No duplication allowed.

--------------------------------------------------
AI RULES
--------------------------------------------------

AI features must be isolated.

Never mix AI logic into transactional workflows.

--------------------------------------------------
COMPLETION RULE
--------------------------------------------------

A task is COMPLETE only when:

? Code exists
? Tests pass
? Build passes
? Documentation updated
? Types validated
? No lint errors

Otherwise:

TASK IS NOT COMPLETE
