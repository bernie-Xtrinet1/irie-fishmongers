import { InventoryEventResponseEntity } from '../entities/inventory-event-response.entity';
import { InventoryEventsRepository } from '../repositories/inventory-events.repository';
import { InventoryReconciliationService } from '../services/inventory-reconciliation.service';
import { InventoryController } from './inventory.controller';

const event: InventoryEventResponseEntity = {
  id: 'event-1',
  productId: 'product-1',
  eventType: 'DECREMENTED',
  quantityDelta: -2,
  vendorOrderId: 'vendor-order-1',
  triggeredById: null,
  notes: null,
  createdAt: new Date(),
};

describe('InventoryController', () => {
  let eventsRepository: jest.Mocked<Pick<InventoryEventsRepository, 'findByProduct'>>;
  let reconciliationService: jest.Mocked<Pick<InventoryReconciliationService, 'reconcile'>>;
  let controller: InventoryController;

  beforeEach(() => {
    eventsRepository = {
      findByProduct: jest.fn().mockResolvedValue({ items: [event], total: 1 }),
    };
    reconciliationService = {
      reconcile: jest.fn().mockResolvedValue({ productsChecked: 1, reservationsReleased: 0 }),
    };
    controller = new InventoryController(
      eventsRepository as unknown as InventoryEventsRepository,
      reconciliationService as unknown as InventoryReconciliationService,
    );
  });

  it('lists the inventory event audit trail for a product', async () => {
    const result = await controller.getEvents('product-1', { page: 1, pageSize: 20 });

    expect(result).toEqual({ items: [event], total: 1, page: 1, pageSize: 20 });
    expect(eventsRepository.findByProduct).toHaveBeenCalledWith('product-1', { skip: 0, take: 20 });
  });

  it('reconciles a single product when productId is given', async () => {
    await expect(controller.reconcile({ productId: 'product-1' })).resolves.toEqual({
      productsChecked: 1,
      reservationsReleased: 0,
    });
    expect(reconciliationService.reconcile).toHaveBeenCalledWith('product-1');
  });

  it('reconciles all products when no productId is given', async () => {
    await controller.reconcile({});
    expect(reconciliationService.reconcile).toHaveBeenCalledWith(undefined);
  });
});
