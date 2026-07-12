'use client';

import type {
  EmergencyResponse,
  EmergencyResponseStatus,
  Paginated,
  SeafoodLotAdmin,
  TemperatureAlert,
  TemperatureDevice,
} from '@iriefishmongers/types';
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';

import {
  acknowledgeEmergencyResponse,
  calibrateTemperatureDevice,
  fetchEmergencyResponses,
  fetchQuarantinedLots,
  fetchTemperatureAlerts,
  fetchTemperatureDevices,
  resolveTemperatureAlert,
  updateEmergencyResponseStatus,
  updateLotStatus,
  type ListQuarantinedLotsParams,
  type ListTemperatureAlertsParams,
  type UpdateEmergencyResponseStatusInput,
  type UpdateLotStatusInput,
} from '@/lib/api/cold-chain';
import { DASHBOARD_SUMMARY_QUERY_KEY } from '@/lib/hooks/use-dashboard-summary';

const ALERTS_QUERY_KEY = 'temperature-alerts';
const DEVICES_QUERY_KEY = ['temperature-devices'] as const;
const EMERGENCY_RESPONSES_QUERY_KEY = 'emergency-responses';
const QUARANTINED_LOTS_QUERY_KEY = 'quarantined-lots';

export function useTemperatureAlerts(params: ListTemperatureAlertsParams): UseQueryResult<Paginated<TemperatureAlert>> {
  return useQuery({
    queryKey: [ALERTS_QUERY_KEY, params],
    queryFn: () => fetchTemperatureAlerts(params),
  });
}

export function useResolveTemperatureAlert(): ReturnType<typeof useMutation<TemperatureAlert, Error, string>> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => resolveTemperatureAlert(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [ALERTS_QUERY_KEY] });
      // A resolved CRITICAL/EMERGENCY alert count feeds the dashboard's
      // compliance.activeAlertsBySeverity KPI.
      void queryClient.invalidateQueries({ queryKey: DASHBOARD_SUMMARY_QUERY_KEY });
    },
  });
}

export function useTemperatureDevices(): UseQueryResult<TemperatureDevice[]> {
  return useQuery({
    queryKey: DEVICES_QUERY_KEY,
    queryFn: () => fetchTemperatureDevices(),
  });
}

export function useCalibrateTemperatureDevice(): ReturnType<typeof useMutation<TemperatureDevice, Error, string>> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => calibrateTemperatureDevice(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: DEVICES_QUERY_KEY });
    },
  });
}

export function useEmergencyResponses(status?: EmergencyResponseStatus): UseQueryResult<EmergencyResponse[]> {
  return useQuery({
    queryKey: [EMERGENCY_RESPONSES_QUERY_KEY, status ?? 'ALL'],
    queryFn: () => fetchEmergencyResponses(status),
  });
}

export function useAcknowledgeEmergencyResponse(): ReturnType<typeof useMutation<EmergencyResponse, Error, string>> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => acknowledgeEmergencyResponse(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [EMERGENCY_RESPONSES_QUERY_KEY] });
    },
  });
}

export function useUpdateEmergencyResponseStatus(): ReturnType<
  typeof useMutation<EmergencyResponse, Error, { id: string; input: UpdateEmergencyResponseStatusInput }>
> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateEmergencyResponseStatusInput }) =>
      updateEmergencyResponseStatus(id, input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [EMERGENCY_RESPONSES_QUERY_KEY] });
      // A RESOLVED emergency response doesn't by itself change the source
      // lot's food-safety status (that's the Quarantined Lots action
      // below), but activeRecalls/alerts KPIs can still be affected by the
      // same underlying incident, so refresh the dashboard defensively.
      void queryClient.invalidateQueries({ queryKey: DASHBOARD_SUMMARY_QUERY_KEY });
    },
  });
}

export function useQuarantinedLots(params: ListQuarantinedLotsParams): UseQueryResult<Paginated<SeafoodLotAdmin>> {
  return useQuery({
    queryKey: [QUARANTINED_LOTS_QUERY_KEY, params],
    queryFn: () => fetchQuarantinedLots(params),
  });
}

export function useUpdateLotStatus(): ReturnType<
  typeof useMutation<SeafoodLotAdmin, Error, { id: string; input: UpdateLotStatusInput }>
> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateLotStatusInput }) => updateLotStatus(id, input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [QUARANTINED_LOTS_QUERY_KEY] });
      // Clearing/rejecting a quarantined lot moves activeAlertsBySeverity
      // indirectly (fewer quarantined lots outstanding).
      void queryClient.invalidateQueries({ queryKey: DASHBOARD_SUMMARY_QUERY_KEY });
    },
  });
}
