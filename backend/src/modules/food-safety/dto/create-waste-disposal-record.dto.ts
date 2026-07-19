import { ApiProperty } from '@nestjs/swagger';
import { WasteReason, WeightUnit } from '@prisma/client';
import {
  IsArray,
  IsEnum,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  IsUrl,
  IsUUID,
  MinLength,
} from 'class-validator';

export class CreateWasteDisposalRecordDto {
  @ApiProperty()
  @IsUUID()
  lotId!: string;

  @ApiProperty({ required: false, description: 'Optional - when set, decrements the product stock and writes a DISPOSED inventory event' })
  @IsOptional()
  @IsUUID()
  productId?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsUUID()
  recallId?: string;

  @ApiProperty({ example: 12.5 })
  @IsNumber()
  @IsPositive()
  quantity!: number;

  @ApiProperty({ enum: WeightUnit })
  @IsEnum(WeightUnit)
  weightUnit!: WeightUnit;

  @ApiProperty({ enum: WasteReason })
  @IsEnum(WasteReason)
  reason!: WasteReason;

  @ApiProperty({ required: false, example: 'Incineration at licensed facility' })
  @IsOptional()
  @IsString()
  disposalMethod?: string;

  @ApiProperty({ required: false, type: [String] })
  @IsOptional()
  @IsArray()
  @IsUrl({}, { each: true })
  evidencePhotoUrls?: string[];

  @ApiProperty({ required: false, description: 'Required when reason is RECALL_DESTRUCTION' })
  @IsOptional()
  @IsString()
  @MinLength(2)
  witnessName?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  witnessTitle?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsUrl()
  witnessSignatureUrl?: string;
}
