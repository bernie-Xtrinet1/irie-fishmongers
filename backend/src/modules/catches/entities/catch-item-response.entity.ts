import { ApiProperty } from '@nestjs/swagger';
import { FreshnessGrade, Prisma, WeightUnit } from '@prisma/client';

export class CatchItemResponseEntity {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  speciesId!: string;

  @ApiProperty({ type: String })
  weight!: Prisma.Decimal;

  @ApiProperty({ enum: WeightUnit })
  weightUnit!: WeightUnit;

  @ApiProperty({ enum: FreshnessGrade, required: false, nullable: true })
  estimatedFreshness!: FreshnessGrade | null;
}
