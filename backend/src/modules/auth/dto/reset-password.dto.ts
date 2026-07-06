import { ApiProperty } from '@nestjs/swagger';
import { IsString, MinLength } from 'class-validator';

import { IsStrongPassword } from '../validators/is-strong-password.validator';
import { Match } from '../validators/match.validator';

export class ResetPasswordDto {
  @ApiProperty({ description: 'Password reset token issued via the forgot-password flow' })
  @IsString()
  @MinLength(1)
  token!: string;

  @ApiProperty({ example: 'NewStrongPass1' })
  @IsStrongPassword()
  newPassword!: string;

  @ApiProperty({ example: 'NewStrongPass1' })
  @Match('newPassword')
  confirmPassword!: string;
}
