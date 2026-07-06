import { ApiProperty, OmitType, PartialType } from '@nestjs/swagger';
import { IsOptional, IsUrl } from 'class-validator';

import { RegisterVendorDto } from './register-vendor.dto';

export class UpdateVendorProfileDto extends PartialType(
  OmitType(RegisterVendorDto, ['acceptedTerms']),
) {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsUrl()
  logoUrl?: string;
}
