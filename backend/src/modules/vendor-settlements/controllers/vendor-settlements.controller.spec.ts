import { AdjustmentResponseEntity } from '../entities/adjustment-response.entity';
import { CommissionRateResponseEntity } from '../entities/commission-rate-response.entity';
import { VendorSettlementResponseEntity } from '../entities/vendor-settlement-response.entity';
import { VendorSettlementsService } from '../services/vendor-settlements.service';
import { VendorSettlementsController } from './vendor-settlements.controller';

const settlement: VendorSettlementResponseEntity = {
  id: 'settlement-1',
  vendorId: 'vendor-1',
  vendorOrderId: 'vo-1',
  grossAmount: '1000',
  platformFee: '100',
  netAmount: '900',
  adjustedNetAmount: '900',
  status: 'PENDING',
  paymentDate: null,
  notes: null,
  createdAt: new Date(),
};

const adjustment: AdjustmentResponseEntity = {
  id: 'adjustment-1',
  settlementId: 'settlement-1',
  amount: '-400',
  reason: 'Partial refund issued for damaged goods',
  createdAt: new Date(),
};

const commissionRate: CommissionRateResponseEntity = {
  id: 'rate-config-1',
  commissionRate: '0.1',
  createdAt: new Date(),
};

const vendorUser = { id: 'vendor-user-1', email: 'a@b.com', roles: ['VENDOR' as const] };

describe('VendorSettlementsController', () => {
  let vendorSettlementsService: jest.Mocked<
    Pick<
      VendorSettlementsService,
      | 'generateSettlements'
      | 'getMine'
      | 'list'
      | 'updateStatus'
      | 'createAdjustment'
      | 'getCurrentCommissionRate'
      | 'createCommissionRate'
    >
  >;
  let controller: VendorSettlementsController;

  beforeEach(() => {
    vendorSettlementsService = {
      generateSettlements: jest.fn().mockResolvedValue({ settlementsCreated: 1 }),
      getMine: jest.fn().mockResolvedValue({ items: [settlement], total: 1, page: 1, pageSize: 20 }),
      list: jest.fn().mockResolvedValue({ items: [settlement], total: 1, page: 1, pageSize: 20 }),
      updateStatus: jest.fn().mockResolvedValue({ ...settlement, status: 'APPROVED' }),
      createAdjustment: jest.fn().mockResolvedValue(adjustment),
      getCurrentCommissionRate: jest.fn().mockResolvedValue(commissionRate),
      createCommissionRate: jest.fn().mockResolvedValue(commissionRate),
    };
    controller = new VendorSettlementsController(
      vendorSettlementsService as unknown as VendorSettlementsService,
    );
  });

  it('generates settlements', async () => {
    const result = await controller.generate();
    expect(result.settlementsCreated).toBe(1);
  });

  it("lists the vendor's own settlements", async () => {
    const result = await controller.getMine(vendorUser, { page: 1, pageSize: 20 });
    expect(result.total).toBe(1);
    expect(vendorSettlementsService.getMine).toHaveBeenCalledWith('vendor-user-1', {
      page: 1,
      pageSize: 20,
    });
  });

  it('lists settlements for admins', async () => {
    const result = await controller.list({ page: 1, pageSize: 20 });
    expect(result.total).toBe(1);
  });

  it('updates a settlement status', async () => {
    const dto = { status: 'APPROVED' as const, notes: undefined };
    const result = await controller.updateStatus('settlement-1', dto);
    expect(result.status).toBe('APPROVED');
    expect(vendorSettlementsService.updateStatus).toHaveBeenCalledWith(
      'settlement-1',
      'APPROVED',
      undefined,
    );
  });

  it('creates an adjustment', async () => {
    const dto = { amount: -400, reason: 'Partial refund issued for damaged goods' };
    await expect(controller.createAdjustment('settlement-1', dto)).resolves.toEqual(adjustment);
    expect(vendorSettlementsService.createAdjustment).toHaveBeenCalledWith('settlement-1', dto);
  });

  it('gets the current commission rate', async () => {
    await expect(controller.getCommissionRate()).resolves.toEqual(commissionRate);
  });

  it('creates a new commission rate', async () => {
    const dto = { commissionRate: 0.12 };
    await expect(controller.createCommissionRate(dto)).resolves.toEqual(commissionRate);
    expect(vendorSettlementsService.createCommissionRate).toHaveBeenCalledWith(dto);
  });
});
