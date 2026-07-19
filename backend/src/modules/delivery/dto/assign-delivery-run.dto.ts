import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString, IsUUID } from 'class-validator';

export class AssignDeliveryRunDto {
  @ApiProperty()
  @IsUUID()
  driverId!: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  fleetAssetId?: string;
}
