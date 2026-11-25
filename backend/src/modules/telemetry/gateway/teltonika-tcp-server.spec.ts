import * as http from 'http';
import * as net from 'net';

import {
  encodeTeltonikaCodec8ePacket,
  encodeTeltonikaImeiPacket,
} from '../parsers/teltonika-codec8e.parser';
import { TeltonikaTcpServer } from './teltonika-tcp-server';

describe('TeltonikaTcpServer', () => {
  it('completes IMEI handshake, forwards Codec 8 Extended frames, and ACKs only after backend commit', async () => {
    let ingestShouldFail = false;
    const receivedFrames: Array<{ imei: string; payloadBase64: string }> = [];

    const mockBackend = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, string>;
        if (req.headers['x-telemetry-key'] !== 'gw-secret-token') {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ message: 'Unauthorized' }));
          return;
        }
        if (req.url === '/api/v1/telemetry/authorize-imei') {
          const ok = body.imei === '356307042441013';
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ authorized: ok }));
          return;
        }
        if (req.url === '/api/v1/telemetry/codec8e') {
          if (ingestShouldFail) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ message: 'DB unavailable' }));
            return;
          }
          receivedFrames.push({ imei: body.imei!, payloadBase64: body.payloadBase64! });
          res.writeHead(201, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ acceptedCount: 2 }));
          return;
        }
        res.writeHead(404);
        res.end();
      });
    });

    await new Promise<void>((resolve) => mockBackend.listen(0, '127.0.0.1', () => resolve()));
    const backendAddr = mockBackend.address() as net.AddressInfo;

    const tcpServer = new TeltonikaTcpServer({
      port: 0,
      host: '127.0.0.1',
      backendApiUrl: `http://127.0.0.1:${backendAddr.port}/api/v1`,
      gatewayToken: 'gw-secret-token',
    });
    const tcpAddr = await tcpServer.start();

    try {
      // 1. Happy path handshake + 2-record Codec 8E packet
      const frame = encodeTeltonikaCodec8ePacket([
        {
          capturedAt: new Date('2026-11-25T11:00:00.000Z'),
          latitude: 18.01,
          longitude: -76.8,
          io2: [{ id: 10800, value: 240, signed: true }],
        },
        {
          capturedAt: new Date('2026-11-25T11:01:00.000Z'),
          latitude: 18.02,
          longitude: -76.81,
          io2: [{ id: 10800, value: 250, signed: true }],
        },
      ]);

      const ack = await new Promise<Buffer>((resolve, reject) => {
        const client = net.connect(tcpAddr.port, '127.0.0.1', () => {
          client.write(encodeTeltonikaImeiPacket('356307042441013'));
        });
        let phase: 'imei' | 'ack' = 'imei';
        client.on('data', (data) => {
          if (phase === 'imei') {
            expect(data).toEqual(Buffer.from([0x01]));
            phase = 'ack';
            client.write(frame);
          } else {
            client.end();
            resolve(data);
          }
        });
        client.on('error', reject);
      });

      expect(ack.readUInt32BE(0)).toBe(2);
      expect(receivedFrames).toHaveLength(1);

      // 2. Backend failure must close socket WITHOUT sending 4-byte ACK so FMC130 keeps buffered flash
      ingestShouldFail = true;
      const bytesReceivedAfterFailure = await new Promise<number>((resolve, reject) => {
        const client = net.connect(tcpAddr.port, '127.0.0.1', () => {
          client.write(encodeTeltonikaImeiPacket('356307042441013'));
        });
        let phase: 'imei' | 'ack' = 'imei';
        let postFrameBytes = 0;
        client.on('data', (data) => {
          if (phase === 'imei') {
            phase = 'ack';
            client.write(frame);
          } else {
            postFrameBytes += data.length;
          }
        });
        client.on('close', () => resolve(postFrameBytes));
        client.on('error', reject);
      });
      expect(bytesReceivedAfterFailure).toBe(0);
    } finally {
      await tcpServer.stop();
      await new Promise<void>((resolve) => mockBackend.close(() => resolve()));
    }
  });
});
