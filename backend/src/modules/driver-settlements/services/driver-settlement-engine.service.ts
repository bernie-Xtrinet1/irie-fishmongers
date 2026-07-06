import { Injectable } from '@nestjs/common';
import { ProductUnit, SettlementRateConfig, VehicleOwnership } from '@prisma/client';

const KG_TO_LBS = 2.20462;
const JAMAICA_UTC_OFFSET_HOURS = -5;
const EARTH_RADIUS_KM = 6371;

export interface DeliveryCompensationInput {
  vehicleOwnership: VehicleOwnership;
  distanceKm: number;
  items: { unit: ProductUnit; quantity: number }[];
  deliveredAt: Date;
}

export interface DeliveryCompensationResult {
  baseFee: number;
  distanceFee: number;
  heavyLoadBonus: number;
  peakBonus: number;
}

export interface GeoPoint {
  latitude: number;
  longitude: number;
}

/**
 * Isolated compensation math per docs/integrations/driver-settlement-engine.md's
 * Implementation Directive: business services must use this engine and must
 * never compute driver payouts themselves.
 */
@Injectable()
export class DriverSettlementEngine {
  computeDistanceKm(locations: GeoPoint[]): number {
    if (locations.length < 2) {
      return 0;
    }

    let total = 0;
    for (let i = 1; i < locations.length; i += 1) {
      total += DriverSettlementEngine.haversineKm(locations[i - 1]!, locations[i]!);
    }
    return total;
  }

  computeDeliveryCompensation(
    input: DeliveryCompensationInput,
    rateConfig: SettlementRateConfig,
  ): DeliveryCompensationResult {
    const baseFee = rateConfig.baseFee.toNumber();

    const distanceFee =
      input.vehicleOwnership === 'PERSONAL_VEHICLE' && rateConfig.distanceCompensationEnabled
        ? input.distanceKm * rateConfig.distanceRatePerKm.toNumber()
        : 0;

    const poundsEquivalent = DriverSettlementEngine.computePoundsEquivalent(input.items);
    const heavyLoadBonus =
      poundsEquivalent > rateConfig.heavyLoadThresholdLbs.toNumber()
        ? rateConfig.heavyLoadBonus.toNumber()
        : 0;

    const peakBonus = DriverSettlementEngine.isJamaicaWeekend(input.deliveredAt)
      ? rateConfig.peakBonus.toNumber()
      : 0;

    return { baseFee, distanceFee, heavyLoadBonus, peakBonus };
  }

  computeVolumeBonus(completedDeliveryCount: number, rateConfig: SettlementRateConfig): number {
    if (completedDeliveryCount >= rateConfig.volumeBonusTier3Threshold) {
      return rateConfig.volumeBonusTier3Amount.toNumber();
    }
    if (completedDeliveryCount >= rateConfig.volumeBonusTier2Threshold) {
      return rateConfig.volumeBonusTier2Amount.toNumber();
    }
    if (completedDeliveryCount >= rateConfig.volumeBonusTier1Threshold) {
      return rateConfig.volumeBonusTier1Amount.toNumber();
    }
    return 0;
  }

  private static computePoundsEquivalent(
    items: { unit: ProductUnit; quantity: number }[],
  ): number {
    return items.reduce((total, item) => {
      if (item.unit === 'PER_POUND') {
        return total + item.quantity;
      }
      if (item.unit === 'PER_KILOGRAM') {
        return total + item.quantity * KG_TO_LBS;
      }
      return total;
    }, 0);
  }

  private static isJamaicaWeekend(date: Date): boolean {
    const jamaicaTime = new Date(date.getTime() + JAMAICA_UTC_OFFSET_HOURS * 60 * 60 * 1000);
    const day = jamaicaTime.getUTCDay();
    return day === 0 || day === 6;
  }

  private static haversineKm(a: GeoPoint, b: GeoPoint): number {
    const toRad = (deg: number): number => (deg * Math.PI) / 180;
    const dLat = toRad(b.latitude - a.latitude);
    const dLon = toRad(b.longitude - a.longitude);
    const lat1 = toRad(a.latitude);
    const lat2 = toRad(b.latitude);

    const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
    const c = 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
    return EARTH_RADIUS_KM * c;
  }
}
