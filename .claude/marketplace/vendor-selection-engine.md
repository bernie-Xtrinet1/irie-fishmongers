# VENDOR SELECTION ENGINE

Version: 1.0

---

# PURPOSE

Determine optimal vendor.

---

# INPUTS

Product

Quantity

Customer Location

Delivery Zone

Required Delivery Time

---

# ELIGIBILITY RULES

Vendor must:

Have inventory

Be active

Be compliant

Be within service area

Be able to fulfill quantity

---

# SCORING MODEL

Inventory Score

Freshness Score

Compliance Score

Distance Score

Vendor Rating

Delivery Capacity Score

---

# TOTAL SCORE

Weighted scoring model.

Highest score wins.

---

# DATABASE TABLES

vendor_scores

vendor_assignments

fulfillment_decisions

---

# AUDIT REQUIREMENTS

Store:

Decision Time

Decision Factors

Winning Vendor

Competing Vendors

Scores

---

# CLAUDE EXECUTION RULE

Selection logic must be configurable.

Weights stored in database.

Do not hardcode scoring values.