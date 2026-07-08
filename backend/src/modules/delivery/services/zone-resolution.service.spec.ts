import { DeliveryZonesRepository } from '../repositories/delivery-zones.repository';
import { ZoneResolutionService } from './zone-resolution.service';

describe('ZoneResolutionService', () => {
  let deliveryZonesRepository: jest.Mocked<Pick<DeliveryZonesRepository, 'findZoneIdForParish'>>;
  let service: ZoneResolutionService;

  beforeEach(() => {
    deliveryZonesRepository = { findZoneIdForParish: jest.fn() };
    service = new ZoneResolutionService(
      deliveryZonesRepository as unknown as DeliveryZonesRepository,
    );
  });

  it('resolves the zone id mapped to a parish', async () => {
    deliveryZonesRepository.findZoneIdForParish.mockResolvedValue('zone-1');
    await expect(service.resolveZoneForParish('KINGSTON')).resolves.toBe('zone-1');
    expect(deliveryZonesRepository.findZoneIdForParish).toHaveBeenCalledWith('KINGSTON');
  });

  it('returns null when the parish has no zone mapping', async () => {
    deliveryZonesRepository.findZoneIdForParish.mockResolvedValue(null);
    await expect(service.resolveZoneForParish('KINGSTON')).resolves.toBeNull();
  });
});
