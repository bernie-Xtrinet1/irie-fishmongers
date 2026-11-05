import { BadRequestException } from '@nestjs/common';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PreparationChargeMethod } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsEnum, IsNotEmpty, IsNumber, IsOptional, IsString, Matches, Min } from 'class-validator';
import Decimal from 'decimal.js';

export const STRICT_MONETARY_DECIMAL_REGEX = /^(0|[1-9]\d*)(\.\d{1,2})?$/;

export class PreparationOptionDto {
  @ApiProperty({ description: 'Option identifier (e.g. scaled, filleted, gutted)', example: 'scaled' })
  @IsString()
  @IsNotEmpty()
  id: string;

  @ApiProperty({ description: 'Human-readable option label', example: 'Scaled & Gutted' })
  @IsString()
  @IsNotEmpty()
  label: string;

  @ApiPropertyOptional({ description: 'Legacy preparation fee per unit in listing currency', example: 150.0 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  fee?: number;

  @ApiPropertyOptional({
    enum: PreparationChargeMethod,
    description: 'V2 Preparation charge method: FIXED_PER_FISH, FIXED_PER_POUND, or NO_PREPARATION',
    example: PreparationChargeMethod.FIXED_PER_FISH,
  })
  @IsOptional()
  @IsEnum(PreparationChargeMethod)
  chargeMethod?: PreparationChargeMethod;

  @ApiPropertyOptional({
    description:
      'V2 Preparation rate in JMD. Accepts exact decimal string ("150.00") or clean 2-decimal number (150.00). Values with >2 decimal places are strictly rejected.',
    example: '150.00',
  })
  @IsOptional()
  @Transform(({ value }) => {
    if (value === undefined || value === null) return undefined;
    if (typeof value === 'number') {
      if (!Number.isFinite(value) || Number.isNaN(value)) {
        throw new BadRequestException('Preparation rate must be a finite numeric value');
      }
      if (value < 0) {
        throw new BadRequestException('Preparation rate cannot be negative');
      }
      let dec: Decimal;
      try {
        dec = new Decimal(value);
      } catch {
        throw new BadRequestException('Preparation rate could not be parsed as a valid decimal number');
      }
      if (dec.gte(100000000)) {
        throw new BadRequestException('Preparation rate exceeds maximum allowable magnitude (< 10^8)');
      }
      if (dec.decimalPlaces() > 2) {
        throw new BadRequestException(
          `Preparation rate "${value}" has more than 2 decimal places. Silent rounding is prohibited; provide an exact 2-decimal value or string.`,
        );
      }
      return dec.toFixed(2);
    }
    if (typeof value === 'string') {
      const trimmed = value.trim();
      let dec: Decimal;
      try {
        dec = new Decimal(trimmed);
      } catch {
        throw new BadRequestException('Preparation rate could not be parsed as a valid decimal number');
      }
      if (!dec.isFinite() || dec.isNaN() || dec.isNegative()) {
        throw new BadRequestException('Preparation rate must be a non-negative finite value');
      }
      if (dec.gte(100000000)) {
        throw new BadRequestException('Preparation rate exceeds maximum allowable magnitude (< 10^8)');
      }
      if (dec.decimalPlaces() > 2) {
        throw new BadRequestException(
          `Preparation rate "${trimmed}" has more than 2 decimal places. Silent rounding is prohibited; provide an exact 2-decimal value or string.`,
        );
      }
      if (!STRICT_MONETARY_DECIMAL_REGEX.test(trimmed)) {
        throw new BadRequestException(
          `Preparation rate "${trimmed}" must be a normalized non-negative decimal string with at most 2 decimal places (e.g. "150.00").`,
        );
      }
      return trimmed;
    }
    return value;
  })
  @IsString()
  @Matches(STRICT_MONETARY_DECIMAL_REGEX, {
    message:
      'Preparation rate must be a normalized non-negative decimal string with at most 2 decimal places (e.g. "150.00")',
  })
  rate?: string;

  @ApiPropertyOptional({ description: 'Fee currency code', default: 'JMD', example: 'JMD' })
  @IsOptional()
  @IsString()
  currency?: string;
}
