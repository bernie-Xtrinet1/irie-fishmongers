import { ApiProperty } from '@nestjs/swagger';
import { Parish } from '@prisma/client';
import { IsEnum, IsOptional, IsPhoneNumber, IsString, MinLength } from 'class-validator';

export class CheckoutDto {
  @ApiProperty({ example: '12 Ocean View Road' })
  @IsString()
  @MinLength(3)
  deliveryAddressLine1!: string;

  @ApiProperty({ required: false, example: 'Apartment 4B' })
  @IsOptional()
  @IsString()
  deliveryAddressLine2?: string;

  @ApiProperty({ enum: Parish })
  @IsEnum(Parish)
  deliveryParish!: Parish;

  @ApiProperty({ example: '+18765551234' })
  @IsPhoneNumber()
  deliveryPhone!: string;
}
