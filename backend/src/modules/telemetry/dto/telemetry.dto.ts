import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  SeafoodStorageType,
  TelemetryCredentialScope,
  TelemetryProtocol,
  TemperatureSensorModel,
  TrackerHardwareModel,
} from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsInt,
  IsLatitude,
  IsLongitude,
  IsNotEmpty,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

export class CreateVehicleCompartmentDto {
  @ApiProperty()
  @IsUUID()
  fleetAssetId!: string;

  @ApiProperty({ example: 'CHILLER-MAIN' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  compartmentCode!: string;

  @ApiProperty({ example: 'Main Refrigerated Cargo Box' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  label!: string;

  @ApiPropertyOptional({ enum: SeafoodStorageType, default: SeafoodStorageType.FRESH })
  @IsOptional()
  @IsEnum(SeafoodStorageType)
  storageType?: SeafoodStorageType;

  @ApiPropertyOptional({ example: 0 })
  @IsOptional()
  @IsNumber()
  @Min(-40)
  @Max(40)
  targetMinC?: number;

  @ApiPropertyOptional({ example: 4 })
  @IsOptional()
  @IsNumber()
  @Min(-40)
  @Max(40)
  targetMaxC?: number;
}

export class RegisterVehicleTrackerDto {
  @ApiProperty()
  @IsUUID()
  fleetAssetId!: string;

  @ApiProperty({ example: '356307042441013' })
  @IsString()
  @Matches(/^\d{15,20}$/, { message: 'imei must be 15 to 20 numeric digits' })
  imei!: string;

  @ApiPropertyOptional({ enum: TrackerHardwareModel, default: TrackerHardwareModel.TELTONIKA_FMC130 })
  @IsOptional()
  @IsEnum(TrackerHardwareModel)
  hardwareModel?: TrackerHardwareModel;

  @ApiPropertyOptional({ example: '03.29.00.Rev.18' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  firmwareVersion?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(32)
  simIccid?: string;

  @ApiPropertyOptional({ example: 'Digicel Jamaica LTE Cat-1' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  simCarrier?: string;

  @ApiPropertyOptional({ enum: TelemetryProtocol, default: TelemetryProtocol.TELTONIKA_CODEC_8E })
  @IsOptional()
  @IsEnum(TelemetryProtocol)
  protocol?: TelemetryProtocol;
}

export class RegisterCargoSensorDto {
  @ApiProperty()
  @IsUUID()
  compartmentId!: string;

  @ApiProperty({ example: 'EYE-BTSMP1-001' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  deviceCode!: string;

  @ApiPropertyOptional({
    enum: TemperatureSensorModel,
    default: TemperatureSensorModel.TELTONIKA_EYE_BTSMP1_EN12830,
  })
  @IsOptional()
  @IsEnum(TemperatureSensorModel)
  hardwareModel?: TemperatureSensorModel;

  @ApiPropertyOptional({ example: '7C:D9:F4:11:22:33' })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  bleMacAddress?: string;

  @ApiPropertyOptional({ example: 1, minimum: 1, maximum: 4 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(4)
  sensorSlot?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(64)
  firmwareVersion?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  vendorId?: string;
}

export class IssueTelemetryCredentialDto {
  @ApiPropertyOptional({
    enum: TelemetryCredentialScope,
    default: TelemetryCredentialScope.DEVICE_TRACKER,
  })
  @IsOptional()
  @IsEnum(TelemetryCredentialScope)
  scope?: TelemetryCredentialScope;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  trackerId?: string;

  @ApiProperty({ example: 'van-jm-01-fmc130-primary' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  label!: string;

  @ApiPropertyOptional({ description: 'Optional credential lifetime in hours' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(8760)
  expiresInHours?: number;
}

export class RotateTelemetryCredentialDto {
  @ApiPropertyOptional({
    default: 60,
    description: 'Overlap grace window in minutes before previous key expires (0 revokes immediately)',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1440)
  graceMinutes?: number;
}

export class RevokeTelemetryCredentialDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(240)
  reason?: string;
}

export class IngestCodec8eHttpDto {
  @ApiProperty({ example: '356307042441013' })
  @IsString()
  @Matches(/^\d{15,20}$/)
  imei!: string;

  @ApiPropertyOptional({ description: 'Hex-encoded binary Teltonika Codec 8 Extended AVL frame' })
  @IsOptional()
  @IsString()
  @MaxLength(200000)
  payloadHex?: string;

  @ApiPropertyOptional({ description: 'Base64-encoded binary Teltonika Codec 8 Extended AVL frame' })
  @IsOptional()
  @IsString()
  @MaxLength(200000)
  payloadBase64?: string;
}

export class IngestCanonicalRecordDto {
  @ApiProperty({ example: '2026-11-25T12:00:00.000Z' })
  @IsDateString()
  capturedAt!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsLatitude()
  latitude?: number | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsLongitude()
  longitude?: number | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  altitudeM?: number | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(360)
  angleDeg?: number | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(64)
  satellites?: number | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(300)
  speedKph?: number | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  gnssValid?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  gsmSignal?: number | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(60000)
  externalVoltageMv?: number | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10000)
  trackerBatteryMv?: number | null;

  @ApiPropertyOptional({ example: 2.1 })
  @IsOptional()
  @IsNumber()
  @Min(-80)
  @Max(85)
  cargoTempC?: number | null;

  @ApiPropertyOptional({ minimum: 1, maximum: 4 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(4)
  sensorSlot?: number | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  humidityPct?: number | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  doorOpen?: boolean | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  movement?: boolean | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10000)
  batteryMv?: number | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  eyeSensors?: Record<
    string,
    {
      cargoTempC?: number | null;
      humidityPct?: number | null;
      doorOpen?: boolean | null;
      movement?: boolean | null;
      batteryMv?: number | null;
    }
  >;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  eventId?: string;
}

export class IngestCanonicalTelemetryDto {
  @ApiProperty({ example: '356307042441013' })
  @IsString()
  @Matches(/^\d{15,20}$/)
  imei!: string;

  @ApiPropertyOptional({ enum: TelemetryProtocol, default: TelemetryProtocol.HTTP_JSON })
  @IsOptional()
  @IsEnum(TelemetryProtocol)
  protocol?: TelemetryProtocol;

  @ApiProperty({ type: [IngestCanonicalRecordDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => IngestCanonicalRecordDto)
  records!: IngestCanonicalRecordDto[];
}

export class IngestCodecJsonTelemetryDto {
  @ApiProperty({ example: '356307042441013' })
  @IsString()
  @Matches(/^\d{15,20}$/)
  imei!: string;

  @ApiProperty({ type: Object })
  @IsObject()
  payload!: Record<string, unknown>;
}

export class AuthorizeGatewayImeiDto {
  @ApiProperty({ example: '356307042441013' })
  @IsString()
  @Matches(/^\d{15,20}$/)
  imei!: string;
}

export class ImportEyeAppCsvDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(500000)
  csvContent!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(250)
  notes?: string;
}

export class CargoLotQuantityDto {
  @ApiProperty()
  @IsUUID()
  lotId!: string;

  @ApiProperty({ minimum: 1 })
  @IsInt()
  @Min(1)
  quantityUnits!: number;
}

export class RecordCompartmentPickupDto {
  @ApiProperty()
  @IsUUID()
  deliveryId!: string;

  @ApiProperty()
  @IsUUID()
  fleetAssetId!: string;

  @ApiProperty()
  @IsUUID()
  compartmentId!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  trackerId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  sensorDeviceId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  loadedAt?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsLatitude()
  latitude?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsLongitude()
  longitude?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(250)
  notes?: string;

  @ApiProperty({ type: [CargoLotQuantityDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => CargoLotQuantityDto)
  lots!: CargoLotQuantityDto[];
}

export class HandoverLotQuantityDto {
  @ApiProperty()
  @IsUUID()
  lotId!: string;

  @ApiProperty({ minimum: 1 })
  @IsInt()
  @Min(1)
  handedOverQuantity!: number;
}

export class RecordCompartmentHandoverDto {
  @ApiProperty()
  @IsUUID()
  deliveryId!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  compartmentId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  unloadedAt?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsLatitude()
  latitude?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsLongitude()
  longitude?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(250)
  notes?: string;

  @ApiPropertyOptional({ type: [HandoverLotQuantityDto] })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => HandoverLotQuantityDto)
  items?: HandoverLotQuantityDto[];
}

export class ListTelemetryHistoryQueryDto {
  @ApiPropertyOptional({ default: 24, minimum: 1, maximum: 168 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(168)
  hours?: number;

  @ApiPropertyOptional({ default: 100, minimum: 1, maximum: 500 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  limit?: number;
}
