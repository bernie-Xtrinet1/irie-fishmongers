import { ApiProperty } from '@nestjs/swagger';
import { IsDateString, IsOptional, IsString, IsUrl } from 'class-validator';

export class CreateDriverColdChainCertificationDto {
  @ApiProperty({ description: 'Certifying body or program, e.g. "HACCP Cold Chain Handler"' })
  @IsString()
  issuedBy!: string;

  @ApiProperty()
  @IsDateString()
  issuedAt!: string;

  @ApiProperty()
  @IsDateString()
  expiresAt!: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsUrl()
  documentUrl?: string;
}
