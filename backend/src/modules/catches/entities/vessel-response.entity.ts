import { ApiProperty } from '@nestjs/swagger';
import { FishingMethod, Prisma, VesselRegistrationStatus } from '@prisma/client';

export class VesselResponseEntity {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  ownerFishermanId!: string;

  @ApiProperty()
  registrationNumber!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty({ enum: FishingMethod })
  fishingMethod!: FishingMethod;

  @ApiProperty({ type: String, required: false, nullable: true })
  capacityTons!: Prisma.Decimal | null;

  @ApiProperty({ enum: VesselRegistrationStatus })
  status!: VesselRegistrationStatus;

  @ApiProperty()
  createdAt!: Date;
}
