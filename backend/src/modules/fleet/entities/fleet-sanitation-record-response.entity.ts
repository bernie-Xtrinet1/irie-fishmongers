import { ApiProperty } from '@nestjs/swagger';
import { SanitationStatus } from '@prisma/client';

export class FleetSanitationRecordResponseEntity {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  fleetAssetId!: string;

  @ApiProperty()
  performedAt!: Date;

  @ApiProperty({ required: false, nullable: true })
  performedBy!: string | null;

  @ApiProperty({ required: false, nullable: true })
  method!: string | null;

  @ApiProperty({ required: false, nullable: true })
  notes!: string | null;

  @ApiProperty({ required: false, nullable: true })
  nextDueAt!: Date | null;

  @ApiProperty({ enum: SanitationStatus })
  status!: SanitationStatus;

  @ApiProperty()
  createdAt!: Date;
}
