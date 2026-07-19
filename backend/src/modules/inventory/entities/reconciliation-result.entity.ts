import { ApiProperty } from '@nestjs/swagger';

export class ReconciliationResultEntity {
  @ApiProperty()
  productsChecked!: number;

  @ApiProperty()
  reservationsReleased!: number;
}
