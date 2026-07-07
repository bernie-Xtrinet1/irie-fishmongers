# Irie Fishmongers – Vendor Verification & Compliance Module

## Purpose

The Vendor Verification & Compliance Module provides a flexible mechanism for verifying vendors before they are allowed to sell products on the Irie Fishmongers marketplace.

The system shall support multiple vendor categories with different verification requirements. Small fish vendors and fishermen shall not be subject to the same requirements as commercial seafood suppliers, importers, wholesalers, or processing companies.

The objective is to:

* Maintain marketplace trust and safety.
* Verify vendor identity.
* Support food safety and traceability.
* Avoid unnecessary barriers to entry for small vendors.
* Allow compliance requirements to evolve over time.

---

# Vendor Types

The system shall support the following vendor types:

```typescript
enum VendorType {
  FISHERMAN,
  FISH_PEDDLER,
  SMALL_BUSINESS,
  SEAFOOD_RETAILER,
  WHOLESALER,
  IMPORTER,
  PROCESSOR,
}
```

---

# Compliance Levels

```typescript
enum ComplianceLevel {
  BASIC,
  STANDARD,
  COMMERCIAL,
}
```

Compliance levels determine which documents are required.

---

# Vendor Profile Extensions

Add the following fields to Vendor:

```typescript
vendorType: VendorType

complianceLevel: ComplianceLevel

verifiedAt: DateTime | null

verifiedBy: string | null

complianceNotes: string | null

canSell: boolean

documentsVerified: boolean
```

---

# Vendor Document Types

```typescript
enum VendorDocumentType {
  GOVERNMENT_ID,
  BUSINESS_REGISTRATION,
  FISHING_LICENSE,
  FOOD_HANDLING_CERTIFICATE,
  FOOD_ESTABLISHMENT_PERMIT,
  IMPORT_PERMIT,
  TAX_REGISTRATION,
  INSURANCE_CERTIFICATE,
  BANK_VERIFICATION,
  OTHER,
}
```

---

# Vendor Documents Table

Create a VendorDocument entity.

```typescript
id

vendorId

documentType

fileUrl

documentNumber

issuedDate

expiryDate

verificationStatus

verifiedBy

verifiedAt

rejectionReason

createdAt

updatedAt
```

---

# Verification Status

```typescript
enum VerificationStatus {
  PENDING,
  APPROVED,
  REJECTED,
  EXPIRED,
}
```

---

# Required Documents by Vendor Type

## Fisherman

Required:

* Government ID

Optional:

* Fishing License

Compliance Level:

BASIC

---

## Fish Peddler

Required:

* Government ID

Optional:

* Food Handling Certificate

Compliance Level:

BASIC

---

## Small Business

Required:

* Government ID
* Business Registration

Optional:

* Food Handling Certificate
* Bank Verification

Compliance Level:

STANDARD

---

## Seafood Retailer

Required:

* Government ID
* Business Registration
* Food Handling Certificate

Compliance Level:

STANDARD

---

## Wholesaler

Required:

* Government ID
* Business Registration
* Food Handling Certificate
* Bank Verification

Compliance Level:

COMMERCIAL

---

## Importer

Required:

* Government ID
* Business Registration
* Import Permit
* Bank Verification

Optional:

* Insurance Certificate

Compliance Level:

COMMERCIAL

---

## Processor

Required:

* Government ID
* Business Registration
* Food Establishment Permit
* Bank Verification

Optional:

* Insurance Certificate

Compliance Level:

COMMERCIAL

---

# Business Rules

## Rule 1

A vendor may register without documents.

Vendor status:

```typescript
PENDING_VERIFICATION
```

---

## Rule 2

A vendor may upload documents after registration.

Documents remain in:

```typescript
PENDING
```

until reviewed.

---

## Rule 3

Only administrators may approve or reject documents.

---

## Rule 4

A vendor may not create products unless:

```typescript
vendor.canSell === true
```

---

## Rule 5

The system shall automatically detect expired documents.

Expired documents shall be marked:

```typescript
EXPIRED
```

---

## Rule 6

If a required document expires:

```typescript
canSell = false
```

New orders remain active.

New listings are blocked until compliance is restored.

---

# Admin Endpoints

```http
GET /admin/vendors/compliance

GET /admin/vendors/:id/compliance

POST /admin/vendors/:id/approve

POST /admin/vendors/:id/reject

POST /admin/documents/:id/approve

POST /admin/documents/:id/reject
```

---

# Vendor Endpoints

```http
GET /vendors/me/compliance

POST /vendors/me/documents

GET /vendors/me/documents

DELETE /vendors/me/documents/:id
```

---

# Future Enhancements

The module shall be designed to support future:

* Product traceability.
* Seafood batch tracking.
* Catch location records.
* Vessel registration.
* HACCP compliance.
* Export certifications.
* Insurance verification.
* Automated document expiry notifications.
* QR-code seafood traceability.

```
```
