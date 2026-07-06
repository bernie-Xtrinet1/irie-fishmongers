import { ApiProperty } from '@nestjs/swagger';
import { VendorStatus } from '@prisma/client';

export class VendorResponseEntity {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  userId!: string;

  @ApiProperty()
  businessName!: string;

  @ApiProperty({ enum: VendorStatus })
  status!: VendorStatus;

  @ApiProperty()
  createdAt!: Date;
}
