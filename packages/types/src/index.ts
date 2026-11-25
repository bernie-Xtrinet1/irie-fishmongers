// Hand-mirrored from the backend response entities (backend/src/modules/
// products/entities, backend/src/modules/food-safety/entities,
// backend/src/modules/vendor-tiers/entities). Dates travel over the wire as
// ISO strings, not Date objects, since these types describe parsed JSON.

export enum VendorTier {
  COMMUNITY_FISHER = 'COMMUNITY_FISHER',
  VERIFIED_VENDOR = 'VERIFIED_VENDOR',
  COMMERCIAL_SUPPLIER = 'COMMERCIAL_SUPPLIER',
  ENTERPRISE_SUPPLIER = 'ENTERPRISE_SUPPLIER',
}

export enum Parish {
  KINGSTON = 'KINGSTON',
  ST_ANDREW = 'ST_ANDREW',
  ST_CATHERINE = 'ST_CATHERINE',
  CLARENDON = 'CLARENDON',
  MANCHESTER = 'MANCHESTER',
  ST_ELIZABETH = 'ST_ELIZABETH',
  HANOVER = 'HANOVER',
  WESTMORELAND = 'WESTMORELAND',
  ST_JAMES = 'ST_JAMES',
  TRELAWNY = 'TRELAWNY',
  ST_ANN = 'ST_ANN',
  ST_MARY = 'ST_MARY',
  PORTLAND = 'PORTLAND',
  ST_THOMAS = 'ST_THOMAS',
}

export enum ProductUnit {
  PER_POUND = 'PER_POUND',
  PER_KILOGRAM = 'PER_KILOGRAM',
  PER_PACKAGE = 'PER_PACKAGE',
  PER_ITEM = 'PER_ITEM',
}

export enum ProductAvailability {
  ACTIVE = 'ACTIVE',
  OUT_OF_STOCK = 'OUT_OF_STOCK',
  INACTIVE = 'INACTIVE',
  ON_HOLD = 'ON_HOLD',
}

export enum SeafoodStorageType {
  FRESH = 'FRESH',
  FROZEN = 'FROZEN',
}

export enum FreshnessGrade {
  GRADE_A = 'GRADE_A',
  GRADE_B = 'GRADE_B',
  GRADE_C = 'GRADE_C',
  REJECTED = 'REJECTED',
}

export enum VendorComplianceStatusLabel {
  NOT_YET_ASSESSED = 'NOT_YET_ASSESSED',
  COMPLIANT = 'COMPLIANT',
  AT_RISK = 'AT_RISK',
  NON_COMPLIANT = 'NON_COMPLIANT',
}

// Customer-facing compliance band (Phase 13C/13E). Distinct from
// VendorComplianceStatusLabel (internal risk classification): this is the
// wording shown to shoppers, derived server-side from the numeric score.
export enum ComplianceBand {
  EXCELLENT = 'EXCELLENT',
  GOOD = 'GOOD',
  FAIR = 'FAIR',
  NEEDS_IMPROVEMENT = 'NEEDS_IMPROVEMENT',
  NOT_YET_ASSESSED = 'NOT_YET_ASSESSED',
}

export enum ReviewModerationStatus {
  VISIBLE = 'VISIBLE',
  REMOVED_BY_AUTHOR = 'REMOVED_BY_AUTHOR',
  REMOVED_BY_ADMIN = 'REMOVED_BY_ADMIN',
}

export interface ProductResponse {
  id: string;
  vendorId: string;
  categoryId: string;
  lotId: string | null;
  name: string;
  description: string;
  unit: ProductUnit;
  price: string;
  currency: string;
  quantityAvailable: number;
  imageUrl: string;
  isActive: boolean;
  availability: ProductAvailability;
  createdAt: string;
}

export interface SeafoodLotPublic {
  lotNumber: string;
  species: string;
  storageType: SeafoodStorageType;
  catchDate: string;
  catchLocation: string | null;
  landingSite: string | null;
  freshnessGrade: FreshnessGrade | null;
  qualityScore: number | null;
  lastInspectedAt: string | null;
  vendorBusinessName: string;
  temperatureVerified: boolean;
}

export interface ProductDetailVendor {
  id: string;
  businessName: string;
  tier: VendorTier;
  badge: string;
  parish: Parish;
  complianceScore: number | null;
  complianceStatus: VendorComplianceStatusLabel;
  complianceBand: ComplianceBand;
  rating: number | null;
  logoUrl: string | null;
}

// Public, customer-facing review shape (Phase 13E). Deliberately carries NO
// authorId, email, phone, or delivery/address data - authorDisplayName is a
// masked "First L." derived server-side, verifiedPurchase is always true.
export interface ReviewSummary {
  id: string;
  authorDisplayName: string;
  verifiedPurchase: boolean;
  rating: number;
  title: string | null;
  body: string;
  productId: string | null;
  productName: string | null;
  createdAt: string;
  editedAt: string | null;
}

export interface PaginatedReviews {
  items: ReviewSummary[];
  total: number;
  page: number;
  pageSize: number;
  averageRating: number | null;
}

export interface ReviewEligibility {
  eligible: boolean;
  reason: string | null;
}

export interface CreateReviewInput {
  vendorOrderId: string;
  productId?: string;
  rating: number;
  title?: string;
  body: string;
}

export interface UpdateReviewInput {
  rating?: number;
  title?: string;
  body?: string;
}

export interface MarketplaceModes {
  customerSelectedEnabled: boolean;
  bestAvailableEnabled: boolean;
}

export interface ProductDetail extends ProductResponse {
  lot: SeafoodLotPublic | null;
  vendor: ProductDetailVendor;
  marketplaceModes: MarketplaceModes;
}

export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface BestVendorResolution {
  productId: string;
  vendorId: string;
  badge: string;
  totalScore: string;
  fulfillmentDecisionId: string;
}

export interface VendorProfile {
  id: string;
  businessName: string;
  tier: VendorTier;
  badge: string;
  parish: Parish;
  complianceScore: number | null;
  complianceBand: ComplianceBand;
  complianceScoreUpdatedAt: string | null;
  foodSafetyStatus: VendorComplianceStatusLabel;
  traceabilityStatus: VendorComplianceStatusLabel;
  ordersCompleted: number;
  rating: number | null;
  coldChainScore: number | null;
  recentReviews: ReviewSummary[];
}

// --- Admin Dashboard (Phase 12A) ---
// Hand-mirrored from backend/src/modules/analytics/entities/dashboard-summary.entity.ts
// - verify against that source (or GET /api/v1/docs) before relying on a
// field that isn't already used elsewhere in this file.

export interface DashboardFinancials {
  grossPaidAmount: string;
  platformCommission: string;
  currency: 'JMD';
}

export interface VendorOrdersByStatus {
  PENDING: number;
  ACCEPTED: number;
  PREPARING: number;
  READY_FOR_PICKUP: number;
  ASSIGNED_TO_DRIVER: number;
  IN_TRANSIT: number;
  DELIVERED: number;
  DELIVERY_FAILED: number;
  REJECTED: number;
  CANCELLED: number;
}

export interface DashboardOrderCounts {
  customerOrdersTotal: number;
  vendorOrdersByStatus: VendorOrdersByStatus;
}

export interface FourWayStatusCounts {
  PENDING: number;
  APPROVED: number;
  SUSPENDED: number;
  REJECTED: number;
}

export interface DashboardVendorCounts {
  byStatus: FourWayStatusCounts;
}

export interface DashboardDriverCounts {
  byStatus: FourWayStatusCounts;
}

export interface AlertsBySeverity {
  WARNING: number;
  CRITICAL: number;
  EMERGENCY: number;
}

export interface DashboardComplianceSummary {
  activeAlertsBySeverity: AlertsBySeverity;
  activeRecalls: number;
}

export interface DashboardSystemHealth {
  postgres: 'up' | 'down';
  redis: 'up' | 'down';
}

export interface DashboardSummary {
  financials?: DashboardFinancials;
  orders: DashboardOrderCounts;
  vendors: DashboardVendorCounts;
  drivers: DashboardDriverCounts;
  compliance: DashboardComplianceSummary;
  systemHealth: DashboardSystemHealth;
}

// --- Vendor Dashboard (Phase 12B) ---
// Hand-mirrored from backend/src/modules/analytics/entities/vendor-dashboard.entity.ts

export interface VendorTierCounts {
  COMMUNITY_FISHER: number;
  VERIFIED_VENDOR: number;
  COMMERCIAL_SUPPLIER: number;
  ENTERPRISE_SUPPLIER: number;
}

export interface TopVendor {
  vendorId: string;
  businessName: string;
  grossAmount: string;
}

export interface VendorDashboard {
  byStatus: FourWayStatusCounts;
  byTier: VendorTierCounts;
  averageComplianceScore: number | null;
  topVendorsByRevenue?: TopVendor[];
}

// --- Sales Analytics (Phase 12B) ---
// Hand-mirrored from backend/src/modules/analytics/entities/sales-analytics.entity.ts

export interface TopProduct {
  productId: string;
  productName: string;
  quantitySold: number;
  revenue: string;
}

export interface CategorySales {
  categoryId: string;
  categoryName: string;
  quantitySold: number;
  revenue: string;
}

export interface SalesByPaymentMethod {
  WIPAY: string;
  CASH_ON_DELIVERY: string;
}

export interface SalesAnalytics {
  topProductsByRevenue: TopProduct[];
  salesByCategory: CategorySales[];
  salesByPaymentMethod: SalesByPaymentMethod;
  averageOrderValue: string;
  currency: 'JMD';
}

// --- Delivery Analytics (Phase 12B) ---
// Hand-mirrored from backend/src/modules/analytics/entities/delivery-analytics.entity.ts

export interface ZoneBreachSummary {
  zoneId: string;
  totalBreaches: number;
  unresolvedBreaches: number;
}

export interface FleetZoneSummary {
  zoneId: string;
  status: string;
  count: number;
}

export interface DeliveryAcceptanceCounts {
  PENDING: number;
  ACCEPTED: number;
  REJECTED: number;
}

export interface DeliveryAnalytics {
  slaBreachesByZone: ZoneBreachSummary[];
  totalUnresolvedBreaches: number;
  fleetByZone: FleetZoneSummary[];
  byCustomerAcceptanceStatus: DeliveryAcceptanceCounts;
}

// --- Inventory Analytics (Phase 12B) ---
// Hand-mirrored from backend/src/modules/analytics/entities/inventory-analytics.entity.ts

export interface ProductAvailabilityCounts {
  ACTIVE: number;
  OUT_OF_STOCK: number;
  INACTIVE: number;
  ON_HOLD: number;
}

export interface LowStockProduct {
  productId: string;
  productName: string;
  quantityAvailable: number;
  vendorId: string;
}

export interface InventoryEventTypeSummary {
  count: number;
  totalQuantityDelta: number;
}

export interface InventoryEventCounts {
  DECREMENTED: InventoryEventTypeSummary;
  RESTOCKED: InventoryEventTypeSummary;
  MANUAL_ADJUSTMENT: InventoryEventTypeSummary;
  DISPOSED: InventoryEventTypeSummary;
}

export interface InventoryAnalytics {
  byAvailability: ProductAvailabilityCounts;
  lowStockProducts: LowStockProduct[];
  eventsByType: InventoryEventCounts;
}

// --- Vendor Management (Phase 12A) ---

export enum VendorStatus {
  PENDING = 'PENDING',
  APPROVED = 'APPROVED',
  SUSPENDED = 'SUSPENDED',
  REJECTED = 'REJECTED',
}

// GET /vendors and PATCH /vendors/:id/status serialize the raw Prisma
// Vendor record (there is no ClassSerializerInterceptor registered), which
// is wider than the backend's own VendorResponseEntity Swagger class - it
// also includes tier/complianceScore/primaryZoneId/updatedAt. This type
// mirrors the real runtime response, not the (currently incomplete)
// Swagger doc; verify against a live response if backend/src/modules/
// vendors/entities/vendor-response.entity.ts is ever corrected to match.
export interface VendorAdmin {
  id: string;
  userId: string;
  businessName: string;
  description: string | null;
  phone: string | null;
  parish: Parish;
  logoUrl: string | null;
  status: VendorStatus;
  tier: VendorTier;
  complianceScore: number | null;
  termsAcceptedAt: string;
  primaryZoneId: string | null;
  createdAt: string;
  updatedAt: string;
}

// PATCH /vendors/:id/status only accepts this subset - PENDING is never a
// settable target (vendors start PENDING at registration).
export const ASSIGNABLE_VENDOR_STATUSES = [
  VendorStatus.APPROVED,
  VendorStatus.SUSPENDED,
  VendorStatus.REJECTED,
] as const;

export type AssignableVendorStatus = (typeof ASSIGNABLE_VENDOR_STATUSES)[number];

// --- Driver Management (Phase 12A) ---

export enum DriverStatus {
  PENDING = 'PENDING',
  APPROVED = 'APPROVED',
  SUSPENDED = 'SUSPENDED',
  REJECTED = 'REJECTED',
}

export enum DriverAvailabilityStatus {
  ONLINE = 'ONLINE',
  OFFLINE = 'OFFLINE',
  BUSY = 'BUSY',
}

export enum VehicleType {
  MOTORCYCLE = 'MOTORCYCLE',
  CAR = 'CAR',
  VAN = 'VAN',
  TRUCK = 'TRUCK',
}

export enum VehicleOwnership {
  PERSONAL_VEHICLE = 'PERSONAL_VEHICLE',
  COMPANY_VEHICLE = 'COMPANY_VEHICLE',
  RENTED_VEHICLE = 'RENTED_VEHICLE',
}

// GET /drivers and PATCH /drivers/:id/status serialize the raw Prisma
// Driver record (no ClassSerializerInterceptor, same drift as VendorAdmin
// above) - wider than the backend's DriverResponseEntity Swagger class,
// which is missing vehicleOwnership/assignedZoneId/updatedAt.
export interface DriverAdmin {
  id: string;
  userId: string;
  licensePlate: string;
  vehicleType: VehicleType;
  vehicleOwnership: VehicleOwnership;
  status: DriverStatus;
  availabilityStatus: DriverAvailabilityStatus;
  capacityLbs: string | null;
  coldChainCapable: boolean;
  assignedZoneId: string | null;
  createdAt: string;
  updatedAt: string;
}

// PATCH /drivers/:id/status only accepts this subset - PENDING is never a
// settable target (drivers start PENDING at registration).
export const ASSIGNABLE_DRIVER_STATUSES = [
  DriverStatus.APPROVED,
  DriverStatus.SUSPENDED,
  DriverStatus.REJECTED,
] as const;

export type AssignableDriverStatus = (typeof ASSIGNABLE_DRIVER_STATUSES)[number];

// GET /drivers/:id/performance and GET /drivers/me/performance - every
// field is a 0-1 ratio (or a minute duration) that is null when the
// driver has no qualifying deliveries yet, never 0 by default.
export interface DriverPerformanceMetrics {
  onTimeDeliveryRate: number | null;
  averagePickupDelayMinutes: number | null;
  customerAcceptanceRate: number | null;
  failedDeliveryRate: number | null;
  temperatureComplianceRate: number | null;
  averageDeliveryDurationMinutes: number | null;
}

// --- Delivery Zone & Fleet Management (Phase 12A) ---

// GET/POST/PATCH /delivery-zones - DeliveryZoneResponseEntity declares
// exactly the scalar Prisma DeliveryZone fields, no drift here.
export interface DeliveryZone {
  id: string;
  name: string;
  code: string;
  description: string | null;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export enum FleetAssetType {
  REFRIGERATED_TRUCK = 'REFRIGERATED_TRUCK',
  TRUCK = 'TRUCK',
  VAN = 'VAN',
}

export enum FleetOwnership {
  COMPANY_OWNED = 'COMPANY_OWNED',
  RENTED = 'RENTED',
}

export enum FleetAssetStatus {
  ACTIVE = 'ACTIVE',
  MAINTENANCE = 'MAINTENANCE',
  RETIRED = 'RETIRED',
}

// GET/PATCH /fleet-assets - FleetAssetResponseEntity declares exactly the
// scalar Prisma FleetAsset fields, no drift here.
export interface FleetAsset {
  id: string;
  zoneId: string;
  assetType: FleetAssetType;
  ownership: FleetOwnership;
  licensePlate: string;
  capacityLbs: string;
  coldChainCapable: boolean;
  status: FleetAssetStatus;
  currentDriverId: string | null;
  createdAt: string;
  updatedAt: string;
}

// GET /fleet-trips - FleetTripResponseEntity declares exactly the scalar
// Prisma FleetTrip fields, no drift here.
export interface FleetTrip {
  id: string;
  fleetAssetId: string;
  driverId: string;
  zoneId: string;
  startedAt: string;
  endedAt: string | null;
  fuelCost: string | null;
  driverWage: string | null;
  maintenanceAllocation: string | null;
  insuranceAllocation: string | null;
  createdAt: string;
}

// --- Cold Chain Monitoring (Phase 12A) ---

export enum AlertSeverity {
  WARNING = 'WARNING',
  CRITICAL = 'CRITICAL',
  EMERGENCY = 'EMERGENCY',
}

// GET /temperature-alerts, PATCH /temperature-alerts/:id/resolve -
// TemperatureAlertResponseEntity declares exactly the scalar Prisma
// TemperatureAlert fields, no drift here.
export interface TemperatureAlert {
  id: string;
  readingId: string;
  lotId: string;
  severity: AlertSeverity;
  actualC: string;
  resolved: boolean;
  resolvedAt: string | null;
  createdAt: string;
}

export enum DeviceStatus {
  ACTIVE = 'ACTIVE',
  OFFLINE = 'OFFLINE',
  DECOMMISSIONED = 'DECOMMISSIONED',
}

// GET /temperature-devices, PATCH /temperature-devices/:id/calibrate -
// TemperatureDeviceResponseEntity declares exactly the scalar Prisma
// TemperatureDevice fields plus two computed-on-read booleans (isOffline,
// isCalibrationOverdue), no drift here.
export interface TemperatureDevice {
  id: string;
  vendorId: string;
  deviceCode: string;
  status: DeviceStatus;
  lastSeenAt: string | null;
  isOffline: boolean;
  lastCalibratedAt: string | null;
  calibrationDueAt: string | null;
  isCalibrationOverdue: boolean;
  createdAt: string;
}

export enum EmergencyResponseStatus {
  OPEN = 'OPEN',
  ACKNOWLEDGED = 'ACKNOWLEDGED',
  CONTAINED = 'CONTAINED',
  RESOLVED = 'RESOLVED',
}

// GET /food-safety/emergency-responses, PATCH .../acknowledge,
// PATCH .../status - EmergencyResponseResponseEntity declares exactly the
// scalar Prisma EmergencyResponse fields, no drift here.
export interface EmergencyResponse {
  id: string;
  alertId: string;
  assignedToId: string | null;
  status: EmergencyResponseStatus;
  actionsTaken: string | null;
  rootCause: string | null;
  correctiveAction: string | null;
  preventiveAction: string | null;
  acknowledgedAt: string | null;
  resolvedAt: string | null;
  createdAt: string;
}

// Linear, no skipping - matches EmergencyResponsesService's
// ALLOWED_STATUS_TRANSITIONS. An EMERGENCY can't be closed out without
// first being acknowledged and contained.
export const EMERGENCY_RESPONSE_NEXT_STATUS: Record<EmergencyResponseStatus, EmergencyResponseStatus | null> = {
  [EmergencyResponseStatus.OPEN]: EmergencyResponseStatus.ACKNOWLEDGED,
  [EmergencyResponseStatus.ACKNOWLEDGED]: EmergencyResponseStatus.CONTAINED,
  [EmergencyResponseStatus.CONTAINED]: EmergencyResponseStatus.RESOLVED,
  [EmergencyResponseStatus.RESOLVED]: null,
};

export enum FoodSafetyStatus {
  SAFE = 'SAFE',
  UNDER_REVIEW = 'UNDER_REVIEW',
  SAFETY_HOLD = 'SAFETY_HOLD',
  QUARANTINED = 'QUARANTINED',
  RECALLED = 'RECALLED',
  REJECTED = 'REJECTED',
}

export enum WeightUnit {
  POUNDS = 'POUNDS',
  KILOGRAMS = 'KILOGRAMS',
}

// GET /seafood-lots, PATCH /seafood-lots/:id/status -
// SeafoodLotResponseEntity declares exactly the scalar Prisma SeafoodLot
// fields plus a computed retentionExpiresAt, no drift here.
export interface SeafoodLotAdmin {
  id: string;
  lotNumber: string;
  vendorId: string;
  species: string;
  storageType: SeafoodStorageType;
  catchDate: string;
  catchLocation: string | null;
  landingSite: string | null;
  weight: string;
  weightUnit: WeightUnit;
  freshnessGrade: FreshnessGrade | null;
  qualityScore: number | null;
  foodSafetyStatus: FoodSafetyStatus;
  statusNotes: string | null;
  createdAt: string;
  retentionExpiresAt: string;
}

// PATCH /seafood-lots/:id/status only accepts this subset - RECALLED is
// deliberately excluded (a lot only ever becomes RECALLED through the
// Recall workflow, never this direct override endpoint).
export const ASSIGNABLE_LOT_STATUSES = [
  FoodSafetyStatus.SAFE,
  FoodSafetyStatus.UNDER_REVIEW,
  FoodSafetyStatus.SAFETY_HOLD,
  FoodSafetyStatus.QUARANTINED,
  FoodSafetyStatus.REJECTED,
] as const;

export type AssignableLotStatus = (typeof ASSIGNABLE_LOT_STATUSES)[number];

// --- Recall Management (Phase 12A) ---

export enum RecallSeverityClass {
  CLASS_I = 'CLASS_I',
  CLASS_II = 'CLASS_II',
  CLASS_III = 'CLASS_III',
}

export enum RecallStatus {
  DRAFT = 'DRAFT',
  ACTIVE = 'ACTIVE',
  INVESTIGATING = 'INVESTIGATING',
  RESOLVED = 'RESOLVED',
  CLOSED = 'CLOSED',
}

// GET/POST /recalls, PATCH /recalls/:id/status - RecallResponseEntity
// declares exactly the scalar Prisma Recall fields plus lotIds (derived
// from the RecallLot join table) and a computed retentionExpiresAt, no
// drift here.
export interface Recall {
  id: string;
  severityClass: RecallSeverityClass;
  status: RecallStatus;
  reason: string;
  rootCause: string | null;
  resolutionNotes: string | null;
  createdById: string;
  lotIds: string[];
  closedAt: string | null;
  createdAt: string;
  retentionExpiresAt: string;
}

// Strictly linear per backend/src/modules/food-safety/services/recalls.service.ts's
// ALLOWED_STATUS_TRANSITIONS - null means no further transition is possible.
export const RECALL_NEXT_STATUS: Record<RecallStatus, RecallStatus | null> = {
  [RecallStatus.DRAFT]: RecallStatus.ACTIVE,
  [RecallStatus.ACTIVE]: RecallStatus.INVESTIGATING,
  [RecallStatus.INVESTIGATING]: RecallStatus.RESOLVED,
  [RecallStatus.RESOLVED]: RecallStatus.CLOSED,
  [RecallStatus.CLOSED]: null,
};

// GET /recalls/:id/affected-orders - AffectedOrderEntity declares exactly
// these fields, no drift here.
export interface AffectedOrder {
  orderId: string;
  vendorOrderId: string;
  customerId: string;
  customerEmail: string;
  productId: string;
  productName: string;
  quantity: number;
  lotId: string;
}

// GET /food-safety/audit-logs?entityType=Recall&entityId=:id -
// AuditLogResponseEntity declares exactly the scalar Prisma
// ComplianceAuditLog fields, no drift here. entityType is a free-text
// string on the backend (not an enum), and Recall status transitions are
// logged with the exact literal "Recall" (PascalCase) - see
// RecallsService.updateStatus. This is the only entity with real
// audit-log coverage today; vendor/driver status changes have none.
export interface ComplianceAuditLogEntry {
  id: string;
  userId: string;
  action: string;
  entityType: string;
  entityId: string;
  beforeValue: unknown;
  afterValue: unknown;
  ipAddress: string | null;
  reason: string | null;
  createdAt: string;
}

// --- Delivery Operations Center (Phase 10B) ---

export enum DeliveryRunStatus {
  PLANNED = 'PLANNED',
  IN_PROGRESS = 'IN_PROGRESS',
  COMPLETED = 'COMPLETED',
  CANCELLED = 'CANCELLED',
}

export interface DeliveryRunStop {
  id: string;
  deliveryId: string;
  sequence: number;
}

// GET/PATCH /delivery-runs - DeliveryRunResponseEntity declares exactly
// these fields, no drift here.
export interface DeliveryRun {
  id: string;
  zoneId: string;
  driverId: string | null;
  fleetAssetId: string | null;
  status: DeliveryRunStatus;
  stops: DeliveryRunStop[];
  createdAt: string;
  updatedAt: string;
}

// POST /delivery-runs/:id/dispatch (10A Fleet Dispatch Engine) - runs the
// scoring algorithm and calls PATCH .../assign internally; the frontend
// only needs to know it succeeded (the run comes back IN_PROGRESS) or
// failed with a 409 (no eligible driver/asset - see ConflictException in
// DispatchService).
export type DispatchRunResult = DeliveryRun;

// GET /delivery/exceptions - enriched with vendor/customer/driver context
// per DeliveryExceptionWithContextEntity (Phase 12B.0 finding: the plain
// exception list under-fetched for a dispatcher screen).
export interface DeliveryExceptionWithContext {
  id: string;
  deliveryId: string;
  vendorOrderId: string;
  type: DeliveryExceptionType;
  reason: string;
  photos: string[];
  notes: string | null;
  resolved: boolean;
  resolvedAt: string | null;
  resolvedById: string | null;
  vendorBusinessName: string;
  customerName: string;
  deliveryAddressLine1: string;
  deliveryParish: Parish;
  driverName: string;
  createdAt: string;
}

export enum DeliveryExceptionType {
  CUSTOMER_UNAVAILABLE = 'CUSTOMER_UNAVAILABLE',
  ADDRESS_ISSUE = 'ADDRESS_ISSUE',
  VEHICLE_BREAKDOWN = 'VEHICLE_BREAKDOWN',
  TRAFFIC_DELAY = 'TRAFFIC_DELAY',
  WEATHER_DELAY = 'WEATHER_DELAY',
  PRODUCT_DAMAGE = 'PRODUCT_DAMAGE',
  OTHER = 'OTHER',
}

// --- Review Moderation (Phase 13E, admin dashboard) ---
// Hand-mirrored from backend AdminReviewEntity / AdminReviewDetailEntity /
// ReviewAuditLogEntity / ComplianceScoreExplanationEntity.

export interface AdminReview {
  id: string;
  authorId: string | null;
  authorDisplayName: string;
  vendorId: string;
  productId: string | null;
  productName: string | null;
  vendorOrderId: string;
  rating: number;
  title: string | null;
  body: string;
  moderationStatus: ReviewModerationStatus;
  removedById: string | null;
  removalReason: string | null;
  removedAt: string | null;
  deliveryWasRejected: boolean;
  editedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ReviewAuditLogEntry {
  id: string;
  reviewId: string;
  actorId: string;
  action: string;
  beforeValue: unknown;
  afterValue: unknown;
  reason: string | null;
  createdAt: string;
}

export interface AdminReviewDetail extends AdminReview {
  auditLogs: ReviewAuditLogEntry[];
}

export interface ComplianceScoreBreakdown {
  score: number;
  temperatureDeduction: number;
  inspectionDeduction: number;
  recallDeduction: number;
  certificationDeduction: number;
}

export interface ComplianceScoreExplanation {
  vendorId: string;
  score: number | null;
  band: ComplianceBand;
  updatedAt: string | null;
  breakdown: ComplianceScoreBreakdown;
}

// --- Authentication ---

// Hand-mirrored from the backend authentication response entities and role
// model. Dates crossing the HTTP boundary are represented as ISO strings.
export enum UserRole {
  CUSTOMER = 'CUSTOMER',
  VENDOR = 'VENDOR',
  DRIVER = 'DRIVER',
  FISHERMAN = 'FISHERMAN',
  ADMINISTRATOR = 'ADMINISTRATOR',
  OPERATIONS_STAFF = 'OPERATIONS_STAFF',
}

export enum UserStatus {
  PENDING_VERIFICATION = 'PENDING_VERIFICATION',
  ACTIVE = 'ACTIVE',
  SUSPENDED = 'SUSPENDED',
  DEACTIVATED = 'DEACTIVATED',
}

export type SelfRegisterableRole =
  | UserRole.CUSTOMER
  | UserRole.VENDOR
  | UserRole.DRIVER
  | UserRole.FISHERMAN;

export interface AuthUser {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  phone: string | null;
  status: UserStatus;
  roles: UserRole[];
  canAuthorizeVendorSettlements?: boolean;
  createdAt: string;
}

export interface AuthTokensResponse {
  accessToken: string;
  refreshToken: string;
  user: AuthUser;
}

export interface LoginRequest {
  email: string;
  password: string;
}

export interface RegisterRequest {
  email: string;
  password: string;
  confirmPassword: string;
  firstName: string;
  lastName: string;
  phone?: string;
  role?: SelfRegisterableRole;
}

// --- Daily Listings & Available-Today Marketplace (Phase 16B & 16C) ---

export enum ListingLifecycleStatus {
  DRAFT = 'DRAFT',
  PUBLISHED = 'PUBLISHED',
  WITHDRAWN = 'WITHDRAWN',
  SUSPENDED = 'SUSPENDED',
}

export enum ListingPhotoModerationStatus {
  PENDING = 'PENDING',
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
}

export interface PreparationOption {
  id: string;
  name: string;
  description?: string;
  pricePerUnit: number;
}

export interface DailyListingPhotoResponse {
  id: string;
  vendorDailyListingId: string;
  url: string;
  caption: string | null;
  isPrimary: boolean;
  moderationStatus: ListingPhotoModerationStatus;
  uploadedAt: string;
  captureDate: string | null;
  withdrawnAt: string | null;
  withdrawnReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DailyListingSpeciesResponse {
  id: string;
  vendorDailyListingId: string;
  speciesId: string;
  proportion: number | null;
  notes: string | null;
  scientificName?: string;
  commercialName?: string;
  createdAt: string;
}

export interface DailyListingResponse {
  id: string;
  vendorId: string;
  productId: string;
  catalogueItemId: string;
  lotId: string;
  landingSiteId: string | null;
  listingTitle: string | null;
  description: string | null;
  catchDate: string;
  availableFrom: string;
  expiresAt: string;
  unit: ProductUnit;
  price: number;
  currency: string;
  quantityUploaded: number;
  quantityAvailable: number;
  quantityReserved: number;
  quantitySold: number;
  preparationOptions?: PreparationOption[] | null;
  deliveryAvailable: boolean;
  pickupAvailable: boolean;
  status: ListingLifecycleStatus;
  derivedStatus: string;
  publishedAt: string | null;
  withdrawnAt: string | null;
  withdrawnReason: string | null;
  suspendedAt: string | null;
  suspensionReason: string | null;
  createdAt: string;
  updatedAt: string;
  primaryPhoto: DailyListingPhotoResponse | null;
  photos: DailyListingPhotoResponse[];
  speciesDeclarations: DailyListingSpeciesResponse[];
  vendor?: {
    id: string;
    businessName: string;
    tier: string;
    parish?: string;
  };
  catalogueItem?: {
    id: string;
    name: string;
    commonName: string;
    categoryId: string;
    compositionMode: string;
    referenceImageUrl?: string | null;
  };
  lot?: {
    id: string;
    lotNumber: string;
    publicTraceToken: string;
    freshnessGrade?: string | null;
    foodSafetyStatus: string;
    originType?: string | null;
    acquisitionType?: string | null;
  };
  landingSite?: {
    id: string;
    name: string;
    parish: string;
  } | null;
}

export interface PaginatedDailyListings {
  items: DailyListingResponse[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export interface AvailableTodayItem {
  catalogueItemId: string;
  name: string;
  commonName: string;
  scientificName: string;
  categoryId: string;
  categoryName: string;
  referenceImageUrl: string | null;
  totalQuantityAvailable: number;
  unit: ProductUnit;
  sellerCount: number;
  minPrice: number;
  maxPrice: number;
  currency: string;
  earliestCatchDate: string;
  activeListingsCount: number;
  hasPreparationOptions: boolean;
  deliveryAvailable: boolean;
  pickupAvailable: boolean;
  parishes: string[];
  listingsPreview: DailyListingResponse[];
}

export interface PaginatedAvailableToday {
  items: AvailableTodayItem[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export interface QueryDailyListings {
  vendorId?: string;
  catalogueItemId?: string;
  categoryId?: string;
  speciesId?: string;
  landingSiteId?: string;
  parish?: Parish;
  minPrice?: number;
  maxPrice?: number;
  unit?: ProductUnit;
  hasPreparationOptions?: boolean;
  deliveryAvailable?: boolean;
  pickupAvailable?: boolean;
  status?: ListingLifecycleStatus;
  activeOnly?: boolean;
  search?: string;
  page?: number;
  pageSize?: number;
}

export type CatalogueCompositionMode =
  | 'SINGLE_SPECIES'
  | 'FIXED_COMPOSITE'
  | 'VARIABLE_COMPOSITE'
  | 'UNVERIFIED_COMPOSITION';

export interface SeafoodCatalogueItem {
  id: string;
  name: string;
  scientificName: string | null;
  commonName: string;
  jamaicanNames: string[];
  description: string | null;
  categoryId: string;
  categoryName?: string;
  compositionMode: CatalogueCompositionMode;
  lifecycleStatus: string;
  referenceImageUrl: string | null;
  typicalUnit: ProductUnit;
}

export interface PaginatedCatalogueItems {
  data: SeafoodCatalogueItem[];
  meta: {
    total: number;
    page: number;
    limit: number;
  };
}

export interface LandingSite {
  id: string;
  name: string;
  parish: Parish;
  status: string;
  inspectionStatus: string;
}

export interface ManagedSpecies {
  id: string;
  scientificName: string;
  commercialName: string;
  regulatoryStatus: string;
}

export interface VendorComplianceStatus {
  tier: VendorTier;
  canSell: boolean;
  requiredDocuments: Array<{
    type: string;
    status: string;
  }>;
}

export interface RegulatoryEvaluationResult {
  eligible: boolean;
  reasons: string[];
  evaluatedAt: string;
  mode: 'ENFORCING' | 'DEGRADED_FAIL_CLOSED';
}

export interface DeclareListingSpeciesInput {
  speciesId: string;
  proportion?: number;
  notes?: string;
}

export interface CreateDailyListingInput {
  catalogueItemId: string;
  lotId: string;
  landingSiteId?: string;
  listingTitle?: string;
  description?: string;
  catchDate: string;
  availableFrom?: string;
  expiresAt: string;
  unit: ProductUnit;
  price: number;
  currency?: string;
  quantityUploaded: number;
  deliveryAvailable?: boolean;
  pickupAvailable?: boolean;
  speciesDeclarations?: DeclareListingSpeciesInput[];
}

export interface UpdateDailyListingInput {
  listingTitle?: string;
  description?: string;
  expiresAt?: string;
  price?: number;
  quantityUploaded?: number;
  deliveryAvailable?: boolean;
  pickupAvailable?: boolean;
  speciesDeclarations?: DeclareListingSpeciesInput[];
}

export interface AddListingPhotoInput {
  url: string;
  caption?: string;
  isPrimary?: boolean;
  captureDate?: string;
}

// --- Driver Delivery Operations ---
// Hand-mirrored from backend/src/modules/delivery/entities and dto contracts.

export enum ProofOfDeliveryType {
  SIGNATURE = 'SIGNATURE',
  PHOTO = 'PHOTO',
}

export enum CustomerAcceptanceStatus {
  PENDING = 'PENDING',
  ACCEPTED = 'ACCEPTED',
  REJECTED = 'REJECTED',
}

export type DeliveryStage = 'ASSIGNED' | 'PICKED_UP' | 'DELIVERED' | 'FAILED';

export type DeliveryStatusAction = 'PICKED_UP' | 'DELIVERED' | 'FAILED';

export type DriverAvailabilityTarget = 'ONLINE' | 'OFFLINE';

export type DriverProfile = DriverAdmin;

export interface DeliveryItemSummary {
  productName: string;
  unit: ProductUnit;
  quantity: number;
}

export interface AvailableDelivery {
  vendorOrderId: string;
  pickupVendorName: string;
  pickupParish: Parish;
  items: DeliveryItemSummary[];
  readyForPickupAt: string;
}

export interface PaginatedAvailableDeliveries {
  items: AvailableDelivery[];
  total: number;
  page: number;
  pageSize: number;
}

export interface DeliveryExceptionSummary {
  id: string;
  deliveryId: string;
  type: DeliveryExceptionType;
  reason: string;
  photos: string[];
  notes: string | null;
  resolved: boolean;
  resolvedAt: string | null;
  resolvedById: string | null;
  createdAt: string;
}

export interface DeliveryRouteHistorySummary {
  id: string;
  deliveryId: string;
  driverId: string;
  gpsSamples: number;
  distanceKm: string;
  durationMinutes: number;
  createdAt: string;
}

export interface DriverDelivery {
  id: string;
  vendorOrderId: string;
  driverId: string;
  stage: DeliveryStage;
  pickupVendorName: string;
  pickupParish: Parish;
  items: DeliveryItemSummary[];
  deliveryAddressLine1: string;
  deliveryAddressLine2: string | null;
  deliveryParish: Parish;
  deliveryPhone: string;
  scheduledPickupWindowStart: string | null;
  scheduledPickupWindowEnd: string | null;
  customerDeliveryWindowStart: string | null;
  customerDeliveryWindowEnd: string | null;
  vendorConfirmedAt: string | null;
  vendorConfirmedById: string | null;
  customerAcceptanceStatus: CustomerAcceptanceStatus;
  customerAcceptedAt: string | null;
  customerRejectedAt: string | null;
  rejectionReason: string | null;
  assignedAt: string;
  pickedUpAt: string | null;
  deliveredAt: string | null;
  failedAt: string | null;
  failureReason: string | null;
  proofType: ProofOfDeliveryType | null;
  proofUrl: string | null;
  exceptions: DeliveryExceptionSummary[];
  routeHistory: DeliveryRouteHistorySummary | null;
}

export interface PaginatedDriverDeliveries {
  items: DriverDelivery[];
  total: number;
  page: number;
  pageSize: number;
}

export interface UpdateDeliveryScheduleInput {
  scheduledPickupWindowStart?: string;
  scheduledPickupWindowEnd?: string;
  customerDeliveryWindowStart?: string;
  customerDeliveryWindowEnd?: string;
}

export interface UpdateDeliveryStatusInput {
  action: DeliveryStatusAction;
  proofType?: ProofOfDeliveryType;
  proofUrl?: string;
  failureReason?: string;
}

// --- Live Vehicle GPS & Cold-Chain Cargo-Air Telemetry (Teltonika FMC130 + EYE BTSMP1) ---

export enum TelemetryProtocol {
  TELTONIKA_CODEC_8E = 'TELTONIKA_CODEC_8E',
  TELTONIKA_CODEC_JSON = 'TELTONIKA_CODEC_JSON',
  HTTP_JSON = 'HTTP_JSON',
  EYE_APP_CSV = 'EYE_APP_CSV',
}

export enum TemperatureReadingOrigin {
  MANUAL_PRODUCT_CHECK = 'MANUAL_PRODUCT_CHECK',
  CARGO_AIR_SENSOR = 'CARGO_AIR_SENSOR',
  EYE_APP_RECOVERY_CSV = 'EYE_APP_RECOVERY_CSV',
}

export enum TelemetryGapKind {
  LTE_BUFFERED_RECOVERY = 'LTE_BUFFERED_RECOVERY',
  SENSOR_SIGNAL_MISSING = 'SENSOR_SIGNAL_MISSING',
  GNSS_NO_FIX = 'GNSS_NO_FIX',
}

export type TelemetryReportingStatus =
  | 'REPORTING'
  | 'DELAYED'
  | 'SENSOR_SIGNAL_MISSING'
  | 'STALE'
  | 'OFFLINE'
  | 'DECOMMISSIONED';

export type VehicleGpsStatus = 'LIVE' | 'DELAYED' | 'NO_FIX' | 'STALE' | 'OFFLINE';

export interface LiveVehicleSensorSnapshot {
  id: string;
  deviceCode: string;
  lastTemperatureC: number | null;
  lastCapturedAt: string | null;
  lastDelaySeconds: number | null;
  reportingStatus: TelemetryReportingStatus;
}

export interface LiveVehicleCompartmentSnapshot {
  id: string;
  compartmentCode: string;
  label: string;
  storageType: string;
  sensors: LiveVehicleSensorSnapshot[];
}

export interface LiveVehicleOverview {
  fleetAssetId: string;
  licensePlate: string;
  assetType: string;
  gpsStatus: VehicleGpsStatus;
  lastLatitude: number | null;
  lastLongitude: number | null;
  lastSpeedKph: number | null;
  lastHeadingDeg: number | null;
  lastSatellites: number | null;
  lastGpsCapturedAt: string | null;
  lastTelemetryReceivedAt: string | null;
  lastTelemetryDelayed: boolean;
  trackerImei: string | null;
  compartments: LiveVehicleCompartmentSnapshot[];
}

export interface LiveRunStopSummary {
  id: string;
  sequence: number;
  deliveryId: string;
  deliveryStatus: string;
  deliveryAddress: string | null;
  openLotCount: number;
}

export interface LiveRunOverviewItem {
  id: string;
  zoneId: string;
  zoneName: string;
  status: DeliveryRunStatus;
  driverName: string | null;
  fleetAssetId: string | null;
  vehicle: LiveVehicleOverview | null;
  stops: LiveRunStopSummary[];
  createdAt: string;
}

export interface ActiveDeliveryLiveRow {
  deliveryId: string;
  vendorOrderId: string;
  vendorName: string;
  status: string;
  deliveryAddress: string | null;
  runId: string | null;
  stopSequence: number | null;
  driverName: string | null;
  fleetAssetId: string | null;
  licensePlate: string | null;
  gpsStatus: VehicleGpsStatus;
  lastLatitude: number | null;
  lastLongitude: number | null;
  lastGpsCapturedAt: string | null;
  lastTelemetryDelayed: boolean;
  onboardLotCount: number;
  latestCargoTempC: number | null;
  sensorReportingStatus: TelemetryReportingStatus | null;
}

export interface ActiveRunsLiveOverview {
  generatedAt: string;
  vehicles: LiveVehicleOverview[];
  runs: LiveRunOverviewItem[];
  activeDeliveries: ActiveDeliveryLiveRow[];
}

export interface EnrolledTrackerSummary {
  id: string;
  imei: string;
  hardwareModel: string;
  firmwareVersion: string | null;
  simCarrier: string | null;
  protocol: TelemetryProtocol;
  status: DeviceStatus;
  fleetAssetId: string;
  licensePlate: string;
  gpsStatus: VehicleGpsStatus;
  lastCapturedAt: string | null;
  lastReceivedAt: string | null;
  activeCredentialCount: number;
}

export interface EnrolledSensorSummary {
  id: string;
  deviceCode: string;
  hardwareModel: string;
  bleMacAddress: string | null;
  sensorSlot: number | null;
  firmwareVersion: string | null;
  status: DeviceStatus;
  vendorId: string | null;
  vendorName: string | null;
  compartmentId: string | null;
  compartmentCode: string | null;
  compartmentLabel: string | null;
  storageType: string | null;
  fleetAssetId: string | null;
  licensePlate: string | null;
  lastTemperatureC: number | null;
  lastCapturedAt: string | null;
  lastReceivedAt: string | null;
  lastDelaySeconds: number | null;
  lastHumidityPct: number | null;
  lastBatteryMv: number | null;
  lastDoorOpen: boolean | null;
  lastMovement: boolean | null;
  lastGapKind: TelemetryGapKind | null;
  lastSignalMissingAt: string | null;
  reportingStatus: TelemetryReportingStatus;
}

export interface TelemetryDevicesOverview {
  generatedAt: string;
  trackers: EnrolledTrackerSummary[];
  sensors: EnrolledSensorSummary[];
}

export interface SensorTelemetryFrameRow {
  id: string;
  protocol: TelemetryProtocol;
  origin: TemperatureReadingOrigin;
  capturedAt: string;
  receivedAt: string;
  delaySeconds: number;
  isDelayed: boolean;
  cargoTempC: number | null;
  humidityPct: number | null;
  doorOpen: boolean | null;
  movement: boolean | null;
  batteryMv: number | null;
  latitude: number | null;
  longitude: number | null;
  gnssValid: boolean;
  gapKind: TelemetryGapKind | null;
  linkedLotsCount: number;
  alertsCount: number;
}

export interface SensorTelemetryHistory {
  sensor: {
    id: string;
    deviceCode: string;
    hardwareModel: string;
    bleMacAddress: string | null;
    sensorSlot: number | null;
    fleetAssetId: string | null;
    licensePlate: string | null;
    compartmentCode: string | null;
    compartmentLabel: string | null;
    lastTemperatureC: number | null;
    lastCapturedAt: string | null;
    lastReceivedAt: string | null;
    lastDelaySeconds: number | null;
    reportingStatus: TelemetryReportingStatus;
  };
  frames: SensorTelemetryFrameRow[];
}

export interface EyeCsvImportSummary {
  sensorId: string;
  deviceCode: string;
  totalRows: number;
  importedFrames: number;
  deduplicatedFrames: number;
  lotReadingsCreated: number;
  alertsCreated: number;
}

export interface DeliveryCargoAssignmentView {
  id: string;
  lotId: string;
  lotNumber: string;
  species: string;
  storageType: string;
  foodSafetyStatus: string;
  compartmentId: string;
  compartmentCode: string;
  compartmentLabel: string;
  trackerImei: string | null;
  sensorId: string | null;
  sensorDeviceCode: string | null;
  sensorReportingStatus: TelemetryReportingStatus | null;
  sensorLastTempC: number | null;
  quantityUnits: number;
  handedOverQuantity: number;
  loadedAt: string;
  unloadedAt: string | null;
  pickupCustodyEventId: string | null;
  handoverCustodyEventId: string | null;
}

export interface DeliveryTelemetryDetail {
  delivery: {
    id: string;
    vendorOrderId: string;
    status: string;
    deliveryAddress: string | null;
    assignedAt: string;
    pickedUpAt: string | null;
    deliveredAt: string | null;
    vendorName: string;
    driverName: string | null;
  };
  vehicle: {
    id: string;
    licensePlate: string;
    assetType: string;
    gpsStatus: VehicleGpsStatus;
    lastLatitude: number | null;
    lastLongitude: number | null;
    lastSpeedKph: number | null;
    lastHeadingDeg: number | null;
    lastSatellites: number | null;
    lastGpsCapturedAt: string | null;
    lastTelemetryReceivedAt: string | null;
    lastTelemetryDelayed: boolean;
  } | null;
  assignments: DeliveryCargoAssignmentView[];
  manualProductChecks: Array<{
    id: string;
    lotId: string;
    lotNumber: string;
    checkpoint: string;
    temperatureC: string;
    origin: TemperatureReadingOrigin;
    capturedAt: string;
    receivedAt: string;
    recordedAt: string;
    photoUrl: string | null;
  }>;
  cargoAirReadings: Array<{
    id: string;
    lotId: string;
    lotNumber: string;
    deviceId: string | null;
    deviceCode: string | null;
    checkpoint: string;
    temperatureC: string;
    origin: TemperatureReadingOrigin;
    capturedAt: string;
    receivedAt: string;
    isDelayed: boolean;
    latitude: number | null;
    longitude: number | null;
  }>;
  complianceChecklist: {
    pickupManualCheckRecorded: boolean;
    deliveryManualCheckRecorded: boolean;
    continuousSensorActive: boolean;
    manualChecksDistinctNotice: string;
  };
  alerts: Array<{
    id: string;
    lotId: string;
    severity: AlertSeverity;
    actualC: string;
    resolved: boolean;
    createdAt: string;
    readingOrigin: TemperatureReadingOrigin;
    readingCapturedAt: string | null;
    isDelayed: boolean;
    emergencyResponse: {
      id: string;
      status: EmergencyResponseStatus;
      acknowledgedAt: string | null;
      resolvedAt: string | null;
    } | null;
  }>;
  telemetryGaps: Array<{
    frameId: string;
    gapKind: TelemetryGapKind;
    capturedAt: string;
    receivedAt: string;
    delaySeconds: number;
    latitude: number | null;
    longitude: number | null;
  }>;
  gpsTrail: Array<{
    latitude: number;
    longitude: number;
    speedKph: number | null;
    capturedAt: string;
    isDelayed: boolean;
  }>;
}

