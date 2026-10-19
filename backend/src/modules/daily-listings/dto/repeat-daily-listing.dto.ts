import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsISO8601, IsNotEmpty, IsNumber, IsOptional, IsPositive, IsString, IsUUID } from 'class-validator';

export class RepeatDailyListingDto {
  @ApiProperty({ description: 'New catch or stock-receipt date (ISO 8601)', example: '2026-10-20T05:00:00.000Z' })
  @IsISO8601()
  @IsNotEmpty()
  catchDate: string;

  @ApiProperty({ description: 'New expiry timestamp when listing stops being purchasable (ISO 8601)', example: '2026-10-20T20:00:00.000Z' })
  @IsISO8601()
  @IsNotEmpty()
  expiresAt: string;

  @ApiProperty({ description: 'Vendor stated quantity uploaded for today’s new listing', example: 45.0 })
  @IsNumber()
  @IsPositive()
  quantityUploaded: number;

  @ApiProperty({ description: 'Price per unit for today’s new listing in listing currency', example: 850.0 })
  @IsNumber()
  @IsPositive()
  price: number;

  @ApiProperty({ description: 'Fresh traceable SeafoodLot UUID for this new catch/batch', example: 'f1e2d3c4-b5a6-7890-1234-56789abcdef0' })
  @IsUUID()
  @IsNotEmpty()
  lotId: string;

  @ApiPropertyOptional({ description: 'Landing site UUID if different from previous listing' })
  @IsOptional()
  @IsUUID()
  landingSiteId?: string;

  @ApiPropertyOptional({ description: 'Updated listing title for today’s catch' })
  @IsOptional()
  @IsString()
  listingTitle?: string;

  @ApiPropertyOptional({ description: 'Updated catch or batch notes' })
  @IsOptional()
  @IsString()
  description?: string;
}
