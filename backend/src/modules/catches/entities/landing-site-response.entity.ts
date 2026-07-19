import { ApiProperty } from '@nestjs/swagger';
import { LandingSiteStatus, Parish, SiteInspectionStatus } from '@prisma/client';

export class LandingSiteResponseEntity {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty({ enum: Parish })
  parish!: Parish;

  @ApiProperty({ required: false, nullable: true })
  latitude!: number | null;

  @ApiProperty({ required: false, nullable: true })
  longitude!: number | null;

  @ApiProperty({ enum: LandingSiteStatus })
  status!: LandingSiteStatus;

  @ApiProperty({ enum: SiteInspectionStatus })
  inspectionStatus!: SiteInspectionStatus;

  @ApiProperty()
  createdAt!: Date;

  @ApiProperty()
  updatedAt!: Date;
}
