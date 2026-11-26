import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString, IsUUID } from 'class-validator';

export class QueryCataloguePhotosDto {
  @ApiProperty({ required: false, description: 'Filter approved catalogue photos to a specific Species ID' })
  @IsOptional()
  @IsUUID()
  speciesId?: string;

  @ApiProperty({
    required: false,
    description: 'Search across species commercial name, scientific name, and Jamaican market aliases',
  })
  @IsOptional()
  @IsString()
  search?: string;
}
