import { ApiProperty } from '@nestjs/swagger';
import { EmergencyResponseStatus } from '@prisma/client';

export class EmergencyResponseResponseEntity {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  alertId!: string;

  @ApiProperty({ required: false, nullable: true })
  assignedToId!: string | null;

  @ApiProperty({ enum: EmergencyResponseStatus })
  status!: EmergencyResponseStatus;

  @ApiProperty({ required: false, nullable: true })
  actionsTaken!: string | null;

  @ApiProperty({ required: false, nullable: true })
  rootCause!: string | null;

  @ApiProperty({ required: false, nullable: true })
  correctiveAction!: string | null;

  @ApiProperty({ required: false, nullable: true })
  preventiveAction!: string | null;

  @ApiProperty({ required: false, nullable: true })
  acknowledgedAt!: Date | null;

  @ApiProperty({ required: false, nullable: true })
  resolvedAt!: Date | null;

  @ApiProperty()
  createdAt!: Date;
}
