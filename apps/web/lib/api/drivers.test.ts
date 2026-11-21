import { ProofOfDeliveryType } from '@iriefishmongers/types';

import { apiGet, apiPatch, apiPost } from '../api-client';
import {
  claimAvailableDelivery,
  fetchAvailableDeliveries,
  fetchMyDeliveries,
  fetchMyDriverProfile,
  updateDeliverySchedule,
  updateDeliveryStatus,
  updateMyDriverAvailability,
} from './drivers';

jest.mock('../api-client', () => ({
  apiGet: jest.fn(),
  apiPatch: jest.fn(),
  apiPost: jest.fn(),
}));

const mockedGet = jest.mocked(apiGet);
const mockedPatch = jest.mocked(apiPatch);
const mockedPost = jest.mocked(apiPost);

describe('drivers API client', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('fetches authenticated driver profile and toggles availability', async () => {
    mockedGet.mockResolvedValue({ id: 'driver-1' });
    mockedPatch.mockResolvedValue({ id: 'driver-1', availabilityStatus: 'ONLINE' });

    await fetchMyDriverProfile();
    await updateMyDriverAvailability('ONLINE');

    expect(mockedGet).toHaveBeenCalledWith('/drivers/me');
    expect(mockedPatch).toHaveBeenCalledWith('/drivers/me/availability', { status: 'ONLINE' });
  });

  it('fetches available pickups and claims a vendor order', async () => {
    mockedGet.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 });
    mockedPost.mockResolvedValue({ id: 'delivery-1' });

    await fetchAvailableDeliveries(2, 10);
    await claimAvailableDelivery('vo-123');

    expect(mockedGet).toHaveBeenCalledWith('/delivery/available?page=2&pageSize=10');
    expect(mockedPost).toHaveBeenCalledWith('/delivery/assign', { vendorOrderId: 'vo-123' });
  });

  it('fetches driver deliveries and updates schedule and status', async () => {
    mockedGet.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 50 });
    mockedPatch.mockResolvedValue({ id: 'delivery-1' });

    await fetchMyDeliveries(1, 50);
    await updateDeliverySchedule('del-1', {
      scheduledPickupWindowStart: '2026-11-21T15:00:00.000Z',
    });
    await updateDeliveryStatus('del-1', {
      action: 'DELIVERED',
      proofType: ProofOfDeliveryType.PHOTO,
      proofUrl: 'https://cdn.example.com/proof/photo.png',
    });

    expect(mockedGet).toHaveBeenCalledWith('/delivery/mine?page=1&pageSize=50');
    expect(mockedPatch).toHaveBeenCalledWith('/delivery/del-1/schedule', {
      scheduledPickupWindowStart: '2026-11-21T15:00:00.000Z',
    });
    expect(mockedPatch).toHaveBeenCalledWith('/delivery/del-1/status', {
      action: 'DELIVERED',
      proofType: ProofOfDeliveryType.PHOTO,
      proofUrl: 'https://cdn.example.com/proof/photo.png',
    });
  });
});
