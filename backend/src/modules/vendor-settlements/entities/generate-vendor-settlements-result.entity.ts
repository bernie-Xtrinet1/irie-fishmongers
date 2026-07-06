import { ApiProperty } from '@nestjs/swagger';

export class GenerateVendorSettlementsResultEntity {
  @ApiProperty()
  settlementsCreated!: number;
}
