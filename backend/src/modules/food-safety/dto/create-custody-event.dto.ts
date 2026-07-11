import { ApiProperty } from '@nestjs/swagger';
import { CustodyEventType } from '@prisma/client';
import { IsEnum, IsNumber, IsOptional, IsString } from 'class-validator';

export class CreateCustodyEventDto {
  @ApiProperty({ required: false, description: 'At least one of catchId/lotId should be set' })
  @IsOptional()
  @IsString()
  catchId?: string;

  @ApiProperty({ required: false, description: 'At least one of catchId/lotId should be set' })
  @IsOptional()
  @IsString()
  lotId?: string;

  @ApiProperty({ enum: CustodyEventType })
  @IsEnum(CustodyEventType)
  eventType!: CustodyEventType;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  fromUserId?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  toUserId?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  location?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsNumber()
  latitude?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsNumber()
  longitude?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  notes?: string;
}
