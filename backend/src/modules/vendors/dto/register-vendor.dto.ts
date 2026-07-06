import { ApiProperty } from '@nestjs/swagger';
import { Parish } from '@prisma/client';
import {
  Equals,
  IsEnum,
  IsOptional,
  IsPhoneNumber,
  IsString,
  MinLength,
} from 'class-validator';

export class RegisterVendorDto {
  @ApiProperty({ example: "Jane's Fresh Catch" })
  @IsString()
  @MinLength(2)
  businessName!: string;

  @ApiProperty({ enum: Parish })
  @IsEnum(Parish)
  parish!: Parish;

  @ApiProperty({ example: true, description: 'Must be true to accept platform terms' })
  @Equals(true)
  acceptedTerms!: boolean;

  @ApiProperty({ example: '+18761234567', required: false })
  @IsOptional()
  @IsPhoneNumber()
  phone?: string;

  @ApiProperty({ example: 'Family-run vendor selling fresh catch daily.', required: false })
  @IsOptional()
  @IsString()
  @MinLength(10)
  description?: string;
}
