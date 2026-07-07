import { RoleName } from '@prisma/client';

import { RequestUser } from '../../../common/guards/jwt-auth.guard';
import { NotificationResponseEntity } from '../entities/notification-response.entity';
import { PaginatedNotificationsEntity } from '../entities/paginated-notifications.entity';
import { NotificationsService } from '../services/notifications.service';
import { NotificationsController } from './notifications.controller';

const user: RequestUser = { id: 'user-1', email: 'jane@example.com', roles: [RoleName.CUSTOMER] };

const notification: NotificationResponseEntity = {
  id: 'notification-1',
  category: 'ORDER',
  eventType: 'ORDER_PLACED',
  channel: 'EMAIL',
  priority: 'NORMAL',
  title: 'Order placed',
  message: 'Your order has been placed',
  status: 'SENT',
  sentAt: new Date(),
  readAt: null,
  createdAt: new Date(),
};

const paginated: PaginatedNotificationsEntity = {
  items: [notification],
  total: 1,
  page: 1,
  pageSize: 20,
};

describe('NotificationsController', () => {
  let notificationsService: jest.Mocked<Pick<NotificationsService, 'listMine' | 'markRead'>>;
  let controller: NotificationsController;

  beforeEach(() => {
    notificationsService = {
      listMine: jest.fn().mockResolvedValue(paginated),
      markRead: jest.fn().mockResolvedValue({ ...notification, status: 'READ', readAt: new Date() }),
    };
    controller = new NotificationsController(notificationsService as unknown as NotificationsService);
  });

  it("lists the authenticated user's notifications", async () => {
    const result = await controller.listMine(user, { page: 1, pageSize: 20 });

    expect(result).toEqual(paginated);
    expect(notificationsService.listMine).toHaveBeenCalledWith('user-1', { page: 1, pageSize: 20 });
  });

  it('marks a notification as read for the authenticated user', async () => {
    const result = await controller.markRead(user, 'notification-1');

    expect(result.status).toBe('READ');
    expect(notificationsService.markRead).toHaveBeenCalledWith('user-1', 'notification-1');
  });
});
