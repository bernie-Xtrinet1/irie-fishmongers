import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean, IsNumber, IsOptional, IsUUID, Max, Min } from 'class-validator';

export class LinkSpeciesDto {
  @ApiProperty({ description: 'ID of the Species to link' })
  @IsUUID()
  speciesId!: string;

  @ApiProperty({ required: false, default: false, description: 'True if this is the primary species in the composition' })
  @IsOptional()
  @IsBoolean()
  isPrimary?: boolean;

  @ApiProperty({ required: false, description: 'Typical proportion/percentage in composition (0 to 100)' })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(100)
  typicalProportion?: number;
}
