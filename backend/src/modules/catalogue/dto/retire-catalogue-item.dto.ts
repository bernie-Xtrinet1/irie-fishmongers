import { ApiProperty } from '@nestjs/swagger';
import { CatalogueRetirementReason } from '@prisma/client';
import { IsEnum, IsNotEmpty, IsOptional, IsString, IsUUID } from 'class-validator';

export class RetireCatalogueItemDto {
  @ApiProperty({ enum: CatalogueRetirementReason })
  @IsEnum(CatalogueRetirementReason)
  retirementReason!: CatalogueRetirementReason;

  @ApiProperty({ required: false, description: 'Explanation for retirement' })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  retirementNotes?: string;

  @ApiProperty({
    required: false,
    description: 'Surviving catalogue item ID if reason is DUPLICATE_CONSOLIDATION',
  })
  @IsOptional()
  @IsUUID()
  consolidatedIntoId?: string;
}
