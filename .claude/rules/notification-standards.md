# Irie Fishmongers Notification Standards

## Purpose

This document defines the notification architecture, rules, templates, delivery methods, and implementation standards for all Irie Fishmongers platform notifications.

The notification system shall provide a consistent communication framework between:

* Customers
* Vendors
* Drivers
* Administrators
* System services

All platform modules shall use the Notification Service rather than directly sending emails, SMS, or push notifications.

---

# Design Principles

## Centralized Notification Service

All notifications must pass through:

```
Notification Module
```

No individual module may directly integrate with:

* Email providers
* SMS providers
* Push notification services

Example:

Incorrect:

```
Orders Module
     |
     +-- Send Email
```

Correct:

```
Orders Module
     |
     | OrderCreated Event
     |
Notification Module
     |
     +-- Email
     +-- SMS
     +-- Push
```

---

# Notification Channels

The system shall support:

```typescript
enum NotificationChannel {

 EMAIL,

 SMS,

 PUSH,

 IN_APP

}
```

---

# Notification Priority

```typescript
enum NotificationPriority {

 LOW,

 NORMAL,

 HIGH,

 CRITICAL

}
```

Priority determines delivery urgency.

---

# Notification Types

```typescript
enum NotificationType {

 ORDER,

 PAYMENT,

 DELIVERY,

 VENDOR,

 PRODUCT,

 INVENTORY,

 ACCOUNT,

 SECURITY,

 PROMOTION,

 SYSTEM

}
```

---

# Notification Entity

Create:

```
notifications
```

Database model:

```typescript
id

userId

type

channel

title

message

data

status

priority

sentAt

readAt

createdAt

updatedAt
```

---

# Notification Status

```typescript
enum NotificationStatus {

 PENDING,

 QUEUED,

 SENT,

 DELIVERED,

 FAILED,

 READ

}
```

---

# User Notification Preferences

Users must control communication preferences.

Create:

```
notification_preferences
```

Fields:

```typescript
id

userId

emailEnabled

smsEnabled

pushEnabled

marketingEnabled

orderUpdatesEnabled

deliveryUpdatesEnabled

securityAlertsEnabled

createdAt

updatedAt
```

---

# Required Notification Events

## Authentication Events

### Registration Successful

Recipient:

Customer/Vendor

Channel:

Email

Message:

Welcome message and account confirmation.

---

### Email Verification

Trigger:

User registers

Channel:

Email

Priority:

HIGH

---

### Password Reset

Trigger:

Forgot password request

Channel:

Email + SMS optional

Priority:

CRITICAL

---

### Suspicious Login

Trigger:

Security event

Channel:

Email + Push

Priority:

CRITICAL

---

# Vendor Notifications

## Vendor Registration Submitted

Recipient:

Vendor

Channel:

Email + In-App

---

## Vendor Approved

Recipient:

Vendor

Channel:

Email + Push

---

## Vendor Rejected

Recipient:

Vendor

Channel:

Email

Must include:

* rejection reason
* required corrections

---

## Vendor Suspended

Recipient:

Vendor

Channel:

Email + SMS

Priority:

HIGH

---

# Product Notifications

## Low Stock Alert

Recipient:

Vendor

Trigger:

Product quantity below threshold

---

## Product Deactivated

Recipient:

Vendor

Trigger:

Admin action or compliance issue

---

# Order Notifications

## Order Created

Recipient:

Customer

Channel:

Email + Push + In-App

---

## Vendor Order Received

Recipient:

Vendor

Channel:

Push + In-App

---

## Vendor Accepted Order

Recipient:

Customer

Channel:

Push + Email

---

## Vendor Preparing Order

Recipient:

Customer

---

## Ready For Pickup

Recipient:

Driver/Vendor

---

## Delivery Assigned

Recipients:

Customer

Driver

---

## Order Delivered

Recipient:

Customer

Channel:

Push + Email

---

# Payment Notifications

## Payment Successful

Recipient:

Customer

Priority:

HIGH

---

## Payment Failed

Recipient:

Customer

Priority:

HIGH

---

## Vendor Settlement Completed

Recipient:

Vendor

---

# Cold Chain Notifications

Future module support:

## Temperature Warning

Trigger:

Storage temperature outside threshold

Recipient:

Admin

Priority:

CRITICAL

Example:

```
Freezer Unit #002

Temperature:
-10°C

Required:
-18°C

Action Required
```

---

# Notification Templates

All templates shall be stored separately.

Example:

```
notification_templates
```

Fields:

```typescript
id

eventType

channel

subject

templateBody

variables

createdAt

updatedAt
```

Example:

Template:

```
Order {{orderNumber}} has been accepted by {{vendorName}}.
```

Variables:

```
orderNumber
vendorName
customerName
```

---

# Event-Based Architecture

Modules shall publish events.

Example:

Order module:

```typescript
OrderCreatedEvent
```

Notification service listens:

```typescript
on(OrderCreatedEvent)
```

Then creates notifications.

---

# Retry Policy

Failed notifications must retry.

Rules:

```
Attempt 1:
Immediately

Attempt 2:
5 minutes

Attempt 3:
30 minutes

Attempt 4:
2 hours
```

After failure:

```
status = FAILED
```

Log failure reason.

---

# Notification Logging

Create:

```
notification_logs
```

Fields:

```typescript
id

notificationId

provider

attemptNumber

response

errorMessage

createdAt
```

---

# Security Rules

Notifications must never expose:

* Passwords
* Payment credentials
* Private vendor information
* Internal system details

Sensitive actions must contain secure links.

Example:

Password reset:

```
https://iriefishmongers.com/reset-token
```

Never send passwords.

---

# SMS Rules

SMS should only be used for:

* Authentication codes
* Delivery updates
* Critical alerts

Marketing SMS requires explicit consent.

---

# Email Rules

Emails must include:

* Irie Fishmongers branding
* Support contact
* Unsubscribe option for marketing messages

---

# Implementation Requirements

The Notification Module must provide:

Services:

```
NotificationService

EmailService

SmsService

PushNotificationService

TemplateService
```

Interfaces:

```typescript
sendNotification()

sendEmail()

sendSms()

sendPush()

createTemplate()

```

---

# Future Integrations

The architecture should support:

* Firebase Cloud Messaging
* WhatsApp Business API
* Twilio SMS
* SendGrid/Amazon SES
* Customer mobile application push notifications

---

# Testing Requirements

Required tests:

Unit tests:

* notification creation
* preference handling
* template rendering
* retry logic

E2E tests:

* order notification flow
* vendor approval notification
* password reset notification
* failed delivery retry

```
```
# Additional Recommendation

For Irie Fishmongers specifically, I would make Order, Delivery, and Cold Chain notifications "mission critical" because seafood has a short shelf life.
The notification priority should eventually be:

🔴 Delivery failure / temperature breach
🔴 Payment failure
🔴 Order status changes
🟠 Vendor actions
🟢 Marketing/promotions

This structure will allow Claude to build the notification layer once and have every future module plug into it cleanly.