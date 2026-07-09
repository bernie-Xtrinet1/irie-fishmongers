import { ApiProperty } from '@nestjs/swagger';
import { Prisma, RegulatoryStatus } from '@prisma/client';

export class SpeciesResponseEntity {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  scientificName!: string;

  @ApiProperty()
  commercialName!: string;

  @ApiProperty({ enum: RegulatoryStatus })
  regulatoryStatus!: RegulatoryStatus;

  @ApiProperty({ required: false, nullable: true })
  seasonalStartMonth!: number | null;

  @ApiProperty({ required: false, nullable: true })
  seasonalEndMonth!: number | null;

  @ApiProperty({ type: String, required: false, nullable: true })
  minimumSizeCm!: Prisma.Decimal | null;

  @ApiProperty()
  createdAt!: Date;

  @ApiProperty()
  updatedAt!: Date;
}
