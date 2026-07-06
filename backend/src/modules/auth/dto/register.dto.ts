import { ApiProperty } from '@nestjs/swagger';
import { RoleName } from '@prisma/client';
import { IsEmail, IsEnum, IsIn, IsOptional, IsPhoneNumber, IsString, MinLength } from 'class-validator';

import { IsStrongPassword } from '../validators/is-strong-password.validator';
import { Match } from '../validators/match.validator';

export const SELF_REGISTERABLE_ROLES = [
  RoleName.CUSTOMER,
  RoleName.VENDOR,
  RoleName.DRIVER,
] as const;

export class RegisterDto {
  @ApiProperty({ example: 'customer@example.com' })
  @IsEmail()
  email!: string;

  @ApiProperty({ example: 'StrongPass1' })
  @IsStrongPassword()
  password!: string;

  @ApiProperty({ example: 'StrongPass1' })
  @Match('password')
  confirmPassword!: string;

  @ApiProperty({ example: 'Jane' })
  @IsString()
  @MinLength(1)
  firstName!: string;

  @ApiProperty({ example: 'Doe' })
  @IsString()
  @MinLength(1)
  lastName!: string;

  @ApiProperty({ example: '+18765551234', required: false })
  @IsOptional()
  @IsPhoneNumber()
  phone?: string;

  @ApiProperty({ enum: SELF_REGISTERABLE_ROLES, default: RoleName.CUSTOMER, required: false })
  @IsOptional()
  @IsEnum(RoleName)
  @IsIn(SELF_REGISTERABLE_ROLES)
  role?: (typeof SELF_REGISTERABLE_ROLES)[number];
}
