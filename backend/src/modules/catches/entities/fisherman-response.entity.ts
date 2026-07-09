import { ApiProperty } from '@nestjs/swagger';
import { FishermanStatus } from '@prisma/client';

export class FishermanResponseEntity {
  @ApiProperty()
  id!: string;

  @ApiProperty({ required: false, nullable: true })
  vendorId!: string | null;

  @ApiProperty()
  fullName!: string;

  @ApiProperty()
  contactPhone!: string;

  @ApiProperty({ required: false, nullable: true })
  contactEmail!: string | null;

  @ApiProperty({ required: false, nullable: true })
  vesselName!: string | null;

  @ApiProperty({ required: false, nullable: true })
  vesselRegistrationNumber!: string | null;

  @ApiProperty({ required: false, nullable: true })
  fishingLicenseNumber!: string | null;

  @ApiProperty({ required: false, nullable: true })
  landingSiteId!: string | null;

  @ApiProperty({ enum: FishermanStatus })
  status!: FishermanStatus;

  @ApiProperty()
  createdAt!: Date;

  @ApiProperty()
  updatedAt!: Date;
}
