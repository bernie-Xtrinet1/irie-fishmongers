import { encodeTeltonikaCodec8ePacket } from '../parsers/teltonika-codec8e.parser';

export interface TelemetrySimulateSample {
  capturedAt: Date;
  latitude: number | null;
  longitude: number | null;
  speedKph?: number;
  angleDeg?: number;
  altitudeM?: number;
  satellites?: number;
  cargoTempC?: number | null;
  sensorSlot?: number;
  humidityPct?: number;
  doorOpen?: boolean;
  movement?: boolean;
  batteryMv?: number;
  externalVoltageMv?: number;
  gsmSignal?: number;
}

export interface SimulatorHttpResponse<T = Record<string, unknown>> {
  status: number;
  data: T;
  rawBody: string;
}

/**
 * Reusable Teltonika FMC130 + EYE Sensor BTSMP1 gateway-to-HTTPS client.
 * Encodes genuine binary Codec 8 Extended (0x8E) frames and submits them
 * through the authenticated HTTPS ingestion API (/telemetry/codec8e) — or
 * canonical HTTP JSON (/telemetry/ingest) when simulating gateway normalization.
 */
export class TeltonikaSimulatorClient {
  private readonly normalizedBaseUrl: string;

  constructor(
    baseUrl: string,
    private readonly telemetryToken: string,
  ) {
    this.normalizedBaseUrl = baseUrl.replace(/\/$/, '');
  }

  encodeCodec8eSamplePayload(samples: TelemetrySimulateSample[]): {
    payloadBase64: string;
    payloadHex: string;
  } {
    const packet = encodeTeltonikaCodec8ePacket(
      samples.map((sample) => {
        const slot = sample.sensorSlot ?? 1;
        const offset = slot - 1;
        const io1: Array<{ id: number; value: number }> = [];
        const io2: Array<{ id: number; value: number; signed?: boolean }> = [];

        if (sample.gsmSignal !== undefined) {
          io1.push({ id: 21, value: sample.gsmSignal });
        }
        if (sample.humidityPct !== undefined) {
          io1.push({ id: 10804 + offset, value: Math.round(sample.humidityPct) });
        }
        if (sample.doorOpen !== undefined) {
          io1.push({ id: 10808 + offset, value: sample.doorOpen ? 1 : 0 });
        }
        if (sample.movement !== undefined) {
          io1.push({ id: 10812 + offset, value: sample.movement ? 1 : 0 });
        }
        if (sample.batteryMv !== undefined) {
          const encodedBatt = Math.max(0, Math.min(200, Math.round((sample.batteryMv - 2000) / 10)));
          io1.push({ id: 10816 + offset, value: encodedBatt });
        }
        if (sample.externalVoltageMv !== undefined) {
          io2.push({ id: 66, value: sample.externalVoltageMv });
        }
        if (sample.cargoTempC === null) {
          // Sentinel 0x8000 (-32768) triggers SENSOR_SIGNAL_MISSING
          io2.push({ id: 10800 + offset, value: -32768, signed: true });
        } else if (sample.cargoTempC !== undefined) {
          io2.push({
            id: 10800 + offset,
            value: Math.round(sample.cargoTempC * 100),
            signed: true,
          });
        }

        return {
          capturedAt: sample.capturedAt,
          latitude: sample.latitude,
          longitude: sample.longitude,
          altitudeM: sample.altitudeM ?? 15,
          angleDeg: sample.angleDeg ?? 90,
          satellites: sample.satellites ?? (sample.latitude !== null ? 10 : 0),
          speedKph: sample.speedKph ?? (sample.latitude !== null ? 42 : 0),
          io1,
          io2,
        };
      }),
    );

    return {
      payloadBase64: packet.toString('base64'),
      payloadHex: packet.toString('hex'),
    };
  }

  async sendCodec8e(
    imei: string,
    samples: TelemetrySimulateSample[],
  ): Promise<SimulatorHttpResponse> {
    const { payloadBase64 } = this.encodeCodec8eSamplePayload(samples);
    return this.postJson('/telemetry/codec8e', {
      imei,
      payloadBase64,
    });
  }

  async sendCanonicalHttp(
    imei: string,
    samples: TelemetrySimulateSample[],
  ): Promise<SimulatorHttpResponse> {
    return this.postJson('/telemetry/ingest', {
      imei,
      records: samples.map((s) => ({
        capturedAt: s.capturedAt.toISOString(),
        latitude: s.latitude,
        longitude: s.longitude,
        altitudeM: s.altitudeM ?? 15,
        angleDeg: s.angleDeg ?? 90,
        satellites: s.satellites ?? (s.latitude !== null ? 10 : 0),
        speedKph: s.speedKph ?? (s.latitude !== null ? 42 : 0),
        cargoTempC: s.cargoTempC,
        sensorSlot: s.sensorSlot ?? 1,
        humidityPct: s.humidityPct ?? 78,
        doorOpen: s.doorOpen ?? false,
        movement: s.movement ?? true,
        batteryMv: s.batteryMv ?? 2950,
        externalVoltageMv: s.externalVoltageMv ?? 13800,
        gsmSignal: s.gsmSignal ?? 4,
      })),
    });
  }

  private async postJson<T = Record<string, unknown>>(
    path: string,
    body: Record<string, unknown>,
  ): Promise<SimulatorHttpResponse<T>> {
    const res = await fetch(`${this.normalizedBaseUrl}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Telemetry-Key': this.telemetryToken,
      },
      body: JSON.stringify(body),
    });

    const rawBody = await res.text();
    let parsed: unknown = {};
    if (rawBody) {
      try {
        const json = JSON.parse(rawBody) as { data?: unknown } & Record<string, unknown>;
        parsed = json && typeof json === 'object' && 'data' in json && json.data ? json.data : json;
      } catch {
        parsed = { rawBody };
      }
    }

    return {
      status: res.status,
      data: parsed as T,
      rawBody,
    };
  }
}

export const KINGSTON_TO_OLD_HARBOUR_ROUTE: Array<{ lat: number; lng: number; speedKph: number }> = [
  { lat: 17.99702, lng: -76.79358, speedKph: 18 },
  { lat: 17.98654, lng: -76.8421, speedKph: 48 },
  { lat: 17.9712, lng: -76.8954, speedKph: 56 },
  { lat: 17.9551, lng: -76.9682, speedKph: 62 },
  { lat: 17.9414, lng: -77.1089, speedKph: 35 },
];
