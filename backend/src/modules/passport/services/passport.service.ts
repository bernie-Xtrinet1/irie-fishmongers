import { Injectable, NotFoundException } from '@nestjs/common';
import { AlertSeverity } from '@prisma/client';

import { CatchItemsRepository } from '../../catches/repositories/catch-items.repository';
import { FishermenRepository } from '../../catches/repositories/fishermen.repository';
import { LandingSitesRepository } from '../../catches/repositories/landing-sites.repository';
import { SpeciesRepository } from '../../catches/repositories/species.repository';
import { VesselsRepository } from '../../catches/repositories/vessels.repository';
import { isSpeciesInSeason } from '../../catches/utils/species-validation.util';
import { DriversRepository } from '../../delivery/repositories/drivers.repository';
import { CustodyEventsRepository } from '../../food-safety/repositories/custody-events.repository';
import { RegulatoryAuthoritiesRepository } from '../../food-safety/repositories/regulatory-authorities.repository';
import { RegulatoryCertificationsRepository } from '../../food-safety/repositories/regulatory-certifications.repository';
import { SeafoodLotsRepository } from '../../food-safety/repositories/seafood-lots.repository';
import { TemperatureAlertsRepository } from '../../food-safety/repositories/temperature-alerts.repository';
import { TemperatureReadingsRepository } from '../../food-safety/repositories/temperature-readings.repository';
import { VendorsRepository } from '../../vendors/repositories/vendors.repository';
import {
  DigitalProductPassportEntity,
  PassportCustodyRole,
} from '../entities/digital-product-passport.entity';

const PASSPORT_VERSION = '1.0.0';

// Severity ranking for coldChainSummary.worstSeverity - matches
// AlertSeverity's own escalation order (evaluateSeverity in
// TemperatureMonitoringService).
const SEVERITY_RANK: Record<AlertSeverity, number> = { WARNING: 1, CRITICAL: 2, EMERGENCY: 3 };

@Injectable()
export class PassportService {
  constructor(
    private readonly lotsRepository: SeafoodLotsRepository,
    private readonly alertsRepository: TemperatureAlertsRepository,
    private readonly readingsRepository: TemperatureReadingsRepository,
    private readonly catchItemsRepository: CatchItemsRepository,
    private readonly fishermenRepository: FishermenRepository,
    private readonly vesselsRepository: VesselsRepository,
    private readonly landingSitesRepository: LandingSitesRepository,
    private readonly speciesRepository: SpeciesRepository,
    private readonly custodyEventsRepository: CustodyEventsRepository,
    private readonly certificationsRepository: RegulatoryCertificationsRepository,
    private readonly authoritiesRepository: RegulatoryAuthoritiesRepository,
    private readonly vendorsRepository: VendorsRepository,
    private readonly driversRepository: DriversRepository,
  ) {}

  async getByToken(token: string): Promise<DigitalProductPassportEntity> {
    const lot = await this.lotsRepository.findByPublicTraceToken(token);
    if (!lot) {
      throw new NotFoundException('Passport not found');
    }

    const [unresolvedAlertCount, totalReadings, unresolvedAlerts, custodyEvents] = await Promise.all([
      this.alertsRepository.countUnresolvedByLotId(lot.id),
      this.readingsRepository.countByLotId(lot.id),
      this.alertsRepository.findUnresolvedByLotId(lot.id),
      this.custodyEventsRepository.findMany({ lotId: lot.id }),
    ]);

    const origin = lot.catchItemId ? await this.resolveOrigin(lot.catchItemId) : null;
    const sustainability = lot.catchItemId ? await this.resolveSustainability(lot.catchItemId) : null;
    const certifications = await this.resolveCertifications(lot.vendorId);

    const roleCache = new Map<string, PassportCustodyRole>();
    const custody = await Promise.all(
      custodyEvents.map(async (event) => ({
        eventType: event.eventType,
        occurredAt: event.occurredAt,
        location: event.location,
        fromRole: event.fromUserId ? await this.resolveRole(event.fromUserId, roleCache) : null,
        toRole: event.toUserId ? await this.resolveRole(event.toUserId, roleCache) : null,
      })),
    );

    return {
      passportVersion: PASSPORT_VERSION,
      lot: {
        lotNumber: lot.lotNumber,
        species: lot.species,
        storageType: lot.storageType,
        freshnessGrade: lot.freshnessGrade,
        catchDate: lot.catchDate,
        foodSafetyStatus: lot.foodSafetyStatus,
        qualityScore: lot.qualityScore,
        temperatureVerified: unresolvedAlertCount === 0,
      },
      origin,
      custody,
      coldChainSummary: {
        totalReadings,
        unresolvedAlerts: unresolvedAlerts.length,
        worstSeverity: PassportService.worstSeverity(unresolvedAlerts.map((alert) => alert.severity)),
      },
      certifications,
      sustainability,
    };
  }

  private async resolveOrigin(
    catchItemId: string,
  ): Promise<DigitalProductPassportEntity['origin']> {
    const catchItem = await this.catchItemsRepository.findById(catchItemId);
    if (!catchItem) {
      return null;
    }

    const [fisherman, vessel, landingSite, species] = await Promise.all([
      this.fishermenRepository.findById(catchItem.catch.fishermanId),
      catchItem.catch.vesselId ? this.vesselsRepository.findById(catchItem.catch.vesselId) : null,
      this.landingSitesRepository.findById(catchItem.catch.landingSiteId),
      this.speciesRepository.findById(catchItem.speciesId),
    ]);

    if (!fisherman || !landingSite || !species) {
      return null;
    }

    return {
      fishermanName: fisherman.fullName,
      vesselName: vessel?.name ?? null,
      vesselRegistrationNumber: vessel?.registrationNumber ?? null,
      fishingMethod: vessel?.fishingMethod ?? null,
      landingSiteName: landingSite.name,
      landingSiteParish: landingSite.parish,
      speciesScientificName: species.scientificName,
      speciesCommercialName: species.commercialName,
      speciesRegulatoryStatus: species.regulatoryStatus,
    };
  }

  // Built entirely from data already modeled elsewhere in this plan
  // (Vessel.fishingMethod, Species.regulatoryStatus/seasonal window) -
  // meetsMinimumSize is always null since no measured catch size is
  // recorded anywhere in this codebase to check against
  // Species.minimumSizeCm; presenting an honest "unknown" is safer than a
  // defaulted false that reads as a violation that was never checked.
  private async resolveSustainability(
    catchItemId: string,
  ): Promise<DigitalProductPassportEntity['sustainability']> {
    const catchItem = await this.catchItemsRepository.findById(catchItemId);
    if (!catchItem) {
      return null;
    }

    const [vessel, species] = await Promise.all([
      catchItem.catch.vesselId ? this.vesselsRepository.findById(catchItem.catch.vesselId) : null,
      this.speciesRepository.findById(catchItem.speciesId),
    ]);

    if (!species) {
      return null;
    }

    return {
      fishingMethod: vessel?.fishingMethod ?? null,
      speciesRegulatoryStatus: species.regulatoryStatus,
      withinSeasonalWindow: isSpeciesInSeason(species, catchItem.catch.catchDate),
      meetsMinimumSize: null,
    };
  }

  // Status + issuing authority name only, never documentUrl/
  // certificateNumber (public-facing).
  private async resolveCertifications(
    vendorId: string,
  ): Promise<DigitalProductPassportEntity['certifications']> {
    const { items } = await this.certificationsRepository.findMany({ vendorId }, { skip: 0, take: 100 });
    const authorityCache = new Map<string, string>();

    return Promise.all(
      items.map(async (certification) => {
        let authorityName = authorityCache.get(certification.issuingAuthorityId);
        if (!authorityName) {
          const authority = await this.authoritiesRepository.findById(certification.issuingAuthorityId);
          authorityName = authority?.name ?? 'Unknown authority';
          authorityCache.set(certification.issuingAuthorityId, authorityName);
        }
        return {
          certificateType: certification.certificateType,
          status: certification.status,
          issuingAuthorityName: authorityName,
        };
      }),
    );
  }

  private async resolveRole(
    userId: string,
    cache: Map<string, PassportCustodyRole>,
  ): Promise<PassportCustodyRole> {
    const cached = cache.get(userId);
    if (cached) {
      return cached;
    }

    let role: PassportCustodyRole = 'CUSTOMER';
    if (await this.fishermenRepository.findByUserId(userId)) {
      role = 'FISHERMAN';
    } else if (await this.vendorsRepository.findByUserId(userId)) {
      role = 'VENDOR';
    } else if (await this.driversRepository.findByUserId(userId)) {
      role = 'DRIVER';
    }

    cache.set(userId, role);
    return role;
  }

  private static worstSeverity(severities: AlertSeverity[]): AlertSeverity | null {
    if (severities.length === 0) {
      return null;
    }
    return severities.reduce((worst, current) =>
      SEVERITY_RANK[current] > SEVERITY_RANK[worst] ? current : worst,
    );
  }
}
