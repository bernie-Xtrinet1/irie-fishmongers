import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsUUID } from 'class-validator';

export class ReconcileInventoryDto {
  @ApiProperty({ required: false, description: 'Reconcile only this product; omit to reconcile all' })
  @IsOptional()
  @IsUUID()
  productId?: string;
}
