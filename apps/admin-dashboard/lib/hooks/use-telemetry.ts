import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from '@tanstack/react-query';
import type {
  ActiveRunsLiveOverview,
  DeliveryTelemetryDetail,
  EyeCsvImportSummary,
  SensorTelemetryHistory,
  TelemetryDevicesOverview,
} from '@iriefishmongers/types';

import {
  fetchActiveRunsLiveOverview,
  fetchDeliveryTelemetryDetail,
  fetchSensorTelemetryHistory,
  fetchTelemetryDevicesOverview,
  uploadEyeAppCsvRecovery,
} from '@/lib/api/telemetry';
import { DASHBOARD_SUMMARY_QUERY_KEY } from '@/lib/hooks/use-dashboard-summary';

export const ACTIVE_RUNS_LIVE_QUERY_KEY = 'telemetry-active-runs-live';
export const TELEMETRY_DEVICES_OVERVIEW_QUERY_KEY = 'telemetry-devices-overview';
export const SENSOR_TELEMETRY_HISTORY_QUERY_KEY = 'sensor-telemetry-history';
export const DELIVERY_TELEMETRY_DETAIL_QUERY_KEY = 'delivery-telemetry-detail';

export function useActiveRunsLiveOverview(): UseQueryResult<ActiveRunsLiveOverview> {
  return useQuery({
    queryKey: [ACTIVE_RUNS_LIVE_QUERY_KEY],
    queryFn: fetchActiveRunsLiveOverview,
    refetchInterval: 30_000,
  });
}

export function useTelemetryDevicesOverview(): UseQueryResult<TelemetryDevicesOverview> {
  return useQuery({
    queryKey: [TELEMETRY_DEVICES_OVERVIEW_QUERY_KEY],
    queryFn: fetchTelemetryDevicesOverview,
    refetchInterval: 30_000,
  });
}

export function useSensorTelemetryHistory(
  sensorId: string | null,
  params: { hours?: number; limit?: number } = { hours: 24, limit: 100 },
): UseQueryResult<SensorTelemetryHistory> {
  return useQuery({
    queryKey: [SENSOR_TELEMETRY_HISTORY_QUERY_KEY, sensorId, params],
    queryFn: () => fetchSensorTelemetryHistory(sensorId!, params),
    enabled: Boolean(sensorId),
  });
}

export function useDeliveryTelemetryDetail(
  deliveryId: string | null,
): UseQueryResult<DeliveryTelemetryDetail> {
  return useQuery({
    queryKey: [DELIVERY_TELEMETRY_DETAIL_QUERY_KEY, deliveryId],
    queryFn: () => fetchDeliveryTelemetryDetail(deliveryId!),
    enabled: Boolean(deliveryId),
    refetchInterval: 30_000,
  });
}

export function useUploadEyeAppCsvRecovery(): ReturnType<
  typeof useMutation<EyeCsvImportSummary, Error, { sensorId: string; csvContent: string; notes?: string }>
> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ sensorId, csvContent, notes }) =>
      uploadEyeAppCsvRecovery(sensorId, { csvContent, notes }),
    onSuccess: (_data, vars) => {
      void queryClient.invalidateQueries({ queryKey: [TELEMETRY_DEVICES_OVERVIEW_QUERY_KEY] });
      void queryClient.invalidateQueries({ queryKey: ['temperature-devices'] });
      void queryClient.invalidateQueries({ queryKey: ['temperature-alerts'] });
      void queryClient.invalidateQueries({ queryKey: ['emergency-responses'] });
      void queryClient.invalidateQueries({ queryKey: ['quarantined-lots'] });
      void queryClient.invalidateQueries({ queryKey: DASHBOARD_SUMMARY_QUERY_KEY });
      void queryClient.invalidateQueries({
        queryKey: [SENSOR_TELEMETRY_HISTORY_QUERY_KEY, vars.sensorId],
      });
    },
  });
}
