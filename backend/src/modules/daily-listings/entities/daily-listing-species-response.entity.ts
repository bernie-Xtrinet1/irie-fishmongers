import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class DailyListingSpeciesResponseEntity {
  @ApiProperty({ example: 'b1234567-89ab-cdef-0123-456789abcdef' })
  id: string;

  @ApiProperty({ example: 'c1234567-89ab-cdef-0123-456789abcdef' })
  vendorDailyListingId: string;

  @ApiProperty({ example: 'd1234567-89ab-cdef-0123-456789abcdef' })
  speciesId: string;

  @ApiPropertyOptional({ example: 60.0 })
  proportion?: number | null;

  @ApiPropertyOptional({ example: 'Predominantly Yellowtail Snapper' })
  notes?: string | null;

  @ApiPropertyOptional({ example: 'Lutjanus chrysurus' })
  scientificName?: string;

  @ApiPropertyOptional({ example: 'Yellowtail Snapper' })
  commercialName?: string;

  @ApiProperty({ example: '2026-10-19T06:00:00.000Z' })
  createdAt: Date;
}
