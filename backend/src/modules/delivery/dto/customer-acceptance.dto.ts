import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, MinLength } from 'class-validator';

export const CUSTOMER_ACCEPTANCE_DECISIONS = ['ACCEPTED', 'REJECTED'] as const;

export class CustomerAcceptanceDto {
  @ApiProperty({ enum: CUSTOMER_ACCEPTANCE_DECISIONS })
  @IsIn(CUSTOMER_ACCEPTANCE_DECISIONS)
  decision!: (typeof CUSTOMER_ACCEPTANCE_DECISIONS)[number];

  @ApiProperty({
    required: false,
    description: 'Required when decision is REJECTED',
    example: 'Package arrived warm and the seal was broken',
  })
  @IsOptional()
  @IsString()
  @MinLength(5)
  reason?: string;
}
