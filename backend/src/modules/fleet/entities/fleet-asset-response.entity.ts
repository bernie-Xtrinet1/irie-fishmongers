import { ApiProperty } from '@nestjs/swagger';
import { FleetAssetStatus, FleetAssetType, FleetOwnership, Prisma } from '@prisma/client';

export class FleetAssetResponseEntity {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  zoneId!: string;

  @ApiProperty({ enum: FleetAssetType })
  assetType!: FleetAssetType;

  @ApiProperty({ enum: FleetOwnership })
  ownership!: FleetOwnership;

  @ApiProperty()
  licensePlate!: string;

  @ApiProperty({ type: String })
  capacityLbs!: Prisma.Decimal;

  @ApiProperty()
  coldChainCapable!: boolean;

  @ApiProperty({ enum: FleetAssetStatus })
  status!: FleetAssetStatus;

  @ApiProperty({ required: false, nullable: true })
  currentDriverId!: string | null;

  @ApiProperty()
  createdAt!: Date;

  @ApiProperty()
  updatedAt!: Date;
}
