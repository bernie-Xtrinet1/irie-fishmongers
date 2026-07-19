import { ApiProperty } from '@nestjs/swagger';

import { CatchItemResponseEntity } from './catch-item-response.entity';

export class CatchResponseEntity {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  catchNumber!: string;

  @ApiProperty()
  fishermanId!: string;

  @ApiProperty({ required: false, nullable: true })
  vesselId!: string | null;

  @ApiProperty()
  landingSiteId!: string;

  @ApiProperty()
  catchDate!: Date;

  @ApiProperty({ required: false, nullable: true })
  latitude!: number | null;

  @ApiProperty({ required: false, nullable: true })
  longitude!: number | null;

  @ApiProperty({ required: false, nullable: true })
  fishingArea!: string | null;

  @ApiProperty({ type: [String] })
  photos!: string[];

  @ApiProperty({ type: [CatchItemResponseEntity] })
  items!: CatchItemResponseEntity[];

  @ApiProperty()
  createdAt!: Date;
}
