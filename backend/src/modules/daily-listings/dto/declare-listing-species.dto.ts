import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsNumber, IsOptional, IsString, IsUUID, Max, Min } from 'class-validator';

export class DeclareListingSpeciesDto {
  @ApiProperty({ description: 'UUID of the Species being declared in this listing' })
  @IsUUID()
  @IsNotEmpty()
  speciesId: string;

  @ApiPropertyOptional({
    description: 'Proportion percentage of this species in the composite batch (0-100)',
    example: 60.0,
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  proportion?: number;

  @ApiPropertyOptional({ description: 'Additional declaration notes' })
  @IsOptional()
  @IsString()
  notes?: string;
}
