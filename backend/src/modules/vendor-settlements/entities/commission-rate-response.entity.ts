import { ApiProperty } from '@nestjs/swagger';

export class CommissionRateResponseEntity {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  commissionRate!: string;

  @ApiProperty()
  createdAt!: Date;
}
