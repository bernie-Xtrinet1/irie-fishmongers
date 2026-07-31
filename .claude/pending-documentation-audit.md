
These are my instructions and decisions to claude.

# Vendor Tier documentation

Approve.

If the Prisma schema contains only:

COMMUNITY_FISHER
VERIFIED_VENDOR
COMMERCIAL_SUPPLIER
ENTERPRISE_SUPPLIER

then every document describing a completely different VendorType hierarchy should be marked Superseded.

No code changes.

# Compliance Score documentation

Approve.

If ComplianceScoreService already computes scores automatically, then every document saying

"Compliance Score not implemented"

is simply outdated.

No architectural decision required.

# Brand colors

Approve.

The CSS is the source of truth.

Documentation should point to the design system instead of redefining colors.

# admin-screens.md

Approve.

A placeholder file referenced as mandatory documentation is technical debt.

Claude should generate the real document from the current UI instead of inventing screens

# Windows launch.json

Approve.

# Freshness Grades
Keep Current code:A
B
C
Rejected
Document: A+
A
B
C

Recommendation:
keep A+ documented as Future
keep current schema unchanged
label documentation as Current Implementation

Future Enhancement

# Inventory split fulfillment
The vision is
one customer
one checkout
multiple vendors
automatic allocation
Label the feature: Future Phase

# Queue Technology
Documentation should read Current implementation:
Cron Scheduler

Planned:
BullMQ

# Notification providers
Current:
FCM

Future:
Expo Push

# Payment providers
Align it with the roadmap:
Document

Current
WiPay
COD

Future
Stripe
PayPal
Lynk

# Testing Framework
Don't rewrite CLAUDE.md to say "Jest forever."

Instead:

Current:
Jest

Future:
Playwright
Vitest (if adopted)

# Category C — Items requiring my decision
Freshness grading : A
B
C
Rejected
implemented this category until the category A+
A
B
C
Rejected
is needed.

Split Fulfillment is decided as follows:
One order can be fulfilled by multiple vendors. Implementation: Yes

# Queue
The recommendation is BullMQ

not RabbitMQ.

# Push Notifications
Recommendation is Current:

FCM

Future:

Expo Push

# Payments
Recommendation

Current

WiPay
Cash

Future

Stripe
PayPal
Lynk

# Testing
Current
Jest

Future
Playwright

Before changing documentation, do a repository audit to identify every place where documentation and implementation diverge and classify each difference as:

Implemented (matches code)
Planned (intentional future work)
Deprecated (should be archived)
Incorrect (documentation is wrong)

Then generate a single authoritative document, as follows:

docs/IMPLEMENTATION_STATUS.md
