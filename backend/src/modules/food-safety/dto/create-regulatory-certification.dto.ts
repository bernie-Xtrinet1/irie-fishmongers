import { ApiProperty } from '@nestjs/swagger';
import { IsDateString, IsOptional, IsString, IsUrl, IsUUID, MinLength } from 'class-validator';

export class CreateRegulatoryCertificationDto {
  @ApiProperty({ required: false, description: 'Exactly one of vendorId/fishermanId/landingSiteId must be set' })
  @IsOptional()
  @IsUUID()
  vendorId?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsUUID()
  fishermanId?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsUUID()
  landingSiteId?: string;

  @ApiProperty({ example: 'Food Handler Permit' })
  @IsString()
  @MinLength(2)
  certificateType!: string;

  @ApiProperty({ example: 'FHP-2026-004821' })
  @IsString()
  @MinLength(1)
  certificateNumber!: string;

  @ApiProperty()
  @IsUUID()
  issuingAuthorityId!: string;

  @ApiProperty({ example: '2026-01-15' })
  @IsDateString()
  issuedDate!: string;

  @ApiProperty({ required: false, example: '2027-01-15' })
  @IsOptional()
  @IsDateString()
  expiryDate?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsUrl()
  documentUrl?: string;
}
