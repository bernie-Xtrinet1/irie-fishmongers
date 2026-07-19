import type {
  DashboardSummary,
  DeliveryAnalytics,
  InventoryAnalytics,
  SalesAnalytics,
  VendorDashboard,
} from '@iriefishmongers/types';

import { apiGet } from '@/lib/api-client';

export interface DashboardSummaryRange {
  from?: string;
  to?: string;
}

export async function fetchDashboardSummary(range?: DashboardSummaryRange): Promise<DashboardSummary> {
  if (!range?.from && !range?.to) {
    return apiGet<DashboardSummary>('/analytics/dashboard-summary');
  }

  const params = new URLSearchParams();
  if (range.from) params.set('from', range.from);
  if (range.to) params.set('to', range.to);
  return apiGet<DashboardSummary>(`/analytics/dashboard-summary?${params.toString()}`);
}

export async function fetchVendorDashboard(range?: DashboardSummaryRange): Promise<VendorDashboard> {
  if (!range?.from && !range?.to) {
    return apiGet<VendorDashboard>('/analytics/vendor-dashboard');
  }

  const params = new URLSearchParams();
  if (range.from) params.set('from', range.from);
  if (range.to) params.set('to', range.to);
  return apiGet<VendorDashboard>(`/analytics/vendor-dashboard?${params.toString()}`);
}

export async function fetchSalesAnalytics(range?: DashboardSummaryRange): Promise<SalesAnalytics> {
  if (!range?.from && !range?.to) {
    return apiGet<SalesAnalytics>('/analytics/sales-analytics');
  }

  const params = new URLSearchParams();
  if (range.from) params.set('from', range.from);
  if (range.to) params.set('to', range.to);
  return apiGet<SalesAnalytics>(`/analytics/sales-analytics?${params.toString()}`);
}

export async function fetchDeliveryAnalytics(range?: DashboardSummaryRange): Promise<DeliveryAnalytics> {
  if (!range?.from && !range?.to) {
    return apiGet<DeliveryAnalytics>('/analytics/delivery-analytics');
  }

  const params = new URLSearchParams();
  if (range.from) params.set('from', range.from);
  if (range.to) params.set('to', range.to);
  return apiGet<DeliveryAnalytics>(`/analytics/delivery-analytics?${params.toString()}`);
}

export async function fetchInventoryAnalytics(range?: DashboardSummaryRange): Promise<InventoryAnalytics> {
  if (!range?.from && !range?.to) {
    return apiGet<InventoryAnalytics>('/analytics/inventory-analytics');
  }

  const params = new URLSearchParams();
  if (range.from) params.set('from', range.from);
  if (range.to) params.set('to', range.to);
  return apiGet<InventoryAnalytics>(`/analytics/inventory-analytics?${params.toString()}`);
}
