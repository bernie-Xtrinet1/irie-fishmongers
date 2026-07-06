import { RoleName } from '@prisma/client';

import { RequestUser } from '../../../common/guards/jwt-auth.guard';
import { RecordReadingResultEntity } from '../entities/record-reading-result.entity';
import { TemperatureAlertResponseEntity } from '../entities/temperature-alert-response.entity';
import { TemperatureMonitoringService } from '../services/temperature-monitoring.service';
import { TemperatureMonitoringController } from './temperature-monitoring.controller';

const reading = {
  id: 'reading-1',
  lotId: 'lot-1',
  checkpoint: 'VENDOR_STORAGE' as const,
  temperatureC: '2.50',
  latitude: 17.9714,
  longitude: -76.7931,
  photoUrl: null,
  recordedAt: new Date(),
};

const alert: TemperatureAlertResponseEntity = {
  id: 'alert-1',
  readingId: 'reading-1',
  lotId: 'lot-1',
  severity: 'WARNING',
  actualC: '8.00',
  resolved: false,
  resolvedAt: null,
  createdAt: new Date(),
};

const recordResult: RecordReadingResultEntity = { reading, alert };

const vendorUser: RequestUser = { id: 'vendor-user-1', email: 'v@example.com', roles: [RoleName.VENDOR] };

describe('TemperatureMonitoringController', () => {
  let temperatureMonitoringService: jest.Mocked<
    Pick<TemperatureMonitoringService, 'recordReading' | 'getReadingsForLot' | 'listAlerts' | 'resolveAlert'>
  >;
  let controller: TemperatureMonitoringController;

  beforeEach(() => {
    temperatureMonitoringService = {
      recordReading: jest.fn().mockResolvedValue(recordResult),
      getReadingsForLot: jest.fn().mockResolvedValue({ items: [reading], total: 1, page: 1, pageSize: 20 }),
      listAlerts: jest.fn().mockResolvedValue({ items: [alert], total: 1, page: 1, pageSize: 20 }),
      resolveAlert: jest.fn().mockResolvedValue({ ...alert, resolved: true }),
    };
    controller = new TemperatureMonitoringController(
      temperatureMonitoringService as unknown as TemperatureMonitoringService,
    );
  });

  it('records a temperature reading', async () => {
    const dto = { lotId: 'lot-1', checkpoint: 'VENDOR_STORAGE' as const, temperatureC: 2.5 };
    await expect(controller.recordReading(vendorUser, dto)).resolves.toEqual(recordResult);
    expect(temperatureMonitoringService.recordReading).toHaveBeenCalledWith('vendor-user-1', dto);
  });

  it("gets a lot's reading history", async () => {
    const result = await controller.getReadingsForLot(vendorUser, 'lot-1', { page: 1, pageSize: 20 });
    expect(result.total).toBe(1);
    expect(temperatureMonitoringService.getReadingsForLot).toHaveBeenCalledWith(vendorUser, 'lot-1', {
      page: 1,
      pageSize: 20,
    });
  });

  it('lists temperature alerts', async () => {
    const dto = { page: 1, pageSize: 20 };
    const result = await controller.listAlerts(dto);
    expect(result.total).toBe(1);
    expect(temperatureMonitoringService.listAlerts).toHaveBeenCalledWith(dto);
  });

  it('resolves a temperature alert', async () => {
    const result = await controller.resolveAlert('alert-1');
    expect(result.resolved).toBe(true);
    expect(temperatureMonitoringService.resolveAlert).toHaveBeenCalledWith('alert-1');
  });
});
