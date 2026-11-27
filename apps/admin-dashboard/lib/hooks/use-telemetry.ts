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
  PortableCoolerSummary,
  SensorTelemetryHistory,
  TelemetryDevicesOverview,
} from '@iriefishmongers/types';

import {
  assignCoolerVehicle,
  createCompartment,
  fetchActiveRunsLiveOverview,
  fetchCompartments,
  fetchDeliveryTelemetryDetail,
  fetchSensorTelemetryHistory,
  fetchTelemetryDevicesOverview,
  registerCargoSensor,
  registerVehicleTracker,
  unassignCoolerVehicle,
  uploadEyeAppCsvRecovery,
  type CreateCompartmentInput,
  type RegisterSensorInput,
  type RegisterTrackerInput,
} from '@/lib/api/telemetry';
import { DASHBOARD_SUMMARY_QUERY_KEY } from '@/lib/hooks/use-dashboard-summary';

export const ACTIVE_RUNS_LIVE_QUERY_KEY = 'telemetry-active-runs-live';
export const TELEMETRY_DEVICES_OVERVIEW_QUERY_KEY = 'telemetry-devices-overview';
export const TELEMETRY_COMPARTMENTS_QUERY_KEY = 'telemetry-compartments';
export const SENSOR_TELEMETRY_HISTORY_QUERY_KEY = 'sensor-telemetry-history';
export const DELIVERY_TELEMETRY_DETAIL_QUERY_KEY = 'delivery-telemetry-detail';

export function useCompartments(): UseQueryResult<PortableCoolerSummary[]> {
  return useQuery({
    queryKey: [TELEMETRY_COMPARTMENTS_QUERY_KEY],
    queryFn: fetchCompartments,
  });
}

export function useCreateCompartment(): ReturnType<typeof useMutation<unknown, Error, CreateCompartmentInput>> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input) => createCompartment(input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [TELEMETRY_COMPARTMENTS_QUERY_KEY] });
      void queryClient.invalidateQueries({ queryKey: [TELEMETRY_DEVICES_OVERVIEW_QUERY_KEY] });
      void queryClient.invalidateQueries({ queryKey: ['fleet-assets'] });
    },
  });
}

export function useAssignCoolerVehicle(): ReturnType<
  typeof useMutation<unknown, Error, { compartmentId: string; fleetAssetId: string; sensorSlot?: number; notes?: string }>
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ compartmentId, ...rest }) => assignCoolerVehicle(compartmentId, rest),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [TELEMETRY_COMPARTMENTS_QUERY_KEY] });
      void queryClient.invalidateQueries({ queryKey: [TELEMETRY_DEVICES_OVERVIEW_QUERY_KEY] });
      void queryClient.invalidateQueries({ queryKey: [ACTIVE_RUNS_LIVE_QUERY_KEY] });
      void queryClient.invalidateQueries({ queryKey: ['fleet-assets'] });
    },
  });
}

export function useUnassignCoolerVehicle(): ReturnType<
  typeof useMutation<unknown, Error, { compartmentId: string; notes?: string }>
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ compartmentId, notes }) => unassignCoolerVehicle(compartmentId, { notes }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [TELEMETRY_COMPARTMENTS_QUERY_KEY] });
      void queryClient.invalidateQueries({ queryKey: [TELEMETRY_DEVICES_OVERVIEW_QUERY_KEY] });
      void queryClient.invalidateQueries({ queryKey: ['fleet-assets'] });
    },
  });
}

export function useRegisterVehicleTracker(): ReturnType<
  typeof useMutation<unknown, Error, RegisterTrackerInput>
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input) => registerVehicleTracker(input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [TELEMETRY_DEVICES_OVERVIEW_QUERY_KEY] });
      void queryClient.invalidateQueries({ queryKey: [TELEMETRY_COMPARTMENTS_QUERY_KEY] });
    },
  });
}

export function useRegisterCargoSensor(): ReturnType<
  typeof useMutation<unknown, Error, RegisterSensorInput>
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input) => registerCargoSensor(input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [TELEMETRY_COMPARTMENTS_QUERY_KEY] });
      void queryClient.invalidateQueries({ queryKey: [TELEMETRY_DEVICES_OVERVIEW_QUERY_KEY] });
      void queryClient.invalidateQueries({ queryKey: ['temperature-devices'] });
    },
  });
}

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
