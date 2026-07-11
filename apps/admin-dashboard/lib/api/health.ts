import type { DashboardSystemHealth } from '@iriefishmongers/types';

import { apiGet } from '@/lib/api-client';

// GET /health/status - the admin-gated, always-200 counterpart to the
// public GET /health infra readiness probe (which throws 503 on any
// outage). Deliberately separate from /analytics/dashboard-summary so
// frequent connectivity polling never re-runs the business-KPI
// aggregation.
export async function fetchHealthStatus(): Promise<DashboardSystemHealth> {
  return apiGet<DashboardSystemHealth>('/health/status');
}
