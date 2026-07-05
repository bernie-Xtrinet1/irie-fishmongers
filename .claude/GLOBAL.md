# PERSONAL ENGINEERING PREFERENCES

Version: 1.0

These instructions apply to all software projects unless overridden by project-specific rules.

--------------------------------------------------
ENGINEERING PHILOSOPHY
--------------------------------------------------

Optimize for:

1. Maintainability
2. Readability
3. Scalability
4. Security
5. Developer Experience

Always prefer long-term maintainability over short-term speed.

--------------------------------------------------
PLANNING FIRST
--------------------------------------------------

Before writing code:

1. Explain requirements
2. Identify dependencies
3. Identify risks
4. Propose architecture
5. Define acceptance criteria

Do not immediately generate code.











--------------------------------------------------
TECHNOLOGY PREFERENCES
--------------------------------------------------

Frontend

Preferred order:

- Next.js
- React
- TypeScript
- TailwindCSS
- ShadCN UI

Mobile

Preferred order:

- React Native
- Expo
- TypeScript

Backend

Preferred order:

- NestJS
- PostgreSQL
- Prisma
- Redis

Infrastructure

Preferred order:

- Docker
- GitHub Actions
- AWS





--------------------------------------------------
TYPESCRIPT RULES
--------------------------------------------------

Always:

- Enable strict mode
- Use explicit typing
- Prefer interfaces for contracts
- Use enums when appropriate

Avoid:

- any
- unknown without validation
- ts-ignore

Use type-safe patterns whenever possible.

--------------------------------------------------
CODE QUALITY
--------------------------------------------------

Generate code that is:

- Clean
- Modular
- Reusable
- Production ready

Never generate:

- Placeholder code
- TODO comments
- Dead code
- Unused imports
- Unused variables







--------------------------------------------------
ARCHITECTURE PREFERENCES
--------------------------------------------------

Prefer:

Feature-first architecture

Example:

src/modules/orders

src/modules/orders/controllers
src/modules/orders/services
src/modules/orders/dto
src/modules/orders/entities
src/modules/orders/tests

Avoid:

- Monolithic services
- Large utility folders
- Circular dependencies

--------------------------------------------------
FILE ORGANIZATION
--------------------------------------------------

Keep files focused.

Preferred limits:

- Functions under 50 lines
- Components under 250 lines
- Services under 500 lines

Split files before they become difficult to maintain.







--------------------------------------------------
API DESIGN
--------------------------------------------------

Use:

- REST by default
- GraphQL only when justified

Every endpoint must include:

- Validation
- Error handling
- Documentation
- Tests

Use consistent response structures.

--------------------------------------------------
DATABASE RULES
--------------------------------------------------

Prefer:

- PostgreSQL
- Prisma ORM

Always:

- Define indexes
- Use migrations
- Define relationships explicitly

Avoid:

- Hidden business logic in database triggers
- Uncontrolled nullable fields







--------------------------------------------------
SECURITY STANDARDS
--------------------------------------------------

Always:

- Validate inputs
- Sanitize inputs
- Hash passwords
- Protect secrets
- Apply least privilege

Never:

- Hardcode credentials
- Store plaintext passwords
- Expose sensitive data

Security is not optional.

--------------------------------------------------
UI DEVELOPMENT
--------------------------------------------------

Prefer:

- Responsive design
- Accessibility
- Shared components
- Design system consistency

Avoid:

- Inline styles
- Duplicate UI components









--------------------------------------------------
MOBILE DEVELOPMENT
--------------------------------------------------

Prefer:

- Expo Router
- React Query
- Shared API layer

Every screen should:

- Handle loading state
- Handle error state
- Handle empty state

--------------------------------------------------
TESTING PREFERENCES
--------------------------------------------------

Minimum requirements:

- Unit tests
- Integration tests

For critical flows:

- E2E tests

Coverage target:

80%+

Do not mark work complete without tests.










--------------------------------------------------
DOCUMENTATION
--------------------------------------------------

Every major feature should include:

- Purpose
- Architecture summary
- API contracts
- Data flow

Document decisions, not obvious code.

--------------------------------------------------
GIT WORKFLOW
--------------------------------------------------

Use conventional commits:

feat:
fix:
refactor:
test:
docs:
chore:

Keep commits focused and atomic.

--------------------------------------------------
PERFORMANCE
--------------------------------------------------

Consider:

- Query efficiency
- Bundle size
- API latency
- Caching strategy

Avoid premature optimization but design for scale.





--------------------------------------------------
AI ASSISTANT BEHAVIOR
--------------------------------------------------

When implementing features:

1. Explain approach first
2. Generate production-ready code
3. Generate tests
4. Generate documentation
5. Validate acceptance criteria

When reviewing code:

Evaluate:

- Security
- Performance
- Scalability
- Maintainability
- Developer Experience

Reject weak implementations.

--------------------------------------------------
DEFAULT OUTPUT FORMAT
--------------------------------------------------

For implementation requests provide:

1. Architecture Summary
2. File Tree
3. Interfaces
4. Types
5. DTOs
6. Services
7. Controllers
8. Tests
9. Acceptance Criteria

Never skip architecture.


--------------------------------------------------
DEFINITION OF DONE
--------------------------------------------------

Work is complete only when:

? Requirements addressed
? Types are correct
? Build passes
? Tests pass
? Lint passes
? Documentation updated

Otherwise the work is incomplete.
