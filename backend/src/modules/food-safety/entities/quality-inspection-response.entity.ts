import { ApiProperty } from '@nestjs/swagger';
import { FreshnessGrade, InspectionResult } from '@prisma/client';

export class QualityInspectionResponseEntity {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  lotId!: string;

  @ApiProperty()
  inspectorId!: string;

  @ApiProperty({ enum: InspectionResult })
  result!: InspectionResult;

  @ApiProperty({ enum: FreshnessGrade })
  freshnessGrade!: FreshnessGrade;

  @ApiProperty()
  qualityScore!: number;

  @ApiProperty({ required: false, nullable: true })
  notes!: string | null;

  @ApiProperty({ required: false, nullable: true })
  photoUrl!: string | null;

  @ApiProperty()
  inspectedAt!: Date;
}
