import type { DashboardSummary } from '@iriefishmongers/types';

import { apiGet } from '@/lib/api-client';

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
