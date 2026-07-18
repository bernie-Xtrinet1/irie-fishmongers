import { NotFoundException } from '@nestjs/common';
import {
  Catch,
  Driver,
  Fisherman,
  LandingSite,
  RegulatoryAuthority,
  RegulatoryCertification,
  SeafoodLot,
  Species,
  TemperatureAlert,
  Vendor,
  Vessel,
} from '@prisma/client';

import { CatchItemWithCatch, CatchItemsRepository } from '../../catches/repositories/catch-items.repository';
import { FishermenRepository } from '../../catches/repositories/fishermen.repository';
import { LandingSitesRepository } from '../../catches/repositories/landing-sites.repository';
import { SpeciesRepository } from '../../catches/repositories/species.repository';
import { VesselsRepository } from '../../catches/repositories/vessels.repository';
import { DriversRepository } from '../../delivery/repositories/drivers.repository';
import { CustodyEventsRepository } from '../../food-safety/repositories/custody-events.repository';
import { RegulatoryAuthoritiesRepository } from '../../food-safety/repositories/regulatory-authorities.repository';
import { RegulatoryCertificationsRepository } from '../../food-safety/repositories/regulatory-certifications.repository';
import { LotWithVendor, SeafoodLotsRepository } from '../../food-safety/repositories/seafood-lots.repository';
import { TemperatureAlertsRepository } from '../../food-safety/repositories/temperature-alerts.repository';
import { TemperatureReadingsRepository } from '../../food-safety/repositories/temperature-readings.repository';
import { VendorsRepository } from '../../vendors/repositories/vendors.repository';
import { PassportService } from './passport.service';

function buildVendor(overrides: Partial<Vendor> = {}): Vendor {
  return {
    id: 'vendor-1',
    userId: 'vendor-user-1',
    businessName: "Vera's Catch",
    description: null,
    phone: null,
    parish: 'KINGSTON',
    logoUrl: null,
    status: 'APPROVED',
    tier: 'COMMUNITY_FISHER',
    complianceScore: null,
    complianceScoreUpdatedAt: null,
    termsAcceptedAt: new Date(),
    primaryZoneId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function buildLot(overrides: Partial<SeafoodLot> = {}): LotWithVendor {
  return {
    id: 'lot-1',
    lotNumber: 'LOT-2026-000001',
    publicTraceToken: 'trace-token-1',
    vendorId: 'vendor-1',
    catchItemId: null,
    species: 'Snapper',
    speciesId: null,
    storageType: 'FRESH',
    catchDate: new Date('2026-01-15'),
    catchLocation: null,
    landingSite: null,
    weight: { toString: () => '20' } as unknown as SeafoodLot['weight'],
    weightUnit: 'POUNDS',
    freshnessGrade: 'GRADE_A',
    qualityScore: 95,
    foodSafetyStatus: 'SAFE',
    statusNotes: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    vendor: buildVendor(),
    ...overrides,
  };
}

function buildCatch(overrides: Partial<Catch> = {}): Catch {
  return {
    id: 'catch-1',
    catchNumber: 'CATCH-2026-000001',
    fishermanId: 'fisherman-1',
    vesselId: 'vessel-1',
    landingSiteId: 'site-1',
    catchDate: new Date('2026-01-15'),
    latitude: null,
    longitude: null,
    fishingArea: null,
    photos: [],
    createdAt: new Date(),
    ...overrides,
  };
}

function buildCatchItem(overrides: Partial<CatchItemWithCatch> = {}): CatchItemWithCatch {
  const { catch: catchOverrides, ...itemOverrides } = overrides;
  return {
    id: 'catch-item-1',
    catchId: 'catch-1',
    speciesId: 'species-1',
    weight: { toNumber: () => 15 } as unknown as CatchItemWithCatch['weight'],
    weightUnit: 'POUNDS',
    estimatedFreshness: null,
    createdAt: new Date(),
    catch: buildCatch(catchOverrides),
    ...itemOverrides,
  };
}

function buildFisherman(overrides: Partial<Fisherman> = {}): Fisherman {
  return {
    id: 'fisherman-1',
    userId: 'fisherman-user-1',
    vendorId: null,
    fullName: 'Ken Fisher',
    contactPhone: '876-555-0100',
    contactEmail: null,
    vesselName: null,
    vesselRegistrationNumber: null,
    fishingLicenseNumber: null,
    landingSiteId: 'site-1',
    bankAccountName: null,
    bankAccountNumber: null,
    status: 'APPROVED',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function buildVessel(overrides: Partial<Vessel> = {}): Vessel {
  return {
    id: 'vessel-1',
    ownerFishermanId: 'fisherman-1',
    registrationNumber: 'JM-VESSEL-001',
    name: 'Sea Breeze',
    fishingMethod: 'TRAP',
    capacityTons: null,
    status: 'ACTIVE',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function buildLandingSite(overrides: Partial<LandingSite> = {}): LandingSite {
  return {
    id: 'site-1',
    name: 'Falmouth Landing Site',
    parish: 'TRELAWNY',
    latitude: null,
    longitude: null,
    status: 'ACTIVE',
    inspectionStatus: 'NOT_INSPECTED',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function buildSpecies(overrides: Partial<Species> = {}): Species {
  return {
    id: 'species-1',
    scientificName: 'Lutjanus analis',
    commercialName: 'Snapper',
    regulatoryStatus: 'UNRESTRICTED',
    seasonalStartMonth: null,
    seasonalEndMonth: null,
    minimumSizeCm: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function buildCertification(overrides: Partial<RegulatoryCertification> = {}): RegulatoryCertification {
  return {
    id: 'cert-1',
    vendorId: 'vendor-1',
    fishermanId: null,
    landingSiteId: null,
    certificateType: 'Food Handler Permit',
    certificateNumber: 'FHP-2026-004821',
    issuingAuthorityId: 'authority-1',
    issuedDate: new Date('2026-01-15'),
    expiryDate: new Date('2027-01-15'),
    status: 'ACTIVE',
    documentUrl: 'https://cdn.example.com/cert.pdf',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function buildAuthority(overrides: Partial<RegulatoryAuthority> = {}): RegulatoryAuthority {
  return {
    id: 'authority-1',
    name: 'Ministry of Health',
    country: 'Jamaica',
    contactEmail: null,
    contactPhone: null,
    website: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('PassportService', () => {
  let lotsRepository: jest.Mocked<Pick<SeafoodLotsRepository, 'findByPublicTraceToken'>>;
  let alertsRepository: jest.Mocked<Pick<TemperatureAlertsRepository, 'countUnresolvedByLotId' | 'findUnresolvedByLotId'>>;
  let readingsRepository: jest.Mocked<Pick<TemperatureReadingsRepository, 'countByLotId'>>;
  let catchItemsRepository: jest.Mocked<Pick<CatchItemsRepository, 'findById'>>;
  let fishermenRepository: jest.Mocked<Pick<FishermenRepository, 'findById' | 'findByUserId'>>;
  let vesselsRepository: jest.Mocked<Pick<VesselsRepository, 'findById'>>;
  let landingSitesRepository: jest.Mocked<Pick<LandingSitesRepository, 'findById'>>;
  let speciesRepository: jest.Mocked<Pick<SpeciesRepository, 'findById'>>;
  let custodyEventsRepository: jest.Mocked<Pick<CustodyEventsRepository, 'findMany'>>;
  let certificationsRepository: jest.Mocked<Pick<RegulatoryCertificationsRepository, 'findMany'>>;
  let authoritiesRepository: jest.Mocked<Pick<RegulatoryAuthoritiesRepository, 'findById'>>;
  let vendorsRepository: jest.Mocked<Pick<VendorsRepository, 'findByUserId'>>;
  let driversRepository: jest.Mocked<Pick<DriversRepository, 'findByUserId'>>;
  let service: PassportService;

  beforeEach(() => {
    lotsRepository = { findByPublicTraceToken: jest.fn() };
    alertsRepository = { countUnresolvedByLotId: jest.fn(), findUnresolvedByLotId: jest.fn() };
    readingsRepository = { countByLotId: jest.fn() };
    catchItemsRepository = { findById: jest.fn() };
    fishermenRepository = { findById: jest.fn(), findByUserId: jest.fn() };
    vesselsRepository = { findById: jest.fn() };
    landingSitesRepository = { findById: jest.fn() };
    speciesRepository = { findById: jest.fn() };
    custodyEventsRepository = { findMany: jest.fn().mockResolvedValue([]) };
    certificationsRepository = { findMany: jest.fn().mockResolvedValue({ items: [], total: 0 }) };
    authoritiesRepository = { findById: jest.fn() };
    vendorsRepository = { findByUserId: jest.fn() };
    driversRepository = { findByUserId: jest.fn() };

    alertsRepository.countUnresolvedByLotId.mockResolvedValue(0);
    alertsRepository.findUnresolvedByLotId.mockResolvedValue([]);
    readingsRepository.countByLotId.mockResolvedValue(0);

    service = new PassportService(
      lotsRepository as unknown as SeafoodLotsRepository,
      alertsRepository as unknown as TemperatureAlertsRepository,
      readingsRepository as unknown as TemperatureReadingsRepository,
      catchItemsRepository as unknown as CatchItemsRepository,
      fishermenRepository as unknown as FishermenRepository,
      vesselsRepository as unknown as VesselsRepository,
      landingSitesRepository as unknown as LandingSitesRepository,
      speciesRepository as unknown as SpeciesRepository,
      custodyEventsRepository as unknown as CustodyEventsRepository,
      certificationsRepository as unknown as RegulatoryCertificationsRepository,
      authoritiesRepository as unknown as RegulatoryAuthoritiesRepository,
      vendorsRepository as unknown as VendorsRepository,
      driversRepository as unknown as DriversRepository,
    );
  });

  describe('getByToken', () => {
    it('throws NotFoundException for an unknown token', async () => {
      lotsRepository.findByPublicTraceToken.mockResolvedValue(null);
      await expect(service.getByToken('unknown-token')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('returns passportVersion 1.0.0 and the lot block', async () => {
      lotsRepository.findByPublicTraceToken.mockResolvedValue(buildLot());

      const result = await service.getByToken('trace-token-1');

      expect(result.passportVersion).toBe('1.0.0');
      expect(result.lot).toMatchObject({
        lotNumber: 'LOT-2026-000001',
        species: 'Snapper',
        foodSafetyStatus: 'SAFE',
        qualityScore: 95,
        temperatureVerified: true,
      });
    });

    it('sets origin and sustainability to null when the lot has no catchItemId', async () => {
      lotsRepository.findByPublicTraceToken.mockResolvedValue(buildLot({ catchItemId: null }));

      const result = await service.getByToken('trace-token-1');

      expect(result.origin).toBeNull();
      expect(result.sustainability).toBeNull();
    });

    it('resolves origin and sustainability when the lot is linked to a catch item', async () => {
      lotsRepository.findByPublicTraceToken.mockResolvedValue(buildLot({ catchItemId: 'catch-item-1' }));
      catchItemsRepository.findById.mockResolvedValue(buildCatchItem());
      fishermenRepository.findById.mockResolvedValue(buildFisherman());
      vesselsRepository.findById.mockResolvedValue(buildVessel());
      landingSitesRepository.findById.mockResolvedValue(buildLandingSite());
      speciesRepository.findById.mockResolvedValue(buildSpecies());

      const result = await service.getByToken('trace-token-1');

      expect(result.origin).toMatchObject({
        fishermanName: 'Ken Fisher',
        vesselName: 'Sea Breeze',
        fishingMethod: 'TRAP',
        landingSiteName: 'Falmouth Landing Site',
        speciesScientificName: 'Lutjanus analis',
      });
      expect(result.sustainability).toMatchObject({
        fishingMethod: 'TRAP',
        speciesRegulatoryStatus: 'UNRESTRICTED',
        withinSeasonalWindow: null,
        meetsMinimumSize: null,
      });
    });

    it('computes withinSeasonalWindow false when the catch date falls outside the species window', async () => {
      lotsRepository.findByPublicTraceToken.mockResolvedValue(buildLot({ catchItemId: 'catch-item-1' }));
      catchItemsRepository.findById.mockResolvedValue(
        buildCatchItem({ catch: buildCatch({ catchDate: new Date('2026-03-01') }) }),
      );
      fishermenRepository.findById.mockResolvedValue(buildFisherman());
      vesselsRepository.findById.mockResolvedValue(buildVessel());
      landingSitesRepository.findById.mockResolvedValue(buildLandingSite());
      speciesRepository.findById.mockResolvedValue(
        buildSpecies({ seasonalStartMonth: 6, seasonalEndMonth: 8 }),
      );

      const result = await service.getByToken('trace-token-1');

      expect(result.sustainability?.withinSeasonalWindow).toBe(false);
    });

    it('resolves custody roles for fisherman/vendor/driver/customer', async () => {
      lotsRepository.findByPublicTraceToken.mockResolvedValue(buildLot());
      custodyEventsRepository.findMany.mockResolvedValue([
        {
          id: 'event-1',
          catchId: null,
          lotId: 'lot-1',
          eventType: 'STORAGE_ENTRY',
          fromUserId: 'fisherman-user-1',
          toUserId: 'vendor-user-1',
          location: null,
          latitude: null,
          longitude: null,
          notes: null,
          occurredAt: new Date(),
        },
        {
          id: 'event-2',
          catchId: null,
          lotId: 'lot-1',
          eventType: 'DELIVERY',
          fromUserId: 'driver-user-1',
          toUserId: 'random-customer-user-1',
          location: null,
          latitude: null,
          longitude: null,
          notes: null,
          occurredAt: new Date(),
        },
      ]);
      fishermenRepository.findByUserId.mockImplementation((userId) =>
        Promise.resolve(userId === 'fisherman-user-1' ? buildFisherman() : null),
      );
      vendorsRepository.findByUserId.mockImplementation((userId) =>
        Promise.resolve(userId === 'vendor-user-1' ? buildVendor() : null),
      );
      driversRepository.findByUserId.mockImplementation((userId) =>
        Promise.resolve(
          userId === 'driver-user-1' ? ({ id: 'driver-1' } as Driver) : null,
        ),
      );

      const result = await service.getByToken('trace-token-1');

      expect(result.custody).toEqual([
        expect.objectContaining({ fromRole: 'FISHERMAN', toRole: 'VENDOR' }),
        expect.objectContaining({ fromRole: 'DRIVER', toRole: 'CUSTOMER' }),
      ]);
    });

    it('computes coldChainSummary totals and worstSeverity', async () => {
      lotsRepository.findByPublicTraceToken.mockResolvedValue(buildLot());
      readingsRepository.countByLotId.mockResolvedValue(5);
      alertsRepository.findUnresolvedByLotId.mockResolvedValue([
        { severity: 'WARNING' } as TemperatureAlert,
        { severity: 'CRITICAL' } as TemperatureAlert,
      ]);

      const result = await service.getByToken('trace-token-1');

      expect(result.coldChainSummary).toEqual({
        totalReadings: 5,
        unresolvedAlerts: 2,
        worstSeverity: 'CRITICAL',
      });
    });

    it('maps certifications to status + issuing authority name only', async () => {
      lotsRepository.findByPublicTraceToken.mockResolvedValue(buildLot());
      certificationsRepository.findMany.mockResolvedValue({ items: [buildCertification()], total: 1 });
      authoritiesRepository.findById.mockResolvedValue(buildAuthority());

      const result = await service.getByToken('trace-token-1');

      expect(result.certifications).toEqual([
        { certificateType: 'Food Handler Permit', status: 'ACTIVE', issuingAuthorityName: 'Ministry of Health' },
      ]);
      expect(certificationsRepository.findMany).toHaveBeenCalledWith(
        { vendorId: 'vendor-1' },
        { skip: 0, take: 100 },
      );
    });
  });
});
