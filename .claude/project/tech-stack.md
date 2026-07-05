# IrieFishmongers Technology Stack

Version: 1.0

---

# Technology Principles

All development must prioritize:

- Scalability
- Security
- Maintainability
- Cloud-native deployment
- Mobile-first development
- API-first architecture

Only approved technologies may be introduced.

---

# Frontend

Primary Framework:

- Next.js

Language:

- TypeScript

UI Framework:

- TailwindCSS

Component Library:

- ShadCN UI

State Management:

- React Query
- Context API

Form Handling:

- React Hook Form

Validation:

- Zod

Charts:

- Recharts

Testing:

- Jest
- React Testing Library

---

# Mobile Applications

Framework:

- React Native

Platform:

- Expo

Language:

- TypeScript

Navigation:

- React Navigation

State Management:

- React Query

Forms:

- React Hook Form

Validation:

- Zod

Notifications:

- Expo Notifications

Testing:

- Jest
- React Native Testing Library

Applications:

- Customer App
- Vendor App
- Driver App

---

# Backend

Framework:

- NestJS

Language:

- TypeScript

Architecture:

- Modular Monolith (Phase 1)
- Microservices Ready (Phase 2)

API Style:

- REST API

Future Support:

- GraphQL

Validation:

- Class Validator
- Class Transformer

Authentication:

- JWT
- Refresh Tokens

Documentation:

- Swagger/OpenAPI

Testing:

- Jest

---

# Database

Primary Database:

- PostgreSQL

ORM:

- Prisma

Migration Tool:

- Prisma Migrate

Connection Pooling:

- PgBouncer

---

# Caching

Platform:

- Redis

Use Cases:

- Session management
- Rate limiting
- API caching
- Queue processing

---

# Queue System

Technology:

- BullMQ

Queue Backend:

- Redis

Use Cases:

- Payment processing
- Notifications
- Settlement processing
- Delivery tracking updates

---

# Search

Phase 1:

- PostgreSQL Full Text Search

Phase 2:

- Elasticsearch

Use Cases:

- Product search
- Vendor search
- Location search

---

# File Storage

Provider:

- AWS S3

Use Cases:

- Product images
- Vendor documents
- Proof of delivery images

---

# Maps and Location Services

Provider:

- Google Maps Platform

Services:

- Geocoding
- Distance Matrix
- Route Optimization

Future Alternative:

- OpenStreetMap

---

# Payments

Primary Provider:

- WiPay

Secondary Provider:

- Stripe

Payment Types:

- Card Payments
- Online Payments

Future:

- Digital Wallets
- Bank Transfers

---

# Notifications

Email:

- SendGrid

SMS:

- Twilio (Future)

Push Notifications:

- Expo Push Notifications

---

# Authentication

Method:

- Email and Password

Support:

- JWT Access Tokens
- JWT Refresh Tokens

Future:

- Google Login
- Apple Login
- Multi-Factor Authentication

---

# Security

Password Hashing:

- bcrypt

Rate Limiting:

- NestJS Throttler

HTTP Security:

- Helmet

Input Sanitization:

- Class Validator

Secrets Management:

- Environment Variables

---

# Logging

Framework:

- Winston

Format:

- Structured JSON Logging

Log Storage:

- CloudWatch (Production)

---

# Monitoring

Metrics:

- Prometheus

Visualization:

- Grafana

Error Tracking:

- Sentry

---

# Infrastructure

Cloud Provider:

- AWS

Containerization:

- Docker

Orchestration:

- Kubernetes (Phase 2)

Infrastructure as Code:

- Terraform

---

# CI/CD

Repository:

- GitHub

Automation:

- GitHub Actions

Deployment Strategy:

- Staging
- Production

Required Checks:

- Lint
- Tests
- Type Check
- Security Scan

---

# Testing Standards

Backend:

- Jest

Frontend:

- Jest
- React Testing Library

Mobile:

- React Native Testing Library

E2E:

- Playwright

Coverage Target:

- 90%

Minimum Coverage:

- 80%

---

# Environment Strategy

Development

- Local PostgreSQL
- Local Redis

Staging

- Managed PostgreSQL
- Managed Redis

Production

- AWS RDS PostgreSQL
- AWS ElastiCache Redis

---

# Approved Repository Structure

apps/
??? web/
??? customer-mobile/
??? vendor-mobile/
??? driver-mobile/

backend/
??? api/

packages/
??? ui/
??? types/
??? shared/
??? config/

docs/
infrastructure/

---

# Claude Code Directive

When generating code:

1. Use only approved technologies.
2. Prefer TypeScript for all applications.
3. Maintain consistency across services.
4. Design for CARICOM expansion.
5. Avoid introducing new dependencies without justification.
6. Build APIs and data models with multi-vendor fulfillment support.
7. Ensure all architecture decisions support scalability, security, and maintainability.
