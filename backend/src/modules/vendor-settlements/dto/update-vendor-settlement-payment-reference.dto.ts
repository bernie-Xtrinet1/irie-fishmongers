import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class UpdateVendorSettlementPaymentReferenceDto {
  @ApiProperty({ example: 'NCB-WIRE-20261125-001' })
  @IsString()
  @MinLength(3)
  @MaxLength(128)
  paymentReference!: string;

  @ApiProperty({ required: false, example: 'Updated wire reference after bank confirmation' })
  @IsOptional()
  @IsString()
  @MinLength(5)
  notes?: string;
}
