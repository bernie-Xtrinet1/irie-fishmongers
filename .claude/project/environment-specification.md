# Environment Specification

Version: 1.0

---

# Environment Strategy

The platform supports:

- Development
- Testing
- Staging
- Production

Each environment must be isolated.

---

# Development Environment

Purpose:

Local development.

Services:

- PostgreSQL
- Redis
- Backend API
- Web Application

Deployment:

Docker Compose

---

# Testing Environment

Purpose:

Automated testing.

Requirements:

- Temporary database
- Temporary Redis instance
- Mock external services

---

# Staging Environment

Purpose:

Pre-production validation.

Infrastructure:

- AWS RDS PostgreSQL
- AWS ElastiCache Redis
- S3 Storage

Must mirror production as closely as possible.

---

# Production Environment

Purpose:

Live customer traffic.

Infrastructure:

- AWS ECS/EKS
- PostgreSQL
- Redis
- S3
- CloudFront

Requirements:

- High availability
- Automated backups
- Monitoring
- Disaster recovery

---

# Required Environment Variables

## Application

APP_NAME
APP_URL
APP_PORT
NODE_ENV

---

## Authentication

JWT_SECRET
JWT_REFRESH_SECRET
JWT_EXPIRES_IN
JWT_REFRESH_EXPIRES_IN

---

## Database

DATABASE_URL

Example:

postgresql://user:password@host:5432/db

---

## Redis

REDIS_HOST
REDIS_PORT
REDIS_PASSWORD

---

## AWS

AWS_REGION
AWS_ACCESS_KEY_ID
AWS_SECRET_ACCESS_KEY
AWS_S3_BUCKET

---

## WiPay

WIPAY_API_KEY
WIPAY_ACCOUNT_ID
WIPAY_WEBHOOK_SECRET

---

## Stripe

STRIPE_SECRET_KEY
STRIPE_WEBHOOK_SECRET

---

## Email

SENDGRID_API_KEY
EMAIL_FROM

---

## Notifications

EXPO_ACCESS_TOKEN

---

## Maps

GOOGLE_MAPS_API_KEY

---

## Monitoring

SENTRY_DSN

---

## Security

BCRYPT_ROUNDS
RATE_LIMIT_TTL
RATE_LIMIT_LIMIT

---

# Secrets Management

Secrets must:

- Never be committed
- Never be logged
- Never be exposed to frontend clients

Production secrets must use:

- AWS Secrets Manager

---

# Environment File Standards

Backend:

.env

Development:

.env.development

Testing:

.env.test

Staging:

.env.staging

Production:

.env.production

---

# Backup Requirements

Database:

- Daily backups
- Point-in-time recovery

Storage:

- S3 versioning enabled

---

# Monitoring Requirements

Monitor:

- API availability
- Database performance
- Queue processing
- Payment processing
- Delivery events

---

# Disaster Recovery Objectives

Recovery Time Objective (RTO):

< 4 Hours

Recovery Point Objective (RPO):

< 15 Minutes

---

# Claude Code Directive

When generating code:

- Use environment variables for all configuration.
- Never hardcode credentials.
- Support all deployment environments.
- Ensure production-grade security practices.
