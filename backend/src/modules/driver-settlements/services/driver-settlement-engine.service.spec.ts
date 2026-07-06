import { Prisma, SettlementRateConfig } from '@prisma/client';

import { DriverSettlementEngine } from './driver-settlement-engine.service';

function buildRateConfig(overrides: Partial<SettlementRateConfig> = {}): SettlementRateConfig {
  return {
    id: 'rate-config-1',
    baseFee: new Prisma.Decimal(150),
    distanceCompensationEnabled: true,
    distanceRatePerKm: new Prisma.Decimal(20),
    heavyLoadThresholdLbs: new Prisma.Decimal(50),
    heavyLoadBonus: new Prisma.Decimal(200),
    peakBonus: new Prisma.Decimal(100),
    volumeBonusTier1Threshold: 20,
    volumeBonusTier1Amount: new Prisma.Decimal(1000),
    volumeBonusTier2Threshold: 40,
    volumeBonusTier2Amount: new Prisma.Decimal(3000),
    volumeBonusTier3Threshold: 60,
    volumeBonusTier3Amount: new Prisma.Decimal(5000),
    createdAt: new Date(),
    ...overrides,
  };
}

describe('DriverSettlementEngine', () => {
  const engine = new DriverSettlementEngine();

  describe('computeDistanceKm', () => {
    it('returns 0 for fewer than two points', () => {
      expect(engine.computeDistanceKm([])).toBe(0);
      expect(engine.computeDistanceKm([{ latitude: 18, longitude: -76.8 }])).toBe(0);
    });

    it('computes the haversine distance between two points', () => {
      // Roughly 1 degree of latitude apart (~111 km).
      const distance = engine.computeDistanceKm([
        { latitude: 17.9, longitude: -76.8 },
        { latitude: 18.9, longitude: -76.8 },
      ]);
      expect(distance).toBeGreaterThan(105);
      expect(distance).toBeLessThan(115);
    });

    it('sums consecutive segments across multiple points', () => {
      const twoPointDistance = engine.computeDistanceKm([
        { latitude: 17.9, longitude: -76.8 },
        { latitude: 18.9, longitude: -76.8 },
      ]);
      const threePointDistance = engine.computeDistanceKm([
        { latitude: 17.9, longitude: -76.8 },
        { latitude: 18.4, longitude: -76.8 },
        { latitude: 18.9, longitude: -76.8 },
      ]);
      expect(threePointDistance).toBeCloseTo(twoPointDistance, 0);
    });
  });

  describe('computeDeliveryCompensation', () => {
    it('includes distance compensation for a personal vehicle when enabled', () => {
      const rateConfig = buildRateConfig();
      const result = engine.computeDeliveryCompensation(
        {
          vehicleOwnership: 'PERSONAL_VEHICLE',
          distanceKm: 12,
          items: [{ unit: 'PER_POUND', quantity: 10 }],
          deliveredAt: new Date('2026-07-01T15:00:00.000Z'), // Wednesday Jamaica-local
        },
        rateConfig,
      );

      expect(result.baseFee).toBe(150);
      expect(result.distanceFee).toBe(240);
      expect(result.heavyLoadBonus).toBe(0);
      expect(result.peakBonus).toBe(0);
    });

    it('omits distance compensation for a company vehicle', () => {
      const rateConfig = buildRateConfig();
      const result = engine.computeDeliveryCompensation(
        {
          vehicleOwnership: 'COMPANY_VEHICLE',
          distanceKm: 12,
          items: [],
          deliveredAt: new Date('2026-07-01T15:00:00.000Z'),
        },
        rateConfig,
      );
      expect(result.distanceFee).toBe(0);
    });

    it('omits distance compensation for a personal vehicle when disabled', () => {
      const rateConfig = buildRateConfig({ distanceCompensationEnabled: false });
      const result = engine.computeDeliveryCompensation(
        {
          vehicleOwnership: 'PERSONAL_VEHICLE',
          distanceKm: 12,
          items: [],
          deliveredAt: new Date('2026-07-01T15:00:00.000Z'),
        },
        rateConfig,
      );
      expect(result.distanceFee).toBe(0);
    });

    it('applies the heavy load bonus when pounds-equivalent weight exceeds the threshold', () => {
      const rateConfig = buildRateConfig();
      const result = engine.computeDeliveryCompensation(
        {
          vehicleOwnership: 'COMPANY_VEHICLE',
          distanceKm: 0,
          items: [{ unit: 'PER_POUND', quantity: 51 }],
          deliveredAt: new Date('2026-07-01T15:00:00.000Z'),
        },
        rateConfig,
      );
      expect(result.heavyLoadBonus).toBe(200);
    });

    it('does not apply the heavy load bonus at or below the threshold', () => {
      const rateConfig = buildRateConfig();
      const result = engine.computeDeliveryCompensation(
        {
          vehicleOwnership: 'COMPANY_VEHICLE',
          distanceKm: 0,
          items: [{ unit: 'PER_POUND', quantity: 50 }],
          deliveredAt: new Date('2026-07-01T15:00:00.000Z'),
        },
        rateConfig,
      );
      expect(result.heavyLoadBonus).toBe(0);
    });

    it('converts kilogram-unit items to pounds when evaluating the heavy load threshold', () => {
      const rateConfig = buildRateConfig();
      // 23 kg ~= 50.7 lbs, just over the 50 lb threshold.
      const result = engine.computeDeliveryCompensation(
        {
          vehicleOwnership: 'COMPANY_VEHICLE',
          distanceKm: 0,
          items: [{ unit: 'PER_KILOGRAM', quantity: 23 }],
          deliveredAt: new Date('2026-07-01T15:00:00.000Z'),
        },
        rateConfig,
      );
      expect(result.heavyLoadBonus).toBe(200);
    });

    it('does not count package or item units toward the heavy load threshold', () => {
      const rateConfig = buildRateConfig();
      const result = engine.computeDeliveryCompensation(
        {
          vehicleOwnership: 'COMPANY_VEHICLE',
          distanceKm: 0,
          items: [
            { unit: 'PER_PACKAGE', quantity: 500 },
            { unit: 'PER_ITEM', quantity: 500 },
          ],
          deliveredAt: new Date('2026-07-01T15:00:00.000Z'),
        },
        rateConfig,
      );
      expect(result.heavyLoadBonus).toBe(0);
    });

    it('applies the peak bonus for a Jamaica-local weekend delivery', () => {
      const rateConfig = buildRateConfig();
      // 2026-07-04 is a Saturday. Midday UTC keeps the same Jamaica-local day.
      const result = engine.computeDeliveryCompensation(
        {
          vehicleOwnership: 'COMPANY_VEHICLE',
          distanceKm: 0,
          items: [],
          deliveredAt: new Date('2026-07-04T15:00:00.000Z'),
        },
        rateConfig,
      );
      expect(result.peakBonus).toBe(100);
    });

    it('does not apply the peak bonus for a Jamaica-local weekday delivery', () => {
      const rateConfig = buildRateConfig();
      const result = engine.computeDeliveryCompensation(
        {
          vehicleOwnership: 'COMPANY_VEHICLE',
          distanceKm: 0,
          items: [],
          deliveredAt: new Date('2026-07-01T15:00:00.000Z'), // Wednesday
        },
        rateConfig,
      );
      expect(result.peakBonus).toBe(0);
    });

    it('uses the Jamaica-local day, not the UTC day, near midnight boundaries', () => {
      const rateConfig = buildRateConfig();
      // 2026-07-04T02:00:00Z is Saturday in UTC, but Jamaica (UTC-5) is still
      // 2026-07-03 21:00 - a Friday - so the peak bonus should not apply.
      const result = engine.computeDeliveryCompensation(
        {
          vehicleOwnership: 'COMPANY_VEHICLE',
          distanceKm: 0,
          items: [],
          deliveredAt: new Date('2026-07-04T02:00:00.000Z'),
        },
        rateConfig,
      );
      expect(result.peakBonus).toBe(0);
    });
  });

  describe('computeVolumeBonus', () => {
    const rateConfig = buildRateConfig();

    it('returns 0 below the first tier', () => {
      expect(engine.computeVolumeBonus(19, rateConfig)).toBe(0);
    });

    it('returns the tier 1 amount at the tier 1 threshold', () => {
      expect(engine.computeVolumeBonus(20, rateConfig)).toBe(1000);
    });

    it('returns the tier 1 amount between tier 1 and tier 2', () => {
      expect(engine.computeVolumeBonus(39, rateConfig)).toBe(1000);
    });

    it('returns the tier 2 amount at the tier 2 threshold', () => {
      expect(engine.computeVolumeBonus(40, rateConfig)).toBe(3000);
    });

    it('returns the tier 3 amount at and above the tier 3 threshold', () => {
      expect(engine.computeVolumeBonus(60, rateConfig)).toBe(5000);
      expect(engine.computeVolumeBonus(100, rateConfig)).toBe(5000);
    });
  });
});
