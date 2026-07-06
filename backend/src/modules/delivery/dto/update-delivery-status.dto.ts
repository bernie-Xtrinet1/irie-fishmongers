import { ApiProperty } from '@nestjs/swagger';
import { ProofOfDeliveryType } from '@prisma/client';
import { IsEnum, IsIn, IsOptional, IsString, MinLength } from 'class-validator';

export const DELIVERY_STATUS_ACTIONS = ['PICKED_UP', 'DELIVERED', 'FAILED'] as const;
export type DeliveryStatusAction = (typeof DELIVERY_STATUS_ACTIONS)[number];

export class UpdateDeliveryStatusDto {
  @ApiProperty({ enum: DELIVERY_STATUS_ACTIONS })
  @IsIn(DELIVERY_STATUS_ACTIONS)
  action!: DeliveryStatusAction;

  @ApiProperty({
    enum: ProofOfDeliveryType,
    required: false,
    description: 'Required when action is DELIVERED',
  })
  @IsOptional()
  @IsEnum(ProofOfDeliveryType)
  proofType?: ProofOfDeliveryType;

  @ApiProperty({
    required: false,
    description: 'Required when action is DELIVERED',
    example: 'https://cdn.example.com/proof/signature-123.png',
  })
  @IsOptional()
  @IsString()
  @MinLength(5)
  proofUrl?: string;

  @ApiProperty({
    required: false,
    description: 'Required when action is FAILED',
    example: 'Customer not present at delivery address',
  })
  @IsOptional()
  @IsString()
  @MinLength(5)
  failureReason?: string;
}
