import { ApiProperty } from '@nestjs/swagger';
import { Parish } from '@prisma/client';

export class VendorPublicEntity {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  businessName!: string;

  @ApiProperty({ required: false, nullable: true })
  description!: string | null;

  @ApiProperty({ enum: Parish })
  parish!: Parish;

  @ApiProperty({ required: false, nullable: true })
  logoUrl!: string | null;
}
