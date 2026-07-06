import { ApiProperty } from '@nestjs/swagger';
import { Parish, VendorStatus } from '@prisma/client';

export class VendorResponseEntity {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  userId!: string;

  @ApiProperty()
  businessName!: string;

  @ApiProperty({ required: false, nullable: true })
  description!: string | null;

  @ApiProperty({ required: false, nullable: true })
  phone!: string | null;

  @ApiProperty({ enum: Parish })
  parish!: Parish;

  @ApiProperty({ required: false, nullable: true })
  logoUrl!: string | null;

  @ApiProperty({ enum: VendorStatus })
  status!: VendorStatus;

  @ApiProperty()
  termsAcceptedAt!: Date;

  @ApiProperty()
  createdAt!: Date;
}
