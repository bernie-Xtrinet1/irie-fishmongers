import { ApiProperty } from '@nestjs/swagger';
import { IsString, MinLength } from 'class-validator';

export class RegisterVendorDto {
  @ApiProperty({ example: "Jane's Fresh Catch" })
  @IsString()
  @MinLength(2)
  businessName!: string;
}
