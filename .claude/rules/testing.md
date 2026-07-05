# Testing Rules

## Coverage

Minimum:

80%

Target:

90%

---

## Required Tests

Every module must include:

- Unit Tests
- Integration Tests
- End-to-End Tests

---

## Backend Testing

Test:

- services
- controllers
- repositories

Mock external services.

---

## Frontend Testing

Test:

- components
- forms
- page flows

---

## Mobile Testing

Test:

- navigation
- forms
- API integration

---

## Authentication Testing

Test:

- registration
- login
- logout
- password reset
- token refresh

---

## Payments Testing

Test:

- successful payments
- failed payments
- refunds
- webhook verification

---

## Delivery Testing

Test:

- driver assignment
- status updates
- tracking

---

## Regression Testing

Every new feature must not break:

- authentication
- orders
- payments
- delivery

---

## Build Validation

Before completion:

1. Run linting
2. Run type checking
3. Run tests
4. Verify coverage
5. Update documentation

A module is NOT complete until all checks pass.
