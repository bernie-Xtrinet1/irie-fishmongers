import { ApiProperty } from '@nestjs/swagger';
import { DeliveryExceptionType } from '@prisma/client';
import { IsArray, IsEnum, IsOptional, IsString, IsUrl, MinLength } from 'class-validator';

export class CreateDeliveryExceptionDto {
  @ApiProperty({ enum: DeliveryExceptionType })
  @IsEnum(DeliveryExceptionType)
  type!: DeliveryExceptionType;

  @ApiProperty({ example: 'Customer did not answer the door after three attempts' })
  @IsString()
  @MinLength(5)
  reason!: string;

  @ApiProperty({ required: false, type: [String] })
  @IsOptional()
  @IsArray()
  @IsUrl({}, { each: true })
  photos?: string[];

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  notes?: string;
}
