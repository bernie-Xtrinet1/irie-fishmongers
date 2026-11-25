import * as fs from 'fs';
import { Logger } from '@nestjs/common';

import { TeltonikaTcpServer } from './modules/telemetry/gateway/teltonika-tcp-server';

async function bootstrapGateway(): Promise<void> {
  const logger = new Logger('TelemetryGateway');
  const port = Number(process.env.TELEMETRY_TCP_PORT || 5027);
  const backendApiUrl = process.env.BACKEND_API_URL;
  const gatewayToken = process.env.TELEMETRY_GATEWAY_TOKEN;

  if (!backendApiUrl || !gatewayToken) {
    throw new Error('BACKEND_API_URL and TELEMETRY_GATEWAY_TOKEN environment variables are required');
  }

  const certPath = process.env.TELEMETRY_TLS_CERT_PATH;
  const keyPath = process.env.TELEMETRY_TLS_KEY_PATH;
  const tlsOptions =
    certPath && keyPath
      ? {
          cert: fs.readFileSync(certPath),
          key: fs.readFileSync(keyPath),
        }
      : undefined;

  const gateway = new TeltonikaTcpServer({
    port,
    host: '0.0.0.0',
    backendApiUrl,
    gatewayToken,
    tlsOptions,
    logger: {
      log: (msg) => logger.log(msg),
      warn: (msg) => logger.warn(msg),
      error: (msg) => logger.error(msg),
    },
  });

  const listening = await gateway.start();
  logger.log(
    `Teltonika Codec 8 Extended ${tlsOptions ? 'TLS' : 'TCP'} gateway listening on ${listening.host}:${listening.port}`,
  );

  const shutdown = async () => {
    logger.log('Shutting down telemetry TCP/TLS gateway...');
    await gateway.stop();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());
}

void bootstrapGateway();
