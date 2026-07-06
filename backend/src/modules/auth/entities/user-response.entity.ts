import { ApiProperty } from '@nestjs/swagger';
import { RoleName, UserStatus } from '@prisma/client';

export class UserResponseEntity {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  email!: string;

  @ApiProperty()
  firstName!: string;

  @ApiProperty()
  lastName!: string;

  @ApiProperty({ required: false, nullable: true })
  phone!: string | null;

  @ApiProperty({ enum: UserStatus })
  status!: UserStatus;

  @ApiProperty({ enum: RoleName, isArray: true })
  roles!: RoleName[];

  @ApiProperty()
  createdAt!: Date;
}
