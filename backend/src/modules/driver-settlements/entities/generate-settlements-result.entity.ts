import { ApiProperty } from '@nestjs/swagger';

export class GenerateSettlementsResultEntity {
  @ApiProperty()
  settlementPeriodStart!: Date;

  @ApiProperty()
  settlementPeriodEnd!: Date;

  @ApiProperty()
  settlementsCreated!: number;
}
