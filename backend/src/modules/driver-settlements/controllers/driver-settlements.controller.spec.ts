import { DriverSettlementResponseEntity } from '../entities/driver-settlement-response.entity';
import { RateConfigResponseEntity } from '../entities/rate-config-response.entity';
import { DriverSettlementsService } from '../services/driver-settlements.service';
import { DriverSettlementsController } from './driver-settlements.controller';

const settlement: DriverSettlementResponseEntity = {
  id: 'settlement-1',
  driverId: 'driver-1',
  deliveryId: 'delivery-1',
  vehicleOwnership: 'PERSONAL_VEHICLE',
  baseFee: '150',
  distanceKm: '12',
  distanceFee: '240',
  heavyLoadBonus: '0',
  peakBonus: '0',
  volumeBonus: '0',
  totalPayout: '390',
  status: 'PENDING',
  settlementPeriodStart: new Date(),
  settlementPeriodEnd: new Date(),
  payoutDate: null,
  notes: null,
  createdAt: new Date(),
};

const rateConfig: RateConfigResponseEntity = {
  id: 'rate-config-1',
  baseFee: '150',
  distanceCompensationEnabled: true,
  distanceRatePerKm: '20',
  heavyLoadThresholdLbs: '50',
  heavyLoadBonus: '200',
  peakBonus: '100',
  volumeBonusTier1Threshold: 20,
  volumeBonusTier1Amount: '1000',
  volumeBonusTier2Threshold: 40,
  volumeBonusTier2Amount: '3000',
  volumeBonusTier3Threshold: 60,
  volumeBonusTier3Amount: '5000',
  createdAt: new Date(),
};

const driverUser = { id: 'driver-user-1', email: 'a@b.com', roles: ['DRIVER' as const] };

describe('DriverSettlementsController', () => {
  let driverSettlementsService: jest.Mocked<
    Pick<
      DriverSettlementsService,
      | 'generateWeeklySettlements'
      | 'getMine'
      | 'list'
      | 'updateStatus'
      | 'getCurrentRateConfig'
      | 'createRateConfig'
    >
  >;
  let controller: DriverSettlementsController;

  beforeEach(() => {
    driverSettlementsService = {
      generateWeeklySettlements: jest
        .fn()
        .mockResolvedValue({ settlementPeriodStart: new Date(), settlementPeriodEnd: new Date(), settlementsCreated: 1 }),
      getMine: jest.fn().mockResolvedValue({ items: [settlement], total: 1, page: 1, pageSize: 20 }),
      list: jest.fn().mockResolvedValue({ items: [settlement], total: 1, page: 1, pageSize: 20 }),
      updateStatus: jest.fn().mockResolvedValue({ ...settlement, status: 'APPROVED' }),
      getCurrentRateConfig: jest.fn().mockResolvedValue(rateConfig),
      createRateConfig: jest.fn().mockResolvedValue(rateConfig),
    };
    controller = new DriverSettlementsController(
      driverSettlementsService as unknown as DriverSettlementsService,
    );
  });

  it('generates weekly settlements', async () => {
    const dto = { weekStart: '2026-06-29' };
    const result = await controller.generate(dto);
    expect(result.settlementsCreated).toBe(1);
    expect(driverSettlementsService.generateWeeklySettlements).toHaveBeenCalledWith('2026-06-29');
  });

  it("lists the driver's own settlements", async () => {
    const result = await controller.getMine(driverUser, { page: 1, pageSize: 20 });
    expect(result.total).toBe(1);
    expect(driverSettlementsService.getMine).toHaveBeenCalledWith('driver-user-1', {
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
    expect(driverSettlementsService.updateStatus).toHaveBeenCalledWith(
      'settlement-1',
      'APPROVED',
      undefined,
    );
  });

  it('gets the current rate config', async () => {
    await expect(controller.getRateConfig()).resolves.toEqual(rateConfig);
  });

  it('creates a new rate config', async () => {
    const dto = {
      baseFee: 150,
      distanceCompensationEnabled: true,
      distanceRatePerKm: 20,
      heavyLoadThresholdLbs: 50,
      heavyLoadBonus: 200,
      peakBonus: 100,
      volumeBonusTier1Threshold: 20,
      volumeBonusTier1Amount: 1000,
      volumeBonusTier2Threshold: 40,
      volumeBonusTier2Amount: 3000,
      volumeBonusTier3Threshold: 60,
      volumeBonusTier3Amount: 5000,
    };
    await expect(controller.createRateConfig(dto)).resolves.toEqual(rateConfig);
    expect(driverSettlementsService.createRateConfig).toHaveBeenCalledWith(dto);
  });
});
