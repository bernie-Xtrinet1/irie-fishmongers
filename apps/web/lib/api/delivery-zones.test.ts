import { apiGet } from '../api-client';
import {
  formatParish,
  PARISHES,
  resolveDeliveryZone,
} from './delivery-zones';

jest.mock('../api-client', () => ({
  apiGet: jest.fn(),
}));

const mockApiGet = apiGet as jest.MockedFunction<typeof apiGet>;

describe('delivery zones API', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('resolves the authenticated customer delivery zone by parish', async () => {
    mockApiGet.mockResolvedValue({ zoneId: 'zone-1' });

    await expect(resolveDeliveryZone('ST_ANDREW')).resolves.toEqual({
      zoneId: 'zone-1',
    });

    expect(mockApiGet).toHaveBeenCalledWith(
      '/delivery-zones/resolve?parish=ST_ANDREW',
    );
  });

  it('supports a parish without a delivery-zone mapping', async () => {
    mockApiGet.mockResolvedValue({ zoneId: null });

    await expect(resolveDeliveryZone('PORTLAND')).resolves.toEqual({
      zoneId: null,
    });
  });

  it('contains all fourteen Jamaica parishes', () => {
    expect(PARISHES).toHaveLength(14);
    expect(PARISHES).toContain('KINGSTON');
    expect(PARISHES).toContain('ST_THOMAS');
  });

  it('formats parish enum values for customers', () => {
    expect(formatParish('KINGSTON')).toBe('Kingston');
    expect(formatParish('ST_ANDREW')).toBe('St. Andrew');
    expect(formatParish('ST_ELIZABETH')).toBe('St. Elizabeth');
  });
});
