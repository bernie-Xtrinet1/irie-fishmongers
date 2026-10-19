import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsNumber, IsOptional, IsString, Min } from 'class-validator';

export class PreparationOptionDto {
  @ApiProperty({ description: 'Option identifier (e.g. scaled, filleted, gutted)', example: 'scaled' })
  @IsString()
  @IsNotEmpty()
  id: string;

  @ApiProperty({ description: 'Human-readable option label', example: 'Scaled & Gutted' })
  @IsString()
  @IsNotEmpty()
  label: string;

  @ApiProperty({ description: 'Preparation fee per unit in listing currency', example: 150.0 })
  @IsNumber()
  @Min(0)
  fee: number;

  @ApiPropertyOptional({ description: 'Fee currency code', default: 'JMD', example: 'JMD' })
  @IsOptional()
  @IsString()
  currency?: string;
}
