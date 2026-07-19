import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsInt, IsOptional, IsString, Length, Max, Min } from 'class-validator';

const trim = ({ value }: { value: unknown }): unknown => (typeof value === 'string' ? value.trim() : value);

export class UpdateReviewDto {
  @ApiProperty({ required: false, minimum: 1, maximum: 5 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(5)
  rating?: number;

  @ApiProperty({ required: false, minLength: 3, maxLength: 100 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(3, 100)
  title?: string;

  @ApiProperty({ required: false, minLength: 10, maxLength: 2000 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(10, 2000)
  body?: string;
}
