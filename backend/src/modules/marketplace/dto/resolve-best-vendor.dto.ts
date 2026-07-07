import { ApiProperty } from '@nestjs/swagger';
import { Parish } from '@prisma/client';
import { IsEnum, IsInt, IsUUID, Min } from 'class-validator';

export class ResolveBestVendorDto {
  @ApiProperty({ description: 'The product the customer is viewing' })
  @IsUUID()
  productId!: string;

  @ApiProperty({ example: 5 })
  @IsInt()
  @Min(1)
  quantity!: number;

  @ApiProperty({ enum: Parish })
  @IsEnum(Parish)
  deliveryParish!: Parish;
}
