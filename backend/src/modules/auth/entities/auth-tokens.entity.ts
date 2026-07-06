import { ApiProperty } from '@nestjs/swagger';

import { UserResponseEntity } from './user-response.entity';

export class AuthTokensEntity {
  @ApiProperty()
  accessToken!: string;

  @ApiProperty()
  refreshToken!: string;

  @ApiProperty({ type: UserResponseEntity })
  user!: UserResponseEntity;
}
