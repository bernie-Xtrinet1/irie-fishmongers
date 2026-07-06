import { ApiProperty } from '@nestjs/swagger';
import { RecallSeverityClass, RecallStatus } from '@prisma/client';

export class RecallResponseEntity {
  @ApiProperty()
  id!: string;

  @ApiProperty({ enum: RecallSeverityClass })
  severityClass!: RecallSeverityClass;

  @ApiProperty({ enum: RecallStatus })
  status!: RecallStatus;

  @ApiProperty()
  reason!: string;

  @ApiProperty({ required: false, nullable: true })
  rootCause!: string | null;

  @ApiProperty({ required: false, nullable: true })
  resolutionNotes!: string | null;

  @ApiProperty()
  createdById!: string;

  @ApiProperty({ type: [String] })
  lotIds!: string[];

  @ApiProperty({ required: false, nullable: true })
  closedAt!: Date | null;

  @ApiProperty()
  createdAt!: Date;
}
