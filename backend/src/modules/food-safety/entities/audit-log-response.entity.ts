import { ApiProperty } from '@nestjs/swagger';
import { Prisma } from '@prisma/client';

export class AuditLogResponseEntity {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  userId!: string;

  @ApiProperty()
  action!: string;

  @ApiProperty()
  entityType!: string;

  @ApiProperty()
  entityId!: string;

  @ApiProperty({ required: false, nullable: true })
  beforeValue!: Prisma.JsonValue;

  @ApiProperty({ required: false, nullable: true })
  afterValue!: Prisma.JsonValue;

  @ApiProperty({ required: false, nullable: true })
  ipAddress!: string | null;

  @ApiProperty({ required: false, nullable: true })
  reason!: string | null;

  @ApiProperty()
  createdAt!: Date;
}
