import { ApiProperty } from '@nestjs/swagger';
import { VendorDocumentType } from '@prisma/client';
import { IsDateString, IsEnum, IsOptional, IsString, IsUrl, MinLength } from 'class-validator';

export class UploadVendorDocumentDto {
  @ApiProperty({ enum: VendorDocumentType })
  @IsEnum(VendorDocumentType)
  documentType!: VendorDocumentType;

  @ApiProperty({ example: 'https://cdn.example.com/vendor-docs/government-id.jpg' })
  @IsUrl()
  fileUrl!: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MinLength(1)
  documentNumber?: string;

  @ApiProperty({ required: false, example: '2024-01-15' })
  @IsOptional()
  @IsDateString()
  issuedDate?: string;

  @ApiProperty({ required: false, example: '2027-01-15' })
  @IsOptional()
  @IsDateString()
  expiryDate?: string;
}
