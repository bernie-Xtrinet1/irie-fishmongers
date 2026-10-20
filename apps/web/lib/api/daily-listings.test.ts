import { Parish, ProductUnit } from '@iriefishmongers/types';

import { apiGet } from '../api-client';
import {
  fetchActiveListings,
  fetchAvailableToday,
  fetchDailyListing,
  fetchListingsByCatalogueItem,
} from './daily-listings';

jest.mock('../api-client', () => ({
  apiGet: jest.fn(),
}));

const mockApiGet = apiGet as jest.MockedFunction<typeof apiGet>;

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
});
