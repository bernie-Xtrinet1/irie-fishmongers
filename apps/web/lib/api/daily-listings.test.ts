import { Parish, ProductUnit } from '@iriefishmongers/types';

import { apiDelete, apiGet, apiPatch, apiPost } from '../api-client';
import {
  addDailyListingPhoto,
  createDailyListing,
  fetchActiveListings,
  fetchAvailableToday,
  fetchDailyListing,
  fetchListingsByCatalogueItem,
  fetchMyDailyListing,
  fetchMyDailyListings,
  publishDailyListing,
  setPrimaryDailyListingPhoto,
  updateDailyListing,
  withdrawDailyListing,
  withdrawDailyListingPhoto,
} from './daily-listings';

jest.mock('../api-client', () => ({
  apiDelete: jest.fn(),
  apiGet: jest.fn(),
  apiPatch: jest.fn(),
  apiPost: jest.fn(),
}));

const mockApiDelete = apiDelete as jest.MockedFunction<typeof apiDelete>;
const mockApiGet = apiGet as jest.MockedFunction<typeof apiGet>;
const mockApiPatch = apiPatch as jest.MockedFunction<typeof apiPatch>;
const mockApiPost = apiPost as jest.MockedFunction<typeof apiPost>;

describe('daily-listings API', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('fetchAvailableToday', () => {
    it('calls /daily-listings/available-today without params when none provided', async () => {
      mockApiGet.mockResolvedValueOnce({ items: [], total: 0, page: 1, pageSize: 20 });

      const result = await fetchAvailableToday();

      expect(mockApiGet).toHaveBeenCalledWith('/daily-listings/available-today');
      expect(result.items).toEqual([]);
    });

    it('serializes query parameters correctly', async () => {
      mockApiGet.mockResolvedValueOnce({ items: [], total: 0, page: 1, pageSize: 12 });

      await fetchAvailableToday({
        page: 1,
        pageSize: 12,
        search: 'snapper',
        parish: Parish.KINGSTON,
        unit: ProductUnit.PER_POUND,
        hasPreparationOptions: true,
        deliveryAvailable: true,
      });

      expect(mockApiGet).toHaveBeenCalledWith(
        '/daily-listings/available-today?page=1&pageSize=12&search=snapper&parish=KINGSTON&unit=PER_POUND&hasPreparationOptions=true&deliveryAvailable=true',
      );
    });
  });

  describe('fetchActiveListings', () => {
    it('calls /daily-listings with query params', async () => {
      mockApiGet.mockResolvedValueOnce({ items: [], total: 0, page: 1, pageSize: 20 });

      await fetchActiveListings({ categoryId: 'cat-1' });

      expect(mockApiGet).toHaveBeenCalledWith('/daily-listings?categoryId=cat-1');
    });
  });

  describe('fetchListingsByCatalogueItem', () => {
    it('calls /daily-listings/catalogue-item/:id with encoded id', async () => {
      mockApiGet.mockResolvedValueOnce([]);

      await fetchListingsByCatalogueItem('cat/item-1');

      expect(mockApiGet).toHaveBeenCalledWith('/daily-listings/catalogue-item/cat%2Fitem-1');
    });
  });

  describe('fetchDailyListing', () => {
    it('calls /daily-listings/:id with encoded id', async () => {
      mockApiGet.mockResolvedValueOnce({ id: 'dl-1' });

      const result = await fetchDailyListing('dl-1');

      expect(mockApiGet).toHaveBeenCalledWith('/daily-listings/dl-1');
      expect(result.id).toBe('dl-1');
    });
  });

  describe('vendor daily-listings endpoints', () => {
    it('lists and fetches vendor-owned listings', async () => {
      mockApiGet.mockResolvedValueOnce({ items: [], total: 0, page: 1, limit: 20, totalPages: 0 });
      await fetchMyDailyListings({ page: 1, pageSize: 20 });
      expect(mockApiGet).toHaveBeenCalledWith('/vendor/daily-listings?page=1&pageSize=20');

      mockApiGet.mockResolvedValueOnce({ id: 'dl-1' });
      await fetchMyDailyListing('dl/1');
      expect(mockApiGet).toHaveBeenCalledWith('/vendor/daily-listings/dl%2F1');
    });

    it('creates, updates, publishes, and withdraws vendor listings', async () => {
      const createPayload = {
        catalogueItemId: 'cat-1',
        lotId: 'lot-1',
        catchDate: '2026-11-21T06:00:00.000Z',
        expiresAt: '2026-11-21T20:00:00.000Z',
        unit: ProductUnit.PER_POUND,
        price: 900,
        quantityUploaded: 25,
      };
      mockApiPost.mockResolvedValueOnce({ id: 'dl-1' });
      await createDailyListing(createPayload);
      expect(mockApiPost).toHaveBeenCalledWith('/vendor/daily-listings', createPayload);

      mockApiPatch.mockResolvedValueOnce({ id: 'dl-1' });
      await updateDailyListing('dl-1', { price: 950 });
      expect(mockApiPatch).toHaveBeenCalledWith('/vendor/daily-listings/dl-1', { price: 950 });

      mockApiPost.mockResolvedValueOnce({ id: 'dl-1', status: 'PUBLISHED' });
      await publishDailyListing('dl-1');
      expect(mockApiPost).toHaveBeenCalledWith('/vendor/daily-listings/dl-1/publish', {});

      mockApiPost.mockResolvedValueOnce({ id: 'dl-1', status: 'WITHDRAWN' });
      await withdrawDailyListing('dl-1', 'Sold out locally');
      expect(mockApiPost).toHaveBeenCalledWith('/vendor/daily-listings/dl-1/withdraw', {
        reason: 'Sold out locally',
      });
    });

    it('adds, promotes primary, and withdraws catch photos', async () => {
      mockApiPost.mockResolvedValueOnce({ id: 'photo-1' });
      await addDailyListingPhoto('dl-1', {
        url: 'https://images.example.com/snapper.jpg',
        caption: 'Fresh catch',
        isPrimary: true,
      });
      expect(mockApiPost).toHaveBeenCalledWith('/vendor/daily-listings/dl-1/photos', {
        url: 'https://images.example.com/snapper.jpg',
        caption: 'Fresh catch',
        isPrimary: true,
      });

      mockApiPatch.mockResolvedValueOnce({ id: 'photo-1', isPrimary: true });
      await setPrimaryDailyListingPhoto('dl-1', 'photo-1');
      expect(mockApiPatch).toHaveBeenCalledWith('/vendor/daily-listings/dl-1/photos/photo-1/primary', {});

      mockApiDelete.mockResolvedValueOnce({ id: 'photo-1' });
      await withdrawDailyListingPhoto('dl-1', 'photo-1', 'Blurry shot');
      expect(mockApiDelete).toHaveBeenCalledWith('/vendor/daily-listings/dl-1/photos/photo-1', {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'Blurry shot' }),
      });
    });
  });
});
