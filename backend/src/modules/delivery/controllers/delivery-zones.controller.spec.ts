import { DeliveryZoneResponseEntity } from '../entities/delivery-zone-response.entity';
import { DeliveryZonesService } from '../services/delivery-zones.service';
import { ZoneResolutionService } from '../services/zone-resolution.service';
import { DeliveryZonesController } from './delivery-zones.controller';

const zone: DeliveryZoneResponseEntity = {
  id: 'zone-1',
  name: 'Zone 1',
  code: 'ZONE_1',
  description: null,
  active: true,
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe('DeliveryZonesController', () => {
  let deliveryZonesService: jest.Mocked<Pick<DeliveryZonesService, 'list' | 'create' | 'update'>>;
  let zoneResolutionService: jest.Mocked<Pick<ZoneResolutionService, 'resolveZoneForParish'>>;
  let controller: DeliveryZonesController;

  beforeEach(() => {
    deliveryZonesService = {
      list: jest.fn().mockResolvedValue([zone]),
      create: jest.fn().mockResolvedValue(zone),
      update: jest.fn().mockResolvedValue({ ...zone, active: false }),
    };
    zoneResolutionService = { resolveZoneForParish: jest.fn().mockResolvedValue('zone-1') };
    controller = new DeliveryZonesController(
      deliveryZonesService as unknown as DeliveryZonesService,
      zoneResolutionService as unknown as ZoneResolutionService,
    );
  });

  it('lists delivery zones', async () => {
    await expect(controller.list()).resolves.toEqual([zone]);
  });

  it('resolves the zone mapped to a parish', async () => {
    await expect(controller.resolve({ parish: 'KINGSTON' })).resolves.toEqual({
      zoneId: 'zone-1',
    });
    expect(zoneResolutionService.resolveZoneForParish).toHaveBeenCalledWith('KINGSTON');
  });

  it('creates a delivery zone', async () => {
    const dto = { name: 'Zone 1', code: 'ZONE_1' };
    await expect(controller.create(dto)).resolves.toEqual(zone);
    expect(deliveryZonesService.create).toHaveBeenCalledWith(dto);
  });

  it('updates a delivery zone', async () => {
    const result = await controller.update('zone-1', { active: false });
    expect(result.active).toBe(false);
    expect(deliveryZonesService.update).toHaveBeenCalledWith('zone-1', { active: false });
  });
});
