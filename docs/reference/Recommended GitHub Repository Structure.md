fish-marketplace-platform/
│
├── .github/
│   ├── workflows/
│   │   ├── backend-ci.yml
│   │   ├── frontend-ci.yml
│   │   ├── mobile-ci.yml
│   │   ├── security-scan.yml
│   │   └── deploy.yml
│   │
│   ├── ISSUE_TEMPLATE/
│   └── PULL_REQUEST_TEMPLATE.md
│
├── .claude/
│   │
│   ├── commands/
│   │   ├── build-authentication.md
│   │   ├── build-products.md
│   │   ├── build-orders.md
│   │   ├── build-payments.md
│   │   ├── build-delivery.md
│   │   ├── build-vendors.md
│   │   ├── build-driver-management.md
│   │   ├── build-settlement-engine.md
│   │   ├── build-food-safety.md
│   │   ├── build-dashboard.md
│   │   └── build-reporting.md
│   │
│   └── settings.local.json
│
├── .cursor/
│
├── docs/
│   │
│   ├── mission.md
│   ├── vision.md
│   ├── architecture.md
│   ├── tech-stack.md
│   ├── roadmap.md
│   ├── glossary.md
│   ├── environment-specification.md
│   │
│   ├── business/
│   │   ├── payment-providers.md
│   │   ├── settlement-engine.md
│   │   ├── order-allocation-engine.md
│   │   ├── driver-settlement-engine.md
│   │   ├── vendor-settlement-engine.md
│   │   ├── delivery-zones.md
│   │   └── pricing-engine.md
│   │
│   ├── compliance/
│   │   ├── food-safety-compliance.md
│   │   ├── cold-chain-requirements.md
│   │   ├── vendor-food-handling-guidelines.md
│   │   ├── delivery-food-handling-guidelines.md
│   │   └── quality-audit-procedures.md
│   │
│   ├── reference/
│   │   ├── jamaica-delivery-zones.md
│   │   ├── seafood-species.md
│   │   ├── parish-mapping.md
│   │   └── vehicle-types.md
│   │
│   └── adr/
│       ├── ADR-001-payment-provider-selection.md
│       ├── ADR-002-delivery-zones.md
│       ├── ADR-003-order-allocation-strategy.md
│       ├── ADR-004-driver-compensation.md
│       ├── ADR-005-cold-chain-monitoring.md
│       └── ADR-006-vendor-settlement.md
│
├── rules/
│   │
│   ├── business-rules.md
│   │
│   ├── backend.md
│   ├── frontend.md
│   ├── mobile.md
│   ├── security.md
│   ├── testing.md
│   │
│   ├── authentication.md
│   ├── products.md
│   ├── orders.md
│   ├── payments.md
│   ├── delivery.md
│   ├── vendors.md
│   ├── drivers.md
│   ├── settlements.md
│   │
│   ├── food-safety.md
│   ├── cold-chain-management.md
│   ├── quality-control.md
│   ├── batch-traceability.md
│   ├── seafood-grading.md
│   ├── spoilage-management.md
│   └── product-recalls.md
│
├── apps/
│   │
│   ├── web/
│   │   ├── customer-portal/
│   │   ├── vendor-portal/
│   │   ├── driver-portal/
│   │   └── admin-portal/
│   │
│   └── mobile/
│       ├── customer-app/
│       ├── vendor-app/
│       └── driver-app/
│
├── backend/
│   │
│   ├── api-gateway/
│   │
│   ├── services/
│   │   ├── auth-service/
│   │   ├── user-service/
│   │   ├── vendor-service/
│   │   ├── product-service/
│   │   ├── inventory-service/
│   │   ├── order-service/
│   │   ├── payment-service/
│   │   ├── settlement-service/
│   │   ├── delivery-service/
│   │   ├── driver-service/
│   │   ├── notification-service/
│   │   ├── food-safety-service/
│   │   ├── temperature-service/
│   │   ├── quality-control-service/
│   │   └── reporting-service/
│   │
│   └── workers/
│       ├── allocation-worker/
│       ├── settlement-worker/
│       ├── notification-worker/
│       └── temperature-monitor-worker/
│
├── packages/
│   │
│   ├── shared-types/
│   ├── shared-ui/
│   ├── shared-utils/
│   ├── shared-validation/
│   ├── shared-config/
│   └── shared-testing/
│
├── infrastructure/
│   │
│   ├── docker/
│   ├── kubernetes/
│   ├── terraform/
│   ├── monitoring/
│   ├── logging/
│   └── backups/
│
├── database/
│   ├── schema/
│   ├── migrations/
│   └── seeders/
│
└── scripts/