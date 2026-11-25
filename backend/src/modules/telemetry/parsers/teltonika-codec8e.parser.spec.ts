import { BadRequestException } from '@nestjs/common';

import {
  crc16Ibm,
  encodeTeltonikaCodec8ePacket,
  encodeTeltonikaImeiPacket,
  parseTeltonikaCodec8ePacket,
  parseTeltonikaImeiPacket,
} from './teltonika-codec8e.parser';

describe('TeltonikaCodec8eParser', () => {
  it('parses and encodes 15-digit IMEI handshakes', () => {
    const packet = encodeTeltonikaImeiPacket('356307042441013');
    const parsed = parseTeltonikaImeiPacket(packet);

    expect(parsed).toEqual({
      imei: '356307042441013',
      bytesConsumed: 17,
    });
  });

  it('decodes multi-record Codec 8 Extended frames with positive and sub-zero EYE Sensor BTSMP1 temperatures', () => {
    const frame = encodeTeltonikaCodec8ePacket([
      {
        capturedAt: new Date('2026-11-25T10:00:00.000Z'),
        latitude: 17.99702,
        longitude: -76.79358,
        satellites: 11,
        speedKph: 48,
        angleDeg: 145,
        altitudeM: 12,
        io1: [
          { id: 21, value: 4 }, // GSM signal
          { id: 10804, value: 78 }, // EYE Slot 1 humidity 78%
          { id: 10808, value: 0 }, // Door closed
          { id: 10812, value: 1 }, // Movement active
          { id: 10816, value: 95 }, // 2950 mV
        ],
        io2: [
          { id: 66, value: 13800 }, // External power 13.8V
          { id: 10800, value: 245, signed: true }, // +2.45 C
          { id: 10801, value: -1850, signed: true }, // -18.50 C frozen slot 2
        ],
      },
      {
        capturedAt: new Date('2026-11-25T10:01:00.000Z'),
        latitude: null,
        longitude: null,
        satellites: 0,
        speedKph: 0,
        io2: [
          { id: 10800, value: -32768, signed: true }, // Error sentinel 0x8000 -> missing reading
        ],
      },
    ]);

    const parsed = parseTeltonikaCodec8ePacket(frame);

    expect(parsed.codecId).toBe(0x8e);
    expect(parsed.recordCount).toBe(2);
    expect(parsed.records).toHaveLength(2);

    const first = parsed.records[0]!;
    expect(first.capturedAt.toISOString()).toBe('2026-11-25T10:00:00.000Z');
    expect(first.gnssValid).toBe(true);
    expect(first.latitude).toBeCloseTo(17.99702, 5);
    expect(first.longitude).toBeCloseTo(-76.79358, 5);
    expect(first.speedKph).toBe(48);
    expect(first.gsmSignal).toBe(4);
    expect(first.externalVoltageMv).toBe(13800);
    expect(first.eyeSensors[1]).toEqual({
      slot: 1,
      cargoTempC: 2.45,
      humidityPct: 78,
      doorOpen: false,
      movement: true,
      batteryMv: 2950,
    });
    expect(first.eyeSensors[2]?.cargoTempC).toBe(-18.5);

    const second = parsed.records[1]!;
    expect(second.gnssValid).toBe(false);
    expect(second.latitude).toBeNull();
    expect(second.longitude).toBeNull();
    expect(second.eyeSensors[1]?.cargoTempC).toBeNull();
  });

  it('rejects corrupted CRC-16 frames cleanly so FMC130 keeps buffered records', () => {
    const frame = encodeTeltonikaCodec8ePacket([
      {
        capturedAt: new Date('2026-11-25T10:05:00.000Z'),
        latitude: 18.01,
        longitude: -76.8,
        satellites: 8,
        io2: [{ id: 10800, value: 310, signed: true }],
      },
    ]);

    const expectedCrc = crc16Ibm(frame.subarray(8, frame.length - 4));
    expect(frame.readUInt32BE(frame.length - 4) & 0xffff).toBe(expectedCrc);

    // Flip 1 bit in CRC
    frame.writeUInt8(frame.readUInt8(frame.length - 1) ^ 0x01, frame.length - 1);
    expect(() => parseTeltonikaCodec8ePacket(frame)).toThrow(BadRequestException);
  });

  it('rejects non-0x8E legacy Codec 8 frames with an explicit configuration error', () => {
    const frame = encodeTeltonikaCodec8ePacket([
      {
        capturedAt: new Date('2026-11-25T10:05:00.000Z'),
        latitude: 18.01,
        longitude: -76.8,
      },
    ]);
    frame[8] = 0x08;
    const newCrc = crc16Ibm(frame.subarray(8, frame.length - 4));
    frame.writeUInt32BE(newCrc, frame.length - 4);

    expect(() => parseTeltonikaCodec8ePacket(frame)).toThrow(/Codec 8 Extended/);
  });
});
