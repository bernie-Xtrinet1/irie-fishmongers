import { BadRequestException } from '@nestjs/common';

import {
  normalizeTeltonikaCodecJson,
  parseEyeAppRecoveryCsv,
} from './teltonika-payload.normalizer';

describe('TeltonikaPayloadNormalizer', () => {
  it('normalizes Teltonika Codec JSON shadow payloads including signed EYE sensor centidegrees', () => {
    const records = normalizeTeltonikaCodecJson({
      state: {
        reported: {
          ts: 1764064800000,
          latlng: '17.99702,-76.79358',
          sat: 9,
          sp: 42,
          ang: 90,
          alt: 15,
          '21': 5,
          '66': 13450,
          '10800': 275,
          '10801': -1925,
          '10804': 72,
          '10808': 1,
        },
      },
    });

    expect(records).toHaveLength(1);
    expect(records[0]?.latitude).toBeCloseTo(17.99702, 5);
    expect(records[0]?.longitude).toBeCloseTo(-76.79358, 5);
    expect(records[0]?.gnssValid).toBe(true);
    expect(records[0]?.eyeSensors[1]).toMatchObject({
      cargoTempC: 2.75,
      humidityPct: 72,
      doorOpen: true,
    });
    expect(records[0]?.eyeSensors[2]?.cargoTempC).toBe(-19.25);
  });

  it('parses semicolon-delimited EYE App EN12830 CSV exports in chronological order', () => {
    const rows = parseEyeAppRecoveryCsv(
      [
        'Date;Time;Temperature [C];Humidity [%];Battery [V]',
        '2026-11-25;10:15:00;9.4;81;2.95',
        '2026-11-25;10:05:00;2.1;76;2.96',
      ].join('\n'),
    );

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      lineNumber: 3,
      temperatureC: 2.1,
      humidityPct: 76,
      batteryMv: 2960,
    });
    expect(rows[1]?.temperatureC).toBe(9.4);
  });

  it('rejects malformed EYE App CSV rows with a line-numbered error', () => {
    expect(() =>
      parseEyeAppRecoveryCsv(
        ['Timestamp,Temperature', '2026-11-25T10:00:00Z,not-a-number'].join('\n'),
      ),
    ).toThrow(BadRequestException);
  });
});
