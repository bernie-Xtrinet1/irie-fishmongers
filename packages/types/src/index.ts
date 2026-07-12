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
  logoUrl: string | null;
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
  foodSafetyStatus: VendorComplianceStatusLabel;
  traceabilityStatus: VendorComplianceStatusLabel;
  ordersCompleted: number;
  rating: number | null;
  coldChainScore: number | null;
  recentReviews: [];
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
  financials: DashboardFinancials;
  orders: DashboardOrderCounts;
  vendors: DashboardVendorCounts;
  drivers: DashboardDriverCounts;
  compliance: DashboardComplianceSummary;
  systemHealth: DashboardSystemHealth;
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
