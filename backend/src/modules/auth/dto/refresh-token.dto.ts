import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';

export class RefreshTokenDto {
  @ApiProperty({
    description: 'Refresh token. Optional if sent via the refresh_token httpOnly cookie.',
    required: false,
  })
  @IsOptional()
  @IsString()
  refreshToken?: string;
}
