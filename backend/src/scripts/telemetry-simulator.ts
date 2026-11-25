import {
  KINGSTON_TO_OLD_HARBOUR_ROUTE,
  TeltonikaSimulatorClient,
  TelemetrySimulateSample,
} from '../modules/telemetry/simulator/teltonika-simulator';

function readArg(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  if (idx !== -1 && idx + 1 < process.argv.length) {
    return process.argv[idx + 1];
  }
  return undefined;
}

async function main(): Promise<void> {
  const baseUrl =
    readArg('--base-url') || process.env.BACKEND_API_URL || 'http://127.0.0.1:3001/api/v1';
  const token = readArg('--token') || process.env.TELEMETRY_GATEWAY_TOKEN;
  const imei = readArg('--imei') || process.env.SIM_TRACKER_IMEI || '356307042441013';
  const mode = readArg('--mode') || 'burst';
  const tempC = Number(readArg('--temp') ?? '2.35');
  const capturedAtArg = readArg('--captured-at');

  if (!token) {
    console.error(
      'Missing telemetry token: pass --token <key> or set TELEMETRY_GATEWAY_TOKEN in the environment.',
    );
    process.exit(1);
  }

  const client = new TeltonikaSimulatorClient(baseUrl, token);
  const now = capturedAtArg ? new Date(capturedAtArg) : new Date();

  if (mode === 'stream') {
    const intervalMs = Number(readArg('--interval-ms') ?? '15000');
    let step = 0;
    process.stdout.write(
      `Streaming simulated FMC130 Codec 8E frames to ${baseUrl} every ${intervalMs}ms...\n`,
    );
    const sendTick = async (): Promise<void> => {
      const point = KINGSTON_TO_OLD_HARBOUR_ROUTE[step % KINGSTON_TO_OLD_HARBOUR_ROUTE.length]!;
      const sample: TelemetrySimulateSample = {
        capturedAt: new Date(),
        latitude: point.lat,
        longitude: point.lng,
        speedKph: point.speedKph,
        cargoTempC: tempC,
        humidityPct: 78,
        doorOpen: false,
        movement: true,
        batteryMv: 2950,
        gsmSignal: 4,
      };
      const res = await client.sendCodec8e(imei, [sample]);
      process.stdout.write(`[tick=${step}] HTTP ${res.status} -> ${JSON.stringify(res.data)}\n`);
      step += 1;
    };
    await sendTick();
    setInterval(() => {
      void sendTick();
    }, intervalMs);
    return;
  }

  const point = KINGSTON_TO_OLD_HARBOUR_ROUTE[0]!;
  const burstSamples: TelemetrySimulateSample[] = [
    {
      capturedAt: new Date(now.getTime() - 10 * 60_000),
      latitude: point.lat,
      longitude: point.lng,
      speedKph: 32,
      cargoTempC: tempC,
      humidityPct: 76,
      doorOpen: false,
      movement: true,
      batteryMv: 2950,
      gsmSignal: 4,
    },
    {
      capturedAt: now,
      latitude: KINGSTON_TO_OLD_HARBOUR_ROUTE[1]!.lat,
      longitude: KINGSTON_TO_OLD_HARBOUR_ROUTE[1]!.lng,
      speedKph: 48,
      cargoTempC: tempC,
      humidityPct: 77,
      doorOpen: false,
      movement: true,
      batteryMv: 2950,
      gsmSignal: 4,
    },
  ];

  const first = await client.sendCodec8e(imei, burstSamples);
  process.stdout.write(`First Codec 8E burst: ${first.status} ${JSON.stringify(first.data)}\n`);

  // Repeat identical burst once to confirm idempotent deduplication
  const retry = await client.sendCodec8e(imei, burstSamples);
  process.stdout.write(`Duplicate retry burst: ${retry.status} ${JSON.stringify(retry.data)}\n`);

  if (first.status >= 400 || retry.status >= 400) {
    process.exit(1);
  }
}

void main().catch((err) => {
  console.error('Telemetry simulator error:', err);
  process.exit(1);
});
