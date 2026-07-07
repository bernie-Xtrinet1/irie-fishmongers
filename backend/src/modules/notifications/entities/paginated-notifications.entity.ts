import { ApiProperty } from '@nestjs/swagger';

import { NotificationResponseEntity } from './notification-response.entity';

export class PaginatedNotificationsEntity {
  @ApiProperty({ type: NotificationResponseEntity, isArray: true })
  items!: NotificationResponseEntity[];

  @ApiProperty()
  total!: number;

  @ApiProperty()
  page!: number;

  @ApiProperty()
  pageSize!: number;
}
