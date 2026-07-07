import { Controller, Get, Param, Patch, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse as ApiResponseDoc, ApiTags } from '@nestjs/swagger';

import { PaginationDto } from '../../../common/dto/pagination.dto';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { JwtAuthGuard, RequestUser } from '../../../common/guards/jwt-auth.guard';
import { NotificationResponseEntity } from '../entities/notification-response.entity';
import { PaginatedNotificationsEntity } from '../entities/paginated-notifications.entity';
import { NotificationsService } from '../services/notifications.service';

@ApiTags('notifications')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notificationsService: NotificationsService) {}

  @Get('mine')
  @ApiOperation({ summary: "List the authenticated user's notifications" })
  @ApiResponseDoc({ status: 200, type: PaginatedNotificationsEntity })
  listMine(
    @CurrentUser() user: RequestUser,
    @Query() dto: PaginationDto,
  ): Promise<PaginatedNotificationsEntity> {
    return this.notificationsService.listMine(user.id, dto);
  }

  @Patch(':id/read')
  @ApiOperation({ summary: 'Mark one of the authenticated user\'s notifications as read' })
  @ApiResponseDoc({ status: 200, type: NotificationResponseEntity })
  markRead(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
  ): Promise<NotificationResponseEntity> {
    return this.notificationsService.markRead(user.id, id);
  }
}
