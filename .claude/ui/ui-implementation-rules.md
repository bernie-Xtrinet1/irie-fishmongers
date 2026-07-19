# UI IMPLEMENTATION RULES
# Irie Fishmongers Marketplace

Version: 1.0

---

# PURPOSE

This document instructs Claude how to:

1. Build all application screens
2. Refactor existing screens
3. Reuse components
4. Maintain branding
5. Follow role-based access control
6. Preserve existing functionality

---

# AUTHORITATIVE SOURCES

Claude must use:

ui-design-system.md

ui-screen-library.md

customer-screens.md

vendor-screens.md

driver-screens.md

admin-screens.md

mobile-design-guidelines.md

before generating any UI code.

---

# EXISTING CODE RULES

Before creating new code:

Analyze existing codebase.

Identify:

- Existing pages
- Existing components
- Existing layouts
- Existing routes
- Existing APIs

Do not duplicate functionality.

Refactor existing code whenever possible.

---

# COMPONENT REUSE

Always reuse:

Buttons

Cards

Tables

Forms

Modals

Alerts

Navigation

Layouts

Maps

Charts

before creating new components.

---

# DESIGN CONSISTENCY

All screens must follow:

ui-design-system.md

Requirements:

Consistent spacing

Consistent typography

Consistent color palette

Consistent form controls

Consistent navigation

---

# BRANDING

Use:

Irie Fishmongers Logo

Ocean Blue

Seafoam Green

Fresh Coral

White Background

Never introduce additional primary colors.

---

# RESPONSIVE DESIGN

Every screen must support:

Desktop

Tablet

Mobile

No desktop-only pages.

---

# ROLE-BASED ACCESS

Customer screens:

Customer only

Vendor screens:

Vendor only

Driver screens:

Driver only

Admin screens:

Admin only

Inspector screens:

Inspector only

---

# IMPLEMENTATION PROCESS

For every screen:

Step 1

Check screen definition.

Step 2

Locate existing page.

Step 3

Determine:

Create

Modify

Refactor

Reuse

Step 4

Implement.

Step 5

Test responsiveness.

Step 6

Test role permissions.

---

# FILE GENERATION RULE

When creating a screen provide:

Page file

Component files

Hooks

Types

API integration

Tests

---

# NAVIGATION RULES

If a new screen is added:

Update:

Sidebar

Top Navigation

Mobile Navigation

Breadcrumbs

Route Definitions

---

# STATE MANAGEMENT

Use existing state architecture.

Do not introduce a new state framework.

Reuse:

Redux

Zustand

Context

or existing solution.

---

# API INTEGRATION

Reuse existing APIs.

Only create new endpoints when necessary.

Avoid duplicate APIs.

---

# TESTING REQUIREMENTS

For every screen:

Create:

Unit Tests

Accessibility Tests

Responsive Tests

Role Access Tests

---

# REFACTORING RULES

When modifying existing code:

Preserve:

Business Logic

Database Schema

API Contracts

Authentication

Audit Logging

Compliance Features

---

# CLAUDE EXECUTION RULE

Before generating code:

1. Compare requirements against existing code.
2. Identify gaps.
3. Produce implementation plan.
4. Refactor where possible.
5. Create missing components.
6. Generate code.
7. Generate tests.

# VENDOR TIER DISPLAY RULES

Vendor tier badges must be visible on:

- Product Detail Screen
- Search Results
- Marketplace Listings
- Vendor Profile
- Order History

---

# MARKETPLACE MODE RULES

Support:

1. Customer Selected Vendor

2. Best Available Vendor

Mode controlled by configuration.

Do not hardcode.

---

# VENDOR SELECTION RULES

When Best Available Vendor is selected:

Display:

Fulfilled by Irie Fishmongers

System chooses vendor using:

- Inventory
- Freshness
- Compliance
- Distance
- Delivery Capacity