import type { TelemetryReportingStatus, VehicleGpsStatus } from '@iriefishmongers/types';

export type BadgeVariant = 'neutral' | 'success' | 'warning' | 'danger' | 'info';

export const GPS_STATUS_META: Record<VehicleGpsStatus, { label: string; variant: BadgeVariant }> = {
  LIVE: { label: 'Live GPS', variant: 'success' },
  DELAYED: { label: 'Delayed Recovery', variant: 'warning' },
  NO_FIX: { label: 'No GNSS Fix', variant: 'warning' },
  STALE: { label: 'Stale Location', variant: 'danger' },
  OFFLINE: { label: 'Offline', variant: 'danger' },
};

export const SENSOR_STATUS_META: Record<TelemetryReportingStatus, { label: string; variant: BadgeVariant }> = {
  REPORTING: { label: 'Reporting', variant: 'success' },
  DELAYED: { label: 'Delayed Buffer', variant: 'warning' },
  SENSOR_SIGNAL_MISSING: { label: 'Sensor Signal Missing', variant: 'danger' },
  STALE: { label: 'Stale', variant: 'warning' },
  OFFLINE: { label: 'Offline', variant: 'danger' },
  DECOMMISSIONED: { label: 'Decommissioned', variant: 'neutral' },
};

export function formatTelemetryDateTime(value: string | null | undefined): string {
  if (!value) return 'Never';
  return new Date(value).toLocaleString('en-JM');
}

export function formatCoordinates(lat: number | null | undefined, lng: number | null | undefined): string {
  if (lat === null || lat === undefined || lng === null || lng === undefined) {
    return 'No fix';
  }
  return `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
}

export function formatDelayDuration(seconds: number | null | undefined): string | null {
  if (seconds === null || seconds === undefined || seconds <= 90) return null;
  if (seconds < 120) return `+${seconds}s delayed`;
  return `+${Math.round(seconds / 60)}m delayed`;
}
