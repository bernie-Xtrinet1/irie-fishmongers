import { DeviceStatus } from '@prisma/client';

export const DELAYED_TELEMETRY_THRESHOLD_SECONDS = 90;
export const STALE_TELEMETRY_THRESHOLD_MS = 10 * 60 * 1000;
export const OFFLINE_TELEMETRY_THRESHOLD_MS = 30 * 60 * 1000;

export type TelemetryReportingStatus =
  | 'REPORTING'
  | 'DELAYED'
  | 'SENSOR_SIGNAL_MISSING'
  | 'STALE'
  | 'OFFLINE'
  | 'DECOMMISSIONED';

export type VehicleGpsStatus = 'LIVE' | 'DELAYED' | 'NO_FIX' | 'STALE' | 'OFFLINE';

export function computeDelaySeconds(
  capturedAt: Date,
  receivedAt: Date,
): { delaySeconds: number; isDelayed: boolean } {
  const diffSeconds = Math.max(0, Math.round((receivedAt.getTime() - capturedAt.getTime()) / 1000));
  return {
    delaySeconds: diffSeconds,
    isDelayed: diffSeconds > DELAYED_TELEMETRY_THRESHOLD_SECONDS,
  };
}

export function computeSensorReportingStatus(
  input: {
    status: DeviceStatus;
    lastSeenAt?: Date | null;
    lastCapturedAt?: Date | null;
    lastDelaySeconds?: number | null;
    lastSignalMissingAt?: Date | null;
  },
  now = new Date(),
): TelemetryReportingStatus {
  if (input.status !== DeviceStatus.ACTIVE) {
    return 'DECOMMISSIONED';
  }

  const effectiveCaptured = input.lastCapturedAt ?? input.lastSeenAt ?? null;

  if (
    input.lastSignalMissingAt &&
    (!effectiveCaptured || input.lastSignalMissingAt.getTime() >= effectiveCaptured.getTime()) &&
    now.getTime() - input.lastSignalMissingAt.getTime() <= OFFLINE_TELEMETRY_THRESHOLD_MS
  ) {
    return 'SENSOR_SIGNAL_MISSING';
  }

  if (!effectiveCaptured) {
    return 'OFFLINE';
  }

  const ageMs = now.getTime() - effectiveCaptured.getTime();
  if (ageMs > OFFLINE_TELEMETRY_THRESHOLD_MS) {
    return 'OFFLINE';
  }
  if (ageMs > STALE_TELEMETRY_THRESHOLD_MS) {
    return 'STALE';
  }

  if ((input.lastDelaySeconds ?? 0) > DELAYED_TELEMETRY_THRESHOLD_SECONDS) {
    return 'DELAYED';
  }

  return 'REPORTING';
}

export function computeVehicleGpsStatus(
  input: {
    lastGpsCapturedAt?: Date | null;
    lastTelemetryReceivedAt?: Date | null;
    lastTelemetryDelayed?: boolean;
    lastGpsNoFixAt?: Date | null;
  },
  now = new Date(),
): VehicleGpsStatus {
  const lastCapture = input.lastGpsCapturedAt ?? null;
  if (
    input.lastGpsNoFixAt &&
    (!lastCapture || input.lastGpsNoFixAt.getTime() >= lastCapture.getTime()) &&
    now.getTime() - input.lastGpsNoFixAt.getTime() <= OFFLINE_TELEMETRY_THRESHOLD_MS
  ) {
    return 'NO_FIX';
  }

  if (!lastCapture) {
    return 'OFFLINE';
  }

  const freshestEvidenceMs = Math.max(
    lastCapture.getTime(),
    input.lastTelemetryReceivedAt?.getTime() ?? 0,
  );
  const ageMs = now.getTime() - freshestEvidenceMs;
  if (ageMs > OFFLINE_TELEMETRY_THRESHOLD_MS) {
    return 'OFFLINE';
  }
  if (ageMs > STALE_TELEMETRY_THRESHOLD_MS) {
    return 'STALE';
  }
  if (input.lastTelemetryDelayed) {
    return 'DELAYED';
  }
  return 'LIVE';
}
