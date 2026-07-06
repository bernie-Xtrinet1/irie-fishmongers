# SEAFOOD COMPLIANCE RULES
# Irie Fishmongers Marketplace

Version: 1.0

This document defines the mandatory seafood safety, traceability,
cold-chain, quality control, inspection, and regulatory compliance
requirements for the Irie Fishmongers platform.

All platform features, databases, APIs, workflows, dashboards,
reports, and user interfaces must comply with these requirements.

---

# COMPLIANCE OBJECTIVES

The platform must ensure:

- Seafood safety
- Consumer protection
- Product traceability
- Cold-chain integrity
- Vendor accountability
- Fisherman accountability
- Regulatory reporting
- Food quality assurance

The platform must maintain an auditable chain of custody from catch
to customer delivery.

---

# COMPLIANCE PRINCIPLES

Every seafood item sold on the platform must be:

1. Traceable
2. Identifiable
3. Inspectable
4. Auditable
5. Temperature Monitored
6. Source Verified

No seafood product may enter the marketplace without source information.

---

# REGULATORY ALIGNMENT

Platform architecture must support compliance with:

- Jamaica Food Storage and Prevention of Infestation Regulations
- Public Health Food Handling Requirements
- Fisheries Regulations of Jamaica
- HACCP Principles
- Codex Alimentarius Seafood Guidelines
- International Seafood Traceability Best Practices

Platform must be configurable to support future regulatory changes.

---

# TRACEABILITY REQUIREMENTS

Every seafood lot must receive a unique lot identifier.

Example:

LOT-2025-000001

Each lot must maintain complete traceability.

Required fields:

- Lot ID
- Species
- Catch Date
- Catch Time
- Fisherman
- Vessel
- Landing Site
- Parish
- Vendor
- Inspection Records
- Temperature Records
- Delivery Records

Traceability chain:

Sea

→ Fisherman

→ Landing Site

→ Vendor

→ Storage

→ Delivery

→ Customer

No gaps are allowed.

---

# FISHERMAN REGISTRATION

Before a fisherman can sell seafood:

Required:

- Identity Verification
- Contact Information
- Vessel Information
- Fishing License (if applicable)
- Landing Site Assignment
- Banking Information

Status:

Pending

Approved

Suspended

Rejected

Only approved fishermen may submit catches.

---

# CATCH REGISTRATION

Every catch must be registered.

Required data:

Catch ID

Species

Weight

Catch Date

Catch Time

GPS Coordinates

Fishing Area

Landing Site

Fisherman

Vessel

Photos

Estimated Freshness

No inventory can be created without a catch record.

---

# LANDING SITE MANAGEMENT

Approved landing sites must be maintained.

Required fields:

- Site Name
- Parish
- GPS Coordinates
- Status
- Inspection Status

Every catch must be linked to a landing site.

---

# SPECIES MANAGEMENT

Every seafood item must belong to a managed species.

Examples:

- Snapper
- King Fish
- Mackerel
- Lobster
- Shrimp
- Conch (subject to regulations)

Each species record includes:

- Scientific Name
- Commercial Name
- Regulatory Status
- Seasonal Restrictions
- Minimum Size Rules

Platform must support future restrictions.

---

# QUALITY INSPECTION REQUIREMENTS

Every seafood lot may be inspected.

Inspection data:

Inspector

Timestamp

Location

Lot

Condition

Photos

Notes

Result

Possible outcomes:

Passed

Conditional

Rejected

Quarantined

Rejected lots cannot be sold.

---

# FRESHNESS GRADING

Seafood must be assigned a freshness grade.

Grades:

A

B

C

Rejected

Grade factors:

- Eyes
- Gills
- Odor
- Flesh Firmness
- Appearance
- Temperature

Only Grade A and B may be sold to customers.

---

# QUALITY SCORING

Each lot receives a score.

Range:

0–100

Suggested:

90-100 Premium

80-89 Excellent

70-79 Good

60-69 Limited Sale

Below 60 Rejected

Quality score must be visible internally.

---

# FOOD SAFETY INCIDENTS

The platform must support incident reporting.

Examples:

- Spoilage
- Contamination
- Temperature Abuse
- Damaged Packaging
- Product Recall

Incident fields:

ID

Timestamp

Reporter

Severity

Affected Lots

Photos

Corrective Actions

Resolution

---

# PRODUCT RECALL MANAGEMENT

The system must support recalls.

Recall workflow:

Issue Recall

Identify Lots

Identify Customers

Notify Stakeholders

Suspend Inventory

Generate Report

Track Resolution

Affected inventory becomes unavailable immediately.

---

# VENDOR COMPLIANCE

Every vendor must maintain:

Business Information

Food Handling Information

Storage Information

Operating Status

Inspection Records

Compliance Documents

Vendor statuses:

Pending

Approved

Suspended

Rejected

Suspended vendors cannot sell.

---

# STORAGE COMPLIANCE

Each storage facility must maintain:

Facility Name

Location

Capacity

Cold Storage Availability

Inspection Status

Temperature Monitoring

Compliance Status

Storage events must be recorded.

---

# AUDIT LOG REQUIREMENTS

Every compliance action must be auditable.

Record:

User

Timestamp

Action

Before Value

After Value

Device

IP Address

Reason

Audit records cannot be deleted.

---

# DOCUMENT MANAGEMENT

Store compliance documents:

Vendor Licenses

Food Handling Certificates

Inspection Reports

Temperature Reports

Recall Notices

Audit Reports

Documents must be versioned.

---

# CUSTOMER SAFETY DISCLOSURES

Product pages must display:

- Catch Date
- Vendor
- Landing Site
- Freshness Grade
- Temperature Compliance Status

Customers must be able to view seafood origin information.

---

# COMPLIANCE ALERTS

Generate alerts for:

Temperature Violations

Expired Inventory

Failed Inspections

Suspended Vendors

Recall Events

Missing Traceability Data

Severity levels:

Info

Warning

Critical

Critical alerts require immediate action.

---

# REPORTING REQUIREMENTS

Generate reports for:

- Traceability
- Temperature Compliance
- Vendor Compliance
- Quality Scores
- Inspection Results
- Recall History
- Food Safety Incidents

Reports must be exportable.

Formats:

PDF

Excel

CSV

---

# DATA RETENTION

Retain:

Traceability Data:
7 Years

Inspection Records:
7 Years

Temperature Records:
7 Years

Recall Records:
7 Years

Audit Logs:
Permanent

Compliance Documents:
7 Years Minimum

---

# PLATFORM ENFORCEMENT RULES

The platform must automatically block:

- Rejected Lots
- Quarantined Lots
- Expired Inventory
- Suspended Vendors
- Missing Traceability Records
- Missing Temperature Records

No exceptions.

---

# COMPLIANCE DASHBOARD

Admin Dashboard must include:

Compliance Score

Active Alerts

Temperature Violations

Failed Inspections

Pending Reviews

Recall Events

Vendor Compliance Status

Fisherman Compliance Status

---

# CLAUDE EXECUTION RULE

Before generating any:

- Database Schema
- API Endpoint
- UI Screen
- Workflow
- Business Logic
- Dashboard

You must verify compliance impacts.

If a feature could violate seafood safety, traceability,
quality control, food handling, or regulatory requirements,
the feature must be redesigned before implementation.

Compliance requirements always take priority over convenience,
speed, or commercial objectives.