import { ApiProperty } from '@nestjs/swagger';

export class DeliveryZoneResponseEntity {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty()
  code!: string;

  @ApiProperty({ required: false, nullable: true })
  description!: string | null;

  @ApiProperty()
  active!: boolean;

  @ApiProperty()
  createdAt!: Date;

  @ApiProperty()
  updatedAt!: Date;
}
