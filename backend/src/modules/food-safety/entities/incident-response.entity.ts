import { ApiProperty } from '@nestjs/swagger';
import { IncidentSeverity, IncidentStatus } from '@prisma/client';

export class IncidentResponseEntity {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  lotId!: string;

  @ApiProperty()
  reportedById!: string;

  @ApiProperty({ enum: IncidentSeverity })
  severity!: IncidentSeverity;

  @ApiProperty({ enum: IncidentStatus })
  status!: IncidentStatus;

  @ApiProperty()
  description!: string;

  @ApiProperty({ required: false, nullable: true })
  photoUrl!: string | null;

  @ApiProperty({ required: false, nullable: true })
  correctiveAction!: string | null;

  @ApiProperty({ required: false, nullable: true })
  resolvedAt!: Date | null;

  @ApiProperty()
  createdAt!: Date;
}
