import * as net from 'net';
import * as tls from 'tls';

import { MAX_CODEC8E_PACKET_BYTES, parseTeltonikaImeiPacket } from '../parsers/teltonika-codec8e.parser';

export interface TeltonikaGatewayConfig {
  port: number;
  host?: string;
  backendApiUrl: string;
  gatewayToken: string;
  tlsOptions?: tls.TlsOptions;
  requestTimeoutMs?: number;
  logger?: { log: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void };
}

interface HttpPostResult {
  status: number;
  body: Record<string, unknown>;
}

/**
 * Persistent TCP/TLS socket receiver for Teltonika FMC130 devices speaking
 * Codec 8 Extended (0x8E):
 *   1. Receives IMEI handshake -> validates against backend before replying 0x01/0x00.
 *   2. Buffers binary AVL frames (0x00000000 preamble + 4-byte length + payload + 4-byte CRC).
 *   3. Forwards each binary frame to POST /api/v1/telemetry/codec8e with gateway auth.
 *   4. Writes 4-byte big-endian record ACK ONLY after the backend commits/deduplicates it.
 */
export class TeltonikaTcpServer {
  private server: net.Server | tls.Server | null = null;
  private readonly activeSockets = new Set<net.Socket>();

  constructor(private readonly config: TeltonikaGatewayConfig) {}

  async start(): Promise<{ port: number; host: string }> {
    if (this.server) {
      throw new Error('TeltonikaTcpServer is already started');
    }

    const handleConnection = (socket: net.Socket): void => {
      this.activeSockets.add(socket);
      socket.setTimeout(120_000);

      let buffer = Buffer.alloc(0);
      let authorizedImei: string | null = null;
      let processing = false;

      const processBuffer = async (): Promise<void> => {
        if (processing || socket.destroyed) return;
        processing = true;
        try {
          while (!socket.destroyed) {
            if (!authorizedImei) {
              if (buffer.length < 2) break;
              const declaredLen = buffer.readUInt16BE(0);
              if (declaredLen < 15 || declaredLen > 20) {
                this.config.logger?.warn(`Rejecting malformed Teltonika IMEI length ${declaredLen}`);
                socket.write(Buffer.from([0x00]), () => socket.destroy());
                break;
              }
              if (buffer.length < 2 + declaredLen) break;

              const { imei, bytesConsumed } = parseTeltonikaImeiPacket(buffer);
              buffer = buffer.subarray(bytesConsumed);

              const authRes = await this.postJson('/telemetry/authorize-imei', { imei });
              if (authRes.status >= 200 && authRes.status < 300 && authRes.body.authorized === true) {
                authorizedImei = imei;
                socket.write(Buffer.from([0x01]));
              } else {
                this.config.logger?.warn(`Unauthorized IMEI connection rejected: ${imei}`);
                socket.write(Buffer.from([0x00]), () => socket.destroy());
                break;
              }
              continue;
            }

            // Binary AVL packet framing: 4-byte zero preamble + 4-byte data length + data + 4-byte CRC
            if (buffer.length < 8) break;
            const preamble = buffer.readUInt32BE(0);
            if (preamble !== 0) {
              this.config.logger?.warn(`Closing socket due to invalid AVL preamble from ${authorizedImei}`);
              socket.destroy();
              break;
            }

            const dataFieldLength = buffer.readUInt32BE(4);
            const totalFrameBytes = 8 + dataFieldLength + 4;
            if (dataFieldLength < 3 || totalFrameBytes > MAX_CODEC8E_PACKET_BYTES) {
              this.config.logger?.warn(`Closing socket due to invalid AVL length from ${authorizedImei}`);
              socket.destroy();
              break;
            }
            if (buffer.length < totalFrameBytes) break;

            const frame = buffer.subarray(0, totalFrameBytes);
            buffer = buffer.subarray(totalFrameBytes);

            const ingestRes = await this.postJson('/telemetry/codec8e', {
              imei: authorizedImei,
              payloadBase64: frame.toString('base64'),
            });

            if (ingestRes.status < 200 || ingestRes.status >= 300) {
              this.config.logger?.error(
                `Backend rejected AVL packet for ${authorizedImei} (HTTP ${ingestRes.status}); withholding ACK`,
              );
              socket.destroy();
              break;
            }

            const acceptedCount = Number(ingestRes.body.acceptedCount ?? 0);
            const ack = Buffer.alloc(4);
            ack.writeUInt32BE(acceptedCount, 0);
            socket.write(ack);
          }
        } catch (err) {
          this.config.logger?.error(
            `Telemetry gateway socket error: ${err instanceof Error ? err.message : String(err)}`,
          );
          socket.destroy();
        } finally {
          processing = false;
        }
      };

      socket.on('data', (chunk: Buffer) => {
        if (buffer.length + chunk.length > MAX_CODEC8E_PACKET_BYTES * 2) {
          socket.destroy();
          return;
        }
        buffer = Buffer.concat([buffer, chunk]);
        void processBuffer();
      });

      socket.on('timeout', () => socket.destroy());
      socket.on('close', () => {
        this.activeSockets.delete(socket);
      });
      socket.on('error', () => {
        this.activeSockets.delete(socket);
      });
    };

    const server = this.config.tlsOptions
      ? tls.createServer(this.config.tlsOptions, handleConnection)
      : net.createServer(handleConnection);
    this.server = server;

    const listenHost = this.config.host ?? '0.0.0.0';
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.config.port, listenHost, () => {
        const addr = server.address();
        if (addr && typeof addr === 'object') {
          resolve({ port: addr.port, host: addr.address });
        } else {
          resolve({ port: this.config.port, host: listenHost });
        }
      });
    });
  }

  async stop(): Promise<void> {
    for (const socket of this.activeSockets) {
      socket.destroy();
    }
    this.activeSockets.clear();

    const srv = this.server;
    this.server = null;
    if (!srv) return;
    await new Promise<void>((resolve) => srv.close(() => resolve()));
  }

  private async postJson(path: string, body: Record<string, unknown>): Promise<HttpPostResult> {
    const base = this.config.backendApiUrl.replace(/\/$/, '');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.requestTimeoutMs ?? 10_000);
    try {
      const response = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Telemetry-Key': this.config.gatewayToken,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await response.text();
      let parsed: Record<string, unknown> = {};
      if (text) {
        try {
          parsed = JSON.parse(text) as Record<string, unknown>;
        } catch {
          parsed = { raw: text };
        }
      }
      return { status: response.status, body: parsed };
    } finally {
      clearTimeout(timeout);
    }
  }
}
