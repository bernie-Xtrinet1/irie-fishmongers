import { ApiProperty } from '@nestjs/swagger';

export class AdjustmentResponseEntity {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  settlementId!: string;

  @ApiProperty()
  amount!: string;

  @ApiProperty()
  reason!: string;

  @ApiProperty()
  createdAt!: Date;
}
