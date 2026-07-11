import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsOptional, IsString, IsUrl, MinLength } from 'class-validator';

export class CreateRegulatoryAuthorityDto {
  @ApiProperty({ example: 'Fisheries Division / National Fisheries Authority' })
  @IsString()
  @MinLength(2)
  name!: string;

  @ApiProperty({ example: 'Jamaica', required: false })
  @IsOptional()
  @IsString()
  country?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsEmail()
  contactEmail?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  contactPhone?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsUrl()
  website?: string;
}
