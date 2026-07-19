import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsPhoneNumber, IsString, MinLength } from 'class-validator';

export class RegisterFishermanDto {
  @ApiProperty({ example: 'Errol Campbell' })
  @IsString()
  @MinLength(2)
  fullName!: string;

  @ApiProperty({ example: '+18765551234' })
  @IsPhoneNumber()
  contactPhone!: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  contactEmail?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  vesselName?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  vesselRegistrationNumber?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  fishingLicenseNumber?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  landingSiteId?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  bankAccountName?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  bankAccountNumber?: string;
}
