import { ApiProperty } from '@nestjs/swagger';
import {
  AlertSeverity,
  CertificationStatus,
  CustodyEventType,
  FishingMethod,
  FoodSafetyStatus,
  FreshnessGrade,
  Parish,
  RegulatoryStatus,
  SeafoodStorageType,
} from '@prisma/client';

// fromRole/toRole/never a name - privacy. FISHERMAN/VENDOR/DRIVER resolve
// via the same profile-repository lookups assertCanRecordReading already
// uses; CUSTOMER is the RBAC system's remaining role.
export type PassportCustodyRole = 'FISHERMAN' | 'VENDOR' | 'DRIVER' | 'CUSTOMER';

export class PassportLotEntity {
  @ApiProperty()
  lotNumber!: string;

  @ApiProperty()
  species!: string;

  @ApiProperty({ enum: SeafoodStorageType })
  storageType!: SeafoodStorageType;

  @ApiProperty({ enum: FreshnessGrade, required: false, nullable: true })
  freshnessGrade!: FreshnessGrade | null;

  @ApiProperty()
  catchDate!: Date;

  @ApiProperty({ enum: FoodSafetyStatus })
  foodSafetyStatus!: FoodSafetyStatus;

  @ApiProperty({ required: false, nullable: true })
  qualityScore!: number | null;

  @ApiProperty({ description: 'Whether every temperature checkpoint for this lot has stayed within range' })
  temperatureVerified!: boolean;
}

export class PassportOriginEntity {
  @ApiProperty()
  fishermanName!: string;

  @ApiProperty({ required: false, nullable: true })
  vesselName!: string | null;

  @ApiProperty({ required: false, nullable: true })
  vesselRegistrationNumber!: string | null;

  @ApiProperty({ enum: FishingMethod, required: false, nullable: true })
  fishingMethod!: FishingMethod | null;

  @ApiProperty()
  landingSiteName!: string;

  @ApiProperty({ enum: Parish })
  landingSiteParish!: Parish;

  @ApiProperty()
  speciesScientificName!: string;

  @ApiProperty()
  speciesCommercialName!: string;

  @ApiProperty({ enum: RegulatoryStatus })
  speciesRegulatoryStatus!: RegulatoryStatus;
}

export class PassportCustodyEventEntity {
  @ApiProperty({ enum: CustodyEventType })
  eventType!: CustodyEventType;

  @ApiProperty()
  occurredAt!: Date;

  @ApiProperty({ required: false, nullable: true })
  location!: string | null;

  @ApiProperty({ required: false, nullable: true })
  fromRole!: PassportCustodyRole | null;

  @ApiProperty({ required: false, nullable: true })
  toRole!: PassportCustodyRole | null;
}

export class PassportColdChainSummaryEntity {
  @ApiProperty()
  totalReadings!: number;

  @ApiProperty()
  unresolvedAlerts!: number;

  @ApiProperty({ enum: AlertSeverity, required: false, nullable: true })
  worstSeverity!: AlertSeverity | null;
}

export class PassportCertificationEntity {
  @ApiProperty()
  certificateType!: string;

  @ApiProperty({ enum: CertificationStatus })
  status!: CertificationStatus;

  @ApiProperty()
  issuingAuthorityName!: string;
}

export class PassportSustainabilityEntity {
  @ApiProperty({ enum: FishingMethod, required: false, nullable: true })
  fishingMethod!: FishingMethod | null;

  @ApiProperty({ enum: RegulatoryStatus, required: false, nullable: true })
  speciesRegulatoryStatus!: RegulatoryStatus | null;

  @ApiProperty({
    required: false,
    nullable: true,
    description: 'null when the species has no configured seasonal window',
  })
  withinSeasonalWindow!: boolean | null;

  @ApiProperty({
    required: false,
    nullable: true,
    description: 'null - this platform does not currently record a measured catch size to check against',
  })
  meetsMinimumSize!: boolean | null;
}

export class DigitalProductPassportEntity {
  @ApiProperty({ example: '1.0.0' })
  passportVersion!: string;

  @ApiProperty({ type: PassportLotEntity })
  lot!: PassportLotEntity;

  @ApiProperty({ type: PassportOriginEntity, required: false, nullable: true })
  origin!: PassportOriginEntity | null;

  @ApiProperty({ type: PassportCustodyEventEntity, isArray: true })
  custody!: PassportCustodyEventEntity[];

  @ApiProperty({ type: PassportColdChainSummaryEntity })
  coldChainSummary!: PassportColdChainSummaryEntity;

  @ApiProperty({ type: PassportCertificationEntity, isArray: true })
  certifications!: PassportCertificationEntity[];

  @ApiProperty({ type: PassportSustainabilityEntity, required: false, nullable: true })
  sustainability!: PassportSustainabilityEntity | null;
}
