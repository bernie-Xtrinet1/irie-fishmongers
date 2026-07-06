import { ApiProperty } from '@nestjs/swagger';
import { ProductUnit } from '@prisma/client';
import { IsEnum, IsInt, IsNumber, IsOptional, IsString, IsUrl, IsUUID, Min, MinLength } from 'class-validator';

export class CreateProductDto {
  @ApiProperty()
  @IsUUID()
  categoryId!: string;

  @ApiProperty({
    required: false,
    description: 'Seafood lot this product traces back to; must belong to the same vendor and be SAFE',
  })
  @IsOptional()
  @IsUUID()
  lotId?: string;

  @ApiProperty({ example: 'Fresh Red Snapper' })
  @IsString()
  @MinLength(2)
  name!: string;

  @ApiProperty({ example: 'Whole red snapper, caught daily off the north coast.' })
  @IsString()
  @MinLength(10)
  description!: string;

  @ApiProperty({ enum: ProductUnit })
  @IsEnum(ProductUnit)
  unit!: ProductUnit;

  @ApiProperty({ example: 850.0, description: 'Price in JMD' })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  price!: number;

  @ApiProperty({ example: 25 })
  @IsInt()
  @Min(0)
  quantityAvailable!: number;

  @ApiProperty({ example: 'https://cdn.iriefishmongers.com/products/snapper.jpg' })
  @IsUrl()
  imageUrl!: string;
}
