import { ApiProperty } from '@nestjs/swagger';
import { Parish } from '@prisma/client';
import { IsEnum, IsNumber, IsOptional, IsString, MinLength } from 'class-validator';

export class CreateLandingSiteDto {
  @ApiProperty({ example: 'Falmouth Landing Site' })
  @IsString()
  @MinLength(2)
  name!: string;

  @ApiProperty({ enum: Parish })
  @IsEnum(Parish)
  parish!: Parish;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsNumber()
  latitude?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsNumber()
  longitude?: number;
}
