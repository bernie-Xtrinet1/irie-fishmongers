import { BadRequestException } from '@nestjs/common';

import { EyeSensorIoReadings } from './teltonika-codec8e.parser';

export interface NormalizedTelemetryRecord {
  capturedAt: Date;
  latitude: number | null;
  longitude: number | null;
  altitudeM: number | null;
  angleDeg: number | null;
  satellites: number | null;
  speedKph: number | null;
  gnssValid: boolean;
  gsmSignal: number | null;
  externalVoltageMv: number | null;
  trackerBatteryMv: number | null;
  eyeSensors: Record<number, EyeSensorIoReadings>;
  eventId?: string;
  rawPayload: Record<string, unknown>;
}

export interface NormalizedEyeCsvRecord {
  lineNumber: number;
  capturedAt: Date;
  temperatureC: number;
  humidityPct: number | null;
  doorOpen: boolean | null;
  batteryMv: number | null;
}

function parseTimestamp(value: unknown): Date {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    const ms = value < 1e12 ? value * 1000 : value;
    const d = new Date(ms);
    if (!Number.isNaN(d.getTime())) return d;
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const trimmed = value.trim();
    if (/^\d+$/.test(trimmed)) {
      const num = Number(trimmed);
      const ms = num < 1e12 ? num * 1000 : num;
      const d = new Date(ms);
      if (!Number.isNaN(d.getTime())) return d;
    }
    const isoCandidate = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(trimmed)
      ? `${trimmed.replace(' ', 'T')}Z`
      : trimmed;
    const d = new Date(isoCandidate);
    if (!Number.isNaN(d.getTime())) return d;
  }
  throw new BadRequestException('Telemetry record is missing a valid capture timestamp');
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function extractCoordinates(obj: Record<string, unknown>): {
  latitude: number | null;
  longitude: number | null;
  gnssValid: boolean;
} {
  let lat = toFiniteNumber(obj.latitude ?? obj.lat);
  let lng = toFiniteNumber(obj.longitude ?? obj.lng ?? obj.lon);

  if ((lat === null || lng === null) && typeof obj.latlng === 'string') {
    const parts = obj.latlng.split(',').map((part) => Number(part.trim()));
    if (parts.length === 2 && Number.isFinite(parts[0]) && Number.isFinite(parts[1])) {
      lat = parts[0]!;
      lng = parts[1]!;
    }
  }

  const satellites = toFiniteNumber(obj.satellites ?? obj.sat);
  const hasFixFlag = typeof obj.gnssValid === 'boolean' ? obj.gnssValid : undefined;
  const nonZeroCoords = lat !== null && lng !== null && !(lat === 0 && lng === 0);
  const boundedCoords =
    nonZeroCoords && lat !== null && lng !== null && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
  const gnssValid =
    boundedCoords && (hasFixFlag !== undefined ? hasFixFlag : satellites === null || satellites > 0);

  return {
    latitude: gnssValid ? lat : null,
    longitude: gnssValid ? lng : null,
    gnssValid,
  };
}

function decodeCodecJsonEyeSensors(obj: Record<string, unknown>): Record<number, EyeSensorIoReadings> {
  const eyeSensors: Record<number, EyeSensorIoReadings> = {};

  for (let slot = 1; slot <= 4; slot += 1) {
    const offset = slot - 1;
    const rawTemp = toFiniteNumber(obj[String(10800 + offset)]);
    const rawHum = toFiniteNumber(obj[String(10804 + offset)]);
    const rawDoor = obj[String(10808 + offset)];
    const rawMov = obj[String(10812 + offset)];
    const rawBatt = toFiniteNumber(obj[String(10816 + offset)]);

    if (
      rawTemp === null &&
      rawHum === null &&
      rawDoor === undefined &&
      rawMov === undefined &&
      rawBatt === null
    ) {
      continue;
    }

    let cargoTempC: number | null = null;
    if (rawTemp !== null && rawTemp !== -32768 && rawTemp !== 32767) {
      cargoTempC = Number((rawTemp * 0.01).toFixed(2));
      if (cargoTempC < -80 || cargoTempC > 85) {
        cargoTempC = null;
      }
    }

    eyeSensors[slot] = {
      slot,
      cargoTempC,
      humidityPct: rawHum !== null && rawHum >= 0 && rawHum <= 100 ? rawHum : null,
      doorOpen: rawDoor !== undefined ? Boolean(Number(rawDoor)) : null,
      movement: rawMov !== undefined ? Boolean(Number(rawMov)) : null,
      batteryMv:
        rawBatt !== null && rawBatt !== 255 && rawBatt !== 65535
          ? rawBatt <= 200
            ? 2000 + rawBatt * 10
            : Math.round(rawBatt)
          : null,
    };
  }

  return eyeSensors;
}

export function normalizeTeltonikaCodecJson(payload: Record<string, unknown>): NormalizedTelemetryRecord[] {
  const stateObj = payload.state as Record<string, unknown> | undefined;
  const reportedObj =
    stateObj && typeof stateObj.reported === 'object' && stateObj.reported !== null
      ? (stateObj.reported as Record<string, unknown>)
      : null;

  const rawItems: Array<Record<string, unknown>> = Array.isArray(payload.records)
    ? payload.records.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object'))
    : reportedObj
      ? [reportedObj]
      : [payload];

  if (rawItems.length === 0) {
    throw new BadRequestException('Telemetry Codec JSON payload contains no records');
  }

  return rawItems.map((item) => {
    const capturedAt = parseTimestamp(item.ts ?? item.timestamp ?? item.capturedAt);
    const coords = extractCoordinates(item);
    const eyeSensors = decodeCodecJsonEyeSensors(item);

    return {
      capturedAt,
      latitude: coords.latitude,
      longitude: coords.longitude,
      altitudeM: toFiniteNumber(item.alt ?? item.altitudeM),
      angleDeg: toFiniteNumber(item.ang ?? item.angleDeg),
      satellites: toFiniteNumber(item.sat ?? item.satellites),
      speedKph: toFiniteNumber(item.sp ?? item.speedKph),
      gnssValid: coords.gnssValid,
      gsmSignal: toFiniteNumber(item['21'] ?? item.gsmSignal),
      externalVoltageMv: toFiniteNumber(item['66'] ?? item.externalVoltageMv),
      trackerBatteryMv: toFiniteNumber(item['67'] ?? item.trackerBatteryMv),
      eyeSensors,
      eventId: typeof item.eventId === 'string' ? item.eventId : undefined,
      rawPayload: item,
    };
  });
}

export interface CanonicalTelemetryRecordInput {
  capturedAt: string;
  latitude?: number | null;
  longitude?: number | null;
  altitudeM?: number | null;
  angleDeg?: number | null;
  satellites?: number | null;
  speedKph?: number | null;
  gnssValid?: boolean;
  gsmSignal?: number | null;
  externalVoltageMv?: number | null;
  trackerBatteryMv?: number | null;
  cargoTempC?: number | null;
  sensorSlot?: number | null;
  humidityPct?: number | null;
  doorOpen?: boolean | null;
  movement?: boolean | null;
  batteryMv?: number | null;
  eyeSensors?: Record<
    string,
    {
      cargoTempC?: number | null;
      humidityPct?: number | null;
      doorOpen?: boolean | null;
      movement?: boolean | null;
      batteryMv?: number | null;
    }
  >;
  eventId?: string;
}

export function normalizeCanonicalHttpRecords(
  records: CanonicalTelemetryRecordInput[],
  defaultSensorSlot = 1,
): NormalizedTelemetryRecord[] {
  if (!records || records.length === 0) {
    throw new BadRequestException('Telemetry ingest payload must contain at least one record');
  }

  return records.map((rec) => {
    const capturedAt = parseTimestamp(rec.capturedAt);
    const coords = extractCoordinates({
      latitude: rec.latitude,
      longitude: rec.longitude,
      satellites: rec.satellites,
      gnssValid: rec.gnssValid,
    });

    const eyeSensors: Record<number, EyeSensorIoReadings> = {};
    if (rec.eyeSensors) {
      for (const [slotKey, reading] of Object.entries(rec.eyeSensors)) {
        const slot = Number(slotKey);
        if (!Number.isInteger(slot) || slot < 1 || slot > 4) continue;
        eyeSensors[slot] = {
          slot,
          cargoTempC: reading.cargoTempC ?? null,
          humidityPct: reading.humidityPct ?? null,
          doorOpen: reading.doorOpen ?? null,
          movement: reading.movement ?? null,
          batteryMv: reading.batteryMv ?? null,
        };
      }
    } else if (
      rec.cargoTempC !== undefined ||
      rec.humidityPct !== undefined ||
      rec.doorOpen !== undefined ||
      rec.movement !== undefined ||
      rec.batteryMv !== undefined
    ) {
      const slot = rec.sensorSlot && rec.sensorSlot >= 1 && rec.sensorSlot <= 4 ? rec.sensorSlot : defaultSensorSlot;
      eyeSensors[slot] = {
        slot,
        cargoTempC: rec.cargoTempC ?? null,
        humidityPct: rec.humidityPct ?? null,
        doorOpen: rec.doorOpen ?? null,
        movement: rec.movement ?? null,
        batteryMv: rec.batteryMv ?? null,
      };
    }

    return {
      capturedAt,
      latitude: coords.latitude,
      longitude: coords.longitude,
      altitudeM: rec.altitudeM ?? null,
      angleDeg: rec.angleDeg ?? null,
      satellites: rec.satellites ?? null,
      speedKph: rec.speedKph ?? null,
      gnssValid: coords.gnssValid,
      gsmSignal: rec.gsmSignal ?? null,
      externalVoltageMv: rec.externalVoltageMv ?? null,
      trackerBatteryMv: rec.trackerBatteryMv ?? null,
      eyeSensors,
      eventId: rec.eventId,
      rawPayload: rec as unknown as Record<string, unknown>,
    };
  });
}

/**
 * Parses a Teltonika EYE App EN12830 CSV export (supporting comma or semicolon
 * delimiters and separate Date+Time or single ISO Timestamp columns).
 */
export function parseEyeAppRecoveryCsv(csvContent: string): NormalizedEyeCsvRecord[] {
  const lines = csvContent
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (lines.length < 2) {
    throw new BadRequestException('EYE App CSV must include a header row and at least one data row');
  }

  const headerLine = lines[0]!;
  const delimiter = headerLine.includes(';') && !headerLine.includes(',') ? ';' : ',';
  const headers = headerLine.split(delimiter).map((col) => col.trim().toLowerCase());

  const timestampIdx = headers.findIndex((h) =>
    ['timestamp', 'utc', 'datetime', 'captured_at', 'capturedat', 'time_utc'].some((key) =>
      h.includes(key),
    ),
  );
  const dateIdx = headers.findIndex((h) => h === 'date' || h.startsWith('date '));
  const timeIdx = headers.findIndex((h) => h === 'time' || h.startsWith('time '));
  const tempIdx = headers.findIndex((h) => h.includes('temp'));
  const humidityIdx = headers.findIndex((h) => h.includes('humid'));
  const doorIdx = headers.findIndex((h) => h.includes('door') || h.includes('magnet'));
  const batteryIdx = headers.findIndex((h) => h.includes('batt'));

  if (tempIdx === -1 || (timestampIdx === -1 && (dateIdx === -1 || timeIdx === -1))) {
    throw new BadRequestException(
      'EYE App CSV must contain a temperature column and either a timestamp column or date + time columns',
    );
  }

  const parsedRows: NormalizedEyeCsvRecord[] = [];
  for (let i = 1; i < lines.length; i += 1) {
    const lineNumber = i + 1;
    const cols = lines[i]!.split(delimiter).map((col) => col.trim().replace(/^"|"$/g, ''));

    const rawTimestamp =
      timestampIdx !== -1 ? cols[timestampIdx] : `${cols[dateIdx] ?? ''}T${cols[timeIdx] ?? ''}Z`;
    let capturedAt: Date;
    try {
      capturedAt = parseTimestamp(rawTimestamp);
    } catch {
      throw new BadRequestException(`Invalid timestamp in EYE App CSV on line ${lineNumber}`);
    }

    const temp = toFiniteNumber(cols[tempIdx]);
    if (temp === null || temp < -80 || temp > 85) {
      throw new BadRequestException(`Invalid temperature °C in EYE App CSV on line ${lineNumber}`);
    }

    const humidity = humidityIdx !== -1 ? toFiniteNumber(cols[humidityIdx]) : null;
    const doorRaw = doorIdx !== -1 ? cols[doorIdx]?.toLowerCase() : undefined;
    const doorOpen =
      doorRaw === undefined || doorRaw === ''
        ? null
        : doorRaw === '1' || doorRaw === 'true' || doorRaw === 'open';
    const battery = batteryIdx !== -1 ? toFiniteNumber(cols[batteryIdx]) : null;

    parsedRows.push({
      lineNumber,
      capturedAt,
      temperatureC: Number(temp.toFixed(2)),
      humidityPct: humidity !== null && humidity >= 0 && humidity <= 100 ? Number(humidity.toFixed(2)) : null,
      doorOpen,
      batteryMv: battery !== null ? (battery < 10 ? Math.round(battery * 1000) : Math.round(battery)) : null,
    });
  }

  return parsedRows.sort((a, b) => a.capturedAt.getTime() - b.capturedAt.getTime());
}
