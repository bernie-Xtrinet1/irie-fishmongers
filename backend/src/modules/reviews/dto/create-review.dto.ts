import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsInt, IsOptional, IsString, IsUUID, Length, Max, Min } from 'class-validator';

const trim = ({ value }: { value: unknown }): unknown => (typeof value === 'string' ? value.trim() : value);

export class CreateReviewDto {
  @ApiProperty({ description: 'The completed vendor order this review is written about' })
  @IsUUID()
  vendorOrderId!: string;

  @ApiProperty({ required: false, description: 'Omit for a vendor-only review; set to review a specific purchased product' })
  @IsOptional()
  @IsUUID()
  productId?: string;

  @ApiProperty({ minimum: 1, maximum: 5 })
  @IsInt()
  @Min(1)
  @Max(5)
  rating!: number;

  @ApiProperty({ required: false, minLength: 3, maxLength: 100 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(3, 100)
  title?: string;

  @ApiProperty({ minLength: 10, maxLength: 2000 })
  @Transform(trim)
  @IsString()
  @Length(10, 2000)
  body!: string;
}
