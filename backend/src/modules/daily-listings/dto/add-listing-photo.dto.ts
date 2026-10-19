import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsISO8601, IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class AddListingPhotoDto {
  @ApiProperty({ description: 'URL or storage reference of the actual-catch photograph', example: 'https://storage.iriefishmonger.com/listings/photo-1.jpg' })
  @IsString()
  @IsNotEmpty()
  url: string;

  @ApiPropertyOptional({ description: 'Photo caption or description', example: 'Today’s freshly scaled catch' })
  @IsOptional()
  @IsString()
  caption?: string;

  @ApiPropertyOptional({ description: 'Whether this photo is the primary display image for the listing', default: false })
  @IsOptional()
  @IsBoolean()
  isPrimary?: boolean;

  @ApiPropertyOptional({ description: 'Capture timestamp of the photograph (ISO 8601)', example: '2026-10-19T05:30:00.000Z' })
  @IsOptional()
  @IsISO8601()
  captureDate?: string;
}
