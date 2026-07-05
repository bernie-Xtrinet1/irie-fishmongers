# Build Authentication Module

## Objective
Build a production-ready authentication and authorization system for the Irie Fishmongers platform.

## Requirements

### User Roles
- Customer
- Vendor
- Driver
- Administrator

### Features
- User registration
- Email verification
- Login
- Logout
- Password reset
- Refresh tokens
- JWT authentication
- Role-based access control (RBAC)
- Account status management

### Database Tables
- users
- roles
- user_roles
- refresh_tokens

### API Endpoints

POST /auth/register
POST /auth/login
POST /auth/logout
POST /auth/refresh
POST /auth/forgot-password
POST /auth/reset-password

### Security Requirements
- bcrypt password hashing
- JWT access token
- JWT refresh token
- Rate limiting
- Input validation
- Secure cookies

### Testing
- Unit tests
- Integration tests

## Deliverables
- Database schema
- Controllers
- Services
- DTOs
- Validation
- Tests
- API documentation

Do not proceed to another module until all tests pass.
