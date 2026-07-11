import { apiGet } from '@/lib/api-client';

// Hand-mirrored from backend/src/modules/analytics/entities/dashboard-summary.entity.ts
// (verified against that source directly) - moves to packages/types once a
// shared admin-entities package is introduced (Phase 12A, section 3 review
// note).
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

export interface DashboardSummaryRange {
  from?: string;
  to?: string;
}

// All-time (no range) requests are coalesced into a single in-flight
// promise - the topbar's connectivity indicator and every overview widget
// call this same function with their own React Query queryKey/staleTime/
// refetchInterval (see lib/hooks/use-dashboard-summary.ts) so they can each
// decide how fresh they need to be, without each one triggering its own
// network round trip when several fire close together.
let inFlight: Promise<DashboardSummary> | null = null;

export async function fetchDashboardSummary(range?: DashboardSummaryRange): Promise<DashboardSummary> {
  if (range?.from || range?.to) {
    const params = new URLSearchParams();
    if (range.from) params.set('from', range.from);
    if (range.to) params.set('to', range.to);
    return apiGet<DashboardSummary>(`/analytics/dashboard-summary?${params.toString()}`);
  }

  if (!inFlight) {
    inFlight = apiGet<DashboardSummary>('/analytics/dashboard-summary').finally(() => {
      inFlight = null;
    });
  }

  return inFlight;
}
