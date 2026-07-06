import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches, MinLength } from 'class-validator';

export class CreateCategoryDto {
  @ApiProperty({ example: 'Fish' })
  @IsString()
  @MinLength(2)
  name!: string;

  @ApiProperty({ example: 'fish' })
  @IsString()
  @Matches(/^[a-z0-9]+(-[a-z0-9]+)*$/, {
    message: 'slug must be lowercase, alphanumeric, and hyphen-separated',
  })
  slug!: string;
}
