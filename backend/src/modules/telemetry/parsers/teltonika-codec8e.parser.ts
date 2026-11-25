import { BadRequestException } from '@nestjs/common';

export const TELTONIKA_CODEC_8E_ID = 0x8e;
export const MAX_CODEC8E_PACKET_BYTES = 65_536;

export interface EyeSensorIoReadings {
  slot: number;
  cargoTempC: number | null;
  humidityPct: number | null;
  doorOpen: boolean | null;
  movement: boolean | null;
  batteryMv: number | null;
}

export interface ParsedCodec8eRecord {
  capturedAt: Date;
  priority: number;
  latitude: number | null;
  longitude: number | null;
  altitudeM: number;
  angleDeg: number;
  satellites: number;
  speedKph: number;
  gnssValid: boolean;
  eventIoId: number;
  gsmSignal: number | null;
  externalVoltageMv: number | null;
  trackerBatteryMv: number | null;
  eyeSensors: Record<number, EyeSensorIoReadings>;
  rawIoHex: Record<string, string>;
}

export interface ParsedCodec8ePacket {
  codecId: number;
  recordCount: number;
  crcHex: string;
  records: ParsedCodec8eRecord[];
}

export interface Codec8eEncodeRecordInput {
  capturedAt: Date;
  priority?: number;
  latitude?: number | null;
  longitude?: number | null;
  altitudeM?: number;
  angleDeg?: number;
  satellites?: number;
  speedKph?: number;
  eventIoId?: number;
  io1?: Array<{ id: number; value: number }>;
  io2?: Array<{ id: number; value: number; signed?: boolean }>;
  io4?: Array<{ id: number; value: number }>;
  io8?: Array<{ id: number; value: bigint }>;
}

/**
 * Standard CRC-16/IBM (ARC, polynomial 0xA001, init 0x0000) used by Teltonika
 * FMC/FMB devices on Codec 8 and Codec 8 Extended AVL frames.
 */
export function crc16Ibm(buffer: Buffer): number {
  let crc = 0x0000;
  for (let i = 0; i < buffer.length; i += 1) {
    crc ^= buffer[i]!;
    for (let bit = 0; bit < 8; bit += 1) {
      if ((crc & 0x0001) !== 0) {
        crc = (crc >>> 1) ^ 0xa001;
      } else {
        crc >>>= 1;
      }
    }
  }
  return crc & 0xffff;
}

export function encodeTeltonikaImeiPacket(imei: string): Buffer {
  if (!/^\d{15}$/.test(imei)) {
    throw new BadRequestException('Teltonika IMEI must be exactly 15 numeric digits');
  }
  const imeiBuf = Buffer.from(imei, 'ascii');
  const frame = Buffer.alloc(2 + imeiBuf.length);
  frame.writeUInt16BE(imeiBuf.length, 0);
  imeiBuf.copy(frame, 2);
  return frame;
}

export function parseTeltonikaImeiPacket(buffer: Buffer): { imei: string; bytesConsumed: number } {
  if (buffer.length < 2) {
    throw new BadRequestException('Incomplete Teltonika IMEI packet header');
  }
  const len = buffer.readUInt16BE(0);
  if (len < 15 || len > 20 || buffer.length < 2 + len) {
    throw new BadRequestException(`Invalid or incomplete Teltonika IMEI packet length: ${len}`);
  }
  const imei = buffer.subarray(2, 2 + len).toString('ascii');
  if (!/^\d{15,20}$/.test(imei)) {
    throw new BadRequestException('Teltonika IMEI handshake must contain numeric digits');
  }
  return { imei, bytesConsumed: 2 + len };
}

function readSignedTempFrom2ByteBuffer(buf: Buffer): number | null {
  const raw = buf.readInt16BE(0);
  // Teltonika EYE Sensor / BLE protocol reserves -32768 (0x8000) and 32767 (0x7FFF) for probe error / N/A.
  if (raw === -32768 || raw === 32767) {
    return null;
  }
  const tempC = Number((raw * 0.01).toFixed(2));
  if (tempC < -80 || tempC > 85) {
    return null;
  }
  return tempC;
}

function readIoUnsigned(buf: Buffer): number {
  if (buf.length === 1) return buf.readUInt8(0);
  if (buf.length === 2) return buf.readUInt16BE(0);
  if (buf.length === 4) return buf.readUInt32BE(0);
  return 0;
}

function normalizeEyeBatteryMv(buf: Buffer): number | null {
  const raw = readIoUnsigned(buf);
  if (buf.length === 1) {
    if (raw === 0xff) return null;
    // Some EYE telemetry mappings report battery in 10 mV steps above 2.0V when encoded in 1 byte.
    return raw <= 200 ? 2000 + raw * 10 : raw * 10;
  }
  if (raw === 0xffff) return null;
  return raw;
}

function extractEyeSensors(ioBuffers: Map<number, Buffer>): Record<number, EyeSensorIoReadings> {
  const result: Record<number, EyeSensorIoReadings> = {};
  for (let slot = 1; slot <= 4; slot += 1) {
    const offset = slot - 1;
    const tempBuf = ioBuffers.get(10800 + offset);
    const humidityBuf = ioBuffers.get(10804 + offset);
    const magnetBuf = ioBuffers.get(10808 + offset);
    const movementBuf = ioBuffers.get(10812 + offset);
    const batteryBuf = ioBuffers.get(10816 + offset);

    if (!tempBuf && !humidityBuf && !magnetBuf && !movementBuf && !batteryBuf) {
      continue;
    }

    const cargoTempC = tempBuf && tempBuf.length === 2 ? readSignedTempFrom2ByteBuffer(tempBuf) : null;
    let humidityPct: number | null = null;
    if (humidityBuf) {
      const hRaw = readIoUnsigned(humidityBuf);
      if (hRaw >= 0 && hRaw <= 100) {
        humidityPct = hRaw;
      }
    }

    result[slot] = {
      slot,
      cargoTempC,
      humidityPct,
      doorOpen: magnetBuf ? readIoUnsigned(magnetBuf) !== 0 : null,
      movement: movementBuf ? readIoUnsigned(movementBuf) !== 0 : null,
      batteryMv: batteryBuf ? normalizeEyeBatteryMv(batteryBuf) : null,
    };
  }
  return result;
}

export function parseTeltonikaCodec8ePacket(buffer: Buffer): ParsedCodec8ePacket {
  if (!Buffer.isBuffer(buffer) || buffer.length < 16) {
    throw new BadRequestException('Teltonika Codec 8 Extended frame is too short');
  }
  if (buffer.length > MAX_CODEC8E_PACKET_BYTES) {
    throw new BadRequestException('Teltonika Codec 8 Extended frame exceeds 64 KiB limit');
  }

  const preamble = buffer.readUInt32BE(0);
  if (preamble !== 0) {
    throw new BadRequestException(`Invalid Teltonika preamble: 0x${preamble.toString(16)}`);
  }

  const dataFieldLength = buffer.readUInt32BE(4);
  const expectedTotalLength = 8 + dataFieldLength + 4;
  if (dataFieldLength < 3 || buffer.length !== expectedTotalLength) {
    throw new BadRequestException(
      `Teltonika packet length mismatch: declared ${expectedTotalLength}, got ${buffer.length}`,
    );
  }

  const codecId = buffer.readUInt8(8);
  if (codecId !== TELTONIKA_CODEC_8E_ID) {
    throw new BadRequestException(
      `Unsupported Teltonika codecId 0x${codecId.toString(16)}; configure tracker for Codec 8 Extended (0x8E)`,
    );
  }

  const crcStart = 8;
  const crcEnd = 8 + dataFieldLength;
  const declaredCrc = buffer.readUInt32BE(crcEnd) & 0xffff;
  const computedCrc = crc16Ibm(buffer.subarray(crcStart, crcEnd));
  if (declaredCrc !== computedCrc) {
    throw new BadRequestException(
      `Teltonika Codec 8 Extended CRC-16 mismatch: declared 0x${declaredCrc.toString(16)}, computed 0x${computedCrc.toString(16)}`,
    );
  }

  const recordCount = buffer.readUInt8(9);
  let cursor = 10;
  const records: ParsedCodec8eRecord[] = [];

  const ensureBytes = (need: number): void => {
    if (cursor + need > crcEnd - 1) {
      throw new BadRequestException('Truncated Teltonika Codec 8 Extended AVL record');
    }
  };

  for (let i = 0; i < recordCount; i += 1) {
    ensureBytes(8 + 1 + 15 + 4);
    const tsMs = buffer.readBigUInt64BE(cursor);
    cursor += 8;
    const timestampNumber = Number(tsMs);
    if (!Number.isFinite(timestampNumber) || timestampNumber <= 0) {
      throw new BadRequestException('Invalid capture timestamp in Teltonika AVL record');
    }
    const capturedAt = new Date(timestampNumber);
    const priority = buffer.readUInt8(cursor);
    cursor += 1;

    // GPS element (15 bytes): lng (int32/1e7), lat (int32/1e7), alt (int16), angle (uint16), sat (uint8), speed (uint16)
    const lonRaw = buffer.readInt32BE(cursor);
    const latRaw = buffer.readInt32BE(cursor + 4);
    const altitudeM = buffer.readInt16BE(cursor + 8);
    const angleDeg = buffer.readUInt16BE(cursor + 10);
    const satellites = buffer.readUInt8(cursor + 12);
    const speedKph = buffer.readUInt16BE(cursor + 13);
    cursor += 15;

    const rawLat = latRaw / 1e7;
    const rawLng = lonRaw / 1e7;
    const gnssValid =
      satellites > 0 &&
      !(latRaw === 0 && lonRaw === 0) &&
      Math.abs(rawLat) <= 90 &&
      Math.abs(rawLng) <= 180;

    // Codec 8E uses 2-byte event IO ID and 2-byte counts/IDs across N1/N2/N4/N8/NX.
    const eventIoId = buffer.readUInt16BE(cursor);
    cursor += 2;
    const _totalIo = buffer.readUInt16BE(cursor);
    cursor += 2;

    const ioBuffers = new Map<number, Buffer>();
    const rawIoHex: Record<string, string> = {};

    const fixedSizes = [1, 2, 4, 8] as const;
    for (const byteSize of fixedSizes) {
      ensureBytes(2);
      const count = buffer.readUInt16BE(cursor);
      cursor += 2;
      ensureBytes(count * (2 + byteSize));
      for (let idx = 0; idx < count; idx += 1) {
        const ioId = buffer.readUInt16BE(cursor);
        cursor += 2;
        const valBuf = buffer.subarray(cursor, cursor + byteSize);
        cursor += byteSize;
        ioBuffers.set(ioId, Buffer.from(valBuf));
        rawIoHex[String(ioId)] = valBuf.toString('hex');
      }
    }

    ensureBytes(2);
    const nxCount = buffer.readUInt16BE(cursor);
    cursor += 2;
    for (let idx = 0; idx < nxCount; idx += 1) {
      ensureBytes(4);
      const ioId = buffer.readUInt16BE(cursor);
      const valLen = buffer.readUInt16BE(cursor + 2);
      cursor += 4;
      ensureBytes(valLen);
      const valBuf = buffer.subarray(cursor, cursor + valLen);
      cursor += valLen;
      ioBuffers.set(ioId, Buffer.from(valBuf));
      rawIoHex[String(ioId)] = valBuf.toString('hex');
    }

    const eyeSensors = extractEyeSensors(ioBuffers);
    const gsmBuf = ioBuffers.get(21);
    const extVoltBuf = ioBuffers.get(66);
    const battVoltBuf = ioBuffers.get(67);

    records.push({
      capturedAt,
      priority,
      latitude: gnssValid ? rawLat : null,
      longitude: gnssValid ? rawLng : null,
      altitudeM,
      angleDeg,
      satellites,
      speedKph,
      gnssValid,
      eventIoId,
      gsmSignal: gsmBuf ? readIoUnsigned(gsmBuf) : null,
      externalVoltageMv: extVoltBuf ? readIoUnsigned(extVoltBuf) : null,
      trackerBatteryMv: battVoltBuf ? readIoUnsigned(battVoltBuf) : null,
      eyeSensors,
      rawIoHex,
    });
  }

  if (cursor + 1 !== crcEnd) {
    throw new BadRequestException('Trailing bytes found before recordCount2 in Codec 8E frame');
  }
  const recordCount2 = buffer.readUInt8(cursor);
  if (recordCount2 !== recordCount) {
    throw new BadRequestException(
      `Teltonika Codec 8 Extended recordCount mismatch: header=${recordCount}, trailer=${recordCount2}`,
    );
  }

  return {
    codecId,
    recordCount,
    crcHex: declaredCrc.toString(16).padStart(4, '0'),
    records,
  };
}

/**
 * Encodes a valid Teltonika Codec 8 Extended (0x8E) binary frame (used by unit tests
 * and staging verification scripts).
 */
export function encodeTeltonikaCodec8ePacket(records: Codec8eEncodeRecordInput[]): Buffer {
  const chunks: Buffer[] = [];
  const hdr = Buffer.alloc(2);
  hdr.writeUInt8(TELTONIKA_CODEC_8E_ID, 0);
  hdr.writeUInt8(records.length, 1);
  chunks.push(hdr);

  for (const rec of records) {
    const base = Buffer.alloc(8 + 1 + 15 + 4);
    base.writeBigUInt64BE(BigInt(rec.capturedAt.getTime()), 0);
    base.writeUInt8(rec.priority ?? 0, 8);
    const lonInt = rec.longitude != null ? Math.round(rec.longitude * 1e7) : 0;
    const latInt = rec.latitude != null ? Math.round(rec.latitude * 1e7) : 0;
    base.writeInt32BE(lonInt, 9);
    base.writeInt32BE(latInt, 13);
    base.writeInt16BE(rec.altitudeM ?? 10, 17);
    base.writeUInt16BE(rec.angleDeg ?? 0, 19);
    base.writeUInt8(rec.satellites ?? (rec.latitude != null ? 9 : 0), 21);
    base.writeUInt16BE(rec.speedKph ?? 0, 22);
    const io1 = rec.io1 ?? [];
    const io2 = rec.io2 ?? [];
    const io4 = rec.io4 ?? [];
    const io8 = rec.io8 ?? [];
    base.writeUInt16BE(rec.eventIoId ?? 0, 24);
    base.writeUInt16BE(io1.length + io2.length + io4.length + io8.length, 26);
    chunks.push(base);

    const n1 = Buffer.alloc(2 + io1.length * 3);
    n1.writeUInt16BE(io1.length, 0);
    io1.forEach((entry, idx) => {
      const off = 2 + idx * 3;
      n1.writeUInt16BE(entry.id, off);
      n1.writeUInt8(entry.value & 0xff, off + 2);
    });
    chunks.push(n1);

    const n2 = Buffer.alloc(2 + io2.length * 4);
    n2.writeUInt16BE(io2.length, 0);
    io2.forEach((entry, idx) => {
      const off = 2 + idx * 4;
      n2.writeUInt16BE(entry.id, off);
      if (entry.signed ?? entry.value < 0) {
        n2.writeInt16BE(entry.value, off + 2);
      } else {
        n2.writeUInt16BE(entry.value & 0xffff, off + 2);
      }
    });
    chunks.push(n2);

    const n4 = Buffer.alloc(2 + io4.length * 6);
    n4.writeUInt16BE(io4.length, 0);
    io4.forEach((entry, idx) => {
      const off = 2 + idx * 6;
      n4.writeUInt16BE(entry.id, off);
      n4.writeUInt32BE(entry.value >>> 0, off + 2);
    });
    chunks.push(n4);

    const n8 = Buffer.alloc(2 + io8.length * 10);
    n8.writeUInt16BE(io8.length, 0);
    io8.forEach((entry, idx) => {
      const off = 2 + idx * 10;
      n8.writeUInt16BE(entry.id, off);
      n8.writeBigUInt64BE(entry.value, off + 2);
    });
    chunks.push(n8);

    const nx = Buffer.alloc(2);
    nx.writeUInt16BE(0, 0);
    chunks.push(nx);
  }

  const trailerCount = Buffer.alloc(1);
  trailerCount.writeUInt8(records.length, 0);
  chunks.push(trailerCount);

  const dataField = Buffer.concat(chunks);
  const crc = crc16Ibm(dataField);

  const preamble = Buffer.alloc(8);
  preamble.writeUInt32BE(0, 0);
  preamble.writeUInt32BE(dataField.length, 4);

  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc, 0);

  return Buffer.concat([preamble, dataField, crcBuf]);
}
