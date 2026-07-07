import { ApiProperty } from '@nestjs/swagger';
import {
  NotificationCategory,
  NotificationChannel,
  NotificationEventType,
  NotificationPriority,
  NotificationStatus,
} from '@prisma/client';

export class NotificationResponseEntity {
  @ApiProperty()
  id!: string;

  @ApiProperty({ enum: NotificationCategory })
  category!: NotificationCategory;

  @ApiProperty({ enum: NotificationEventType })
  eventType!: NotificationEventType;

  @ApiProperty({ enum: NotificationChannel })
  channel!: NotificationChannel;

  @ApiProperty({ enum: NotificationPriority })
  priority!: NotificationPriority;

  @ApiProperty()
  title!: string;

  @ApiProperty()
  message!: string;

  @ApiProperty({ enum: NotificationStatus })
  status!: NotificationStatus;

  @ApiProperty({ required: false, nullable: true })
  sentAt!: Date | null;

  @ApiProperty({ required: false, nullable: true })
  readAt!: Date | null;

  @ApiProperty()
  createdAt!: Date;
}
