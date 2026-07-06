import { RoleName } from '@prisma/client';

import { RequestUser } from '../../../common/guards/jwt-auth.guard';
import { AffectedOrderEntity } from '../entities/affected-order.entity';
import { RecallResponseEntity } from '../entities/recall-response.entity';
import { RecallsService } from '../services/recalls.service';
import { RecallsController } from './recalls.controller';

const recall: RecallResponseEntity = {
  id: 'recall-1',
  severityClass: 'CLASS_II',
  status: 'DRAFT',
  reason: 'Elevated histamine levels detected in post-market sampling',
  rootCause: null,
  resolutionNotes: null,
  createdById: 'admin-1',
  lotIds: ['lot-1'],
  closedAt: null,
  createdAt: new Date(),
};

const affectedOrder: AffectedOrderEntity = {
  orderId: 'order-1',
  vendorOrderId: 'vo-1',
  customerId: 'customer-1',
  customerEmail: 'customer@example.com',
  productId: 'product-1',
  productName: 'Fresh Snapper',
  quantity: 2,
  lotId: 'lot-1',
};

const adminUser: RequestUser = { id: 'admin-1', email: 'a@example.com', roles: [RoleName.ADMINISTRATOR] };

describe('RecallsController', () => {
  let recallsService: jest.Mocked<
    Pick<RecallsService, 'create' | 'list' | 'getById' | 'updateStatus' | 'getAffectedOrders'>
  >;
  let controller: RecallsController;

  beforeEach(() => {
    recallsService = {
      create: jest.fn().mockResolvedValue(recall),
      list: jest.fn().mockResolvedValue({ items: [recall], total: 1, page: 1, pageSize: 20 }),
      getById: jest.fn().mockResolvedValue(recall),
      updateStatus: jest.fn().mockResolvedValue({ ...recall, status: 'ACTIVE' }),
      getAffectedOrders: jest.fn().mockResolvedValue([affectedOrder]),
    };
    controller = new RecallsController(recallsService as unknown as RecallsService);
  });

  it('creates a recall', async () => {
    const dto = {
      severityClass: 'CLASS_II' as const,
      reason: 'Elevated histamine levels detected in post-market sampling',
      lotIds: ['lot-1'],
    };
    await expect(controller.create(adminUser, dto)).resolves.toEqual(recall);
    expect(recallsService.create).toHaveBeenCalledWith('admin-1', dto);
  });

  it('lists recalls', async () => {
    const dto = { page: 1, pageSize: 20 };
    const result = await controller.list(dto);
    expect(result.total).toBe(1);
    expect(recallsService.list).toHaveBeenCalledWith(dto);
  });

  it('gets a recall by id', async () => {
    await expect(controller.getById('recall-1')).resolves.toEqual(recall);
    expect(recallsService.getById).toHaveBeenCalledWith('recall-1');
  });

  it('updates a recall status', async () => {
    const dto = { status: 'ACTIVE' as const };
    const result = await controller.updateStatus('recall-1', dto);
    expect(result.status).toBe('ACTIVE');
    expect(recallsService.updateStatus).toHaveBeenCalledWith('recall-1', dto);
  });

  it('lists affected orders for a recall', async () => {
    const result = await controller.getAffectedOrders('recall-1');
    expect(result).toEqual([affectedOrder]);
    expect(recallsService.getAffectedOrders).toHaveBeenCalledWith('recall-1');
  });
});
