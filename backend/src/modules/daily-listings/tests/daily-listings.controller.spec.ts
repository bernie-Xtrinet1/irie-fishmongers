import { ListingLifecycleStatus, ProductUnit, RoleName, VendorTier } from '@prisma/client';

import { RequestUser } from '../../../common/guards/jwt-auth.guard';
import { AdminDailyListingsController } from '../controllers/admin-daily-listings.controller';
import { DailyListingsController } from '../controllers/daily-listings.controller';
import { VendorDailyListingsController } from '../controllers/vendor-daily-listings.controller';
import { CreateDailyListingDto } from '../dto/create-daily-listing.dto';
import { DailyListingResponseEntity } from '../entities/daily-listing-response.entity';
import { DailyListingsService } from '../services/daily-listings.service';

describe('Daily Listings Controllers', () => {
  let dailyListingsService: jest.Mocked<DailyListingsService>;
  let vendorController: VendorDailyListingsController;
  let publicController: DailyListingsController;
  let adminController: AdminDailyListingsController;

  const mockUser: RequestUser = {
    id: 'user-1',
    email: 'vendor@example.com',
    roles: [RoleName.VENDOR],
  };

  const mockAdminUser: RequestUser = {
    id: 'admin-1',
    email: 'admin@example.com',
    roles: [RoleName.ADMINISTRATOR],
  };

  const sampleListingResponse: DailyListingResponseEntity = {
    id: 'listing-1',
    vendorId: 'vendor-1',
    productId: 'prod-1',
    catalogueItemId: 'cat-item-1',
    lotId: 'lot-1',
    landingSiteId: null,
    listingTitle: 'Morning Catch',
    description: 'Fresh snapper',
    catchDate: new Date('2026-10-19T05:00:00Z'),
    availableFrom: new Date('2026-10-19T06:00:00Z'),
    expiresAt: new Date('2026-10-19T20:00:00Z'),
    unit: ProductUnit.PER_POUND,
    price: 850,
    currency: 'JMD',
    quantityUploaded: 50,
    quantityAvailable: 50,
    quantityReserved: 0,
    quantitySold: 0,
    preparationOptions: null,
    deliveryAvailable: true,
    pickupAvailable: true,
    status: ListingLifecycleStatus.DRAFT,
    derivedStatus: 'DRAFT',
    createdAt: new Date(),
    updatedAt: new Date(),
    photos: [],
    speciesDeclarations: [],
  };

  beforeEach(() => {
    dailyListingsService = {
      create: jest.fn().mockResolvedValue(sampleListingResponse),
      update: jest.fn().mockResolvedValue(sampleListingResponse),
      publish: jest.fn().mockResolvedValue({
        ...sampleListingResponse,
        status: ListingLifecycleStatus.PUBLISHED,
        derivedStatus: 'PUBLISHED',
      }),
      withdraw: jest.fn().mockResolvedValue({
        ...sampleListingResponse,
        status: ListingLifecycleStatus.WITHDRAWN,
        derivedStatus: 'WITHDRAWN',
      }),
      repeat: jest.fn().mockResolvedValue({
        ...sampleListingResponse,
        id: 'listing-2',
      }),
      findById: jest.fn().mockResolvedValue(sampleListingResponse),
      findOwnedById: jest.fn().mockResolvedValue(sampleListingResponse),
      findPublicById: jest.fn().mockResolvedValue(sampleListingResponse),
      getAvailableTodayMarketplace: jest.fn().mockResolvedValue({
        items: [],
        total: 0,
        page: 1,
        limit: 12,
        totalPages: 0,
      }),
      findMany: jest.fn().mockResolvedValue({
        items: [sampleListingResponse],
        total: 1,
        page: 1,
        limit: 20,
        totalPages: 1,
      }),
      findMyListings: jest.fn().mockResolvedValue({
        items: [sampleListingResponse],
        total: 1,
        page: 1,
        limit: 20,
        totalPages: 1,
      }),
      findActiveByCatalogueItemId: jest.fn().mockResolvedValue([sampleListingResponse]),
      addPhoto: jest.fn().mockResolvedValue({
        id: 'photo-1',
        vendorDailyListingId: 'listing-1',
        url: 'https://cdn.example.com/photo.jpg',
        isPrimary: true,
        moderationStatus: 'APPROVED',
        uploadedAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
      withdrawPhoto: jest.fn().mockResolvedValue({
        id: 'photo-1',
        vendorDailyListingId: 'listing-1',
        url: 'https://cdn.example.com/photo.jpg',
        isPrimary: false,
        moderationStatus: 'APPROVED',
        uploadedAt: new Date(),
        withdrawnAt: new Date(),
        withdrawnReason: 'Wrong image',
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
      setPrimaryPhoto: jest.fn().mockResolvedValue({
        id: 'photo-1',
        vendorDailyListingId: 'listing-1',
        url: 'https://cdn.example.com/photo.jpg',
        isPrimary: true,
        moderationStatus: 'APPROVED',
        uploadedAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
      suspend: jest.fn().mockResolvedValue({
        ...sampleListingResponse,
        status: ListingLifecycleStatus.SUSPENDED,
        derivedStatus: 'SUSPENDED',
      }),
      reinstate: jest.fn().mockResolvedValue({
        ...sampleListingResponse,
        status: ListingLifecycleStatus.PUBLISHED,
        derivedStatus: 'PUBLISHED',
      }),
    } as unknown as jest.Mocked<DailyListingsService>;

    vendorController = new VendorDailyListingsController(dailyListingsService);
    publicController = new DailyListingsController(dailyListingsService);
    adminController = new AdminDailyListingsController(dailyListingsService);
  });

  describe('VendorDailyListingsController', () => {
    it('creates listing via authenticated user', async () => {
      const dto: CreateDailyListingDto = {
        catalogueItemId: 'cat-item-1',
        lotId: 'lot-1',
        catchDate: '2026-10-19T05:00:00Z',
        expiresAt: '2026-10-19T20:00:00Z',
        unit: ProductUnit.PER_POUND,
        price: 850,
        quantityUploaded: 50,
      };

      const result = await vendorController.create(mockUser, dto);

      expect(dailyListingsService.create).toHaveBeenCalledWith(mockUser.id, dto);
      expect(result.id).toBe('listing-1');
    });

    it('queries vendor own listings', async () => {
      const result = await vendorController.findMyListings(mockUser, { page: 1, pageSize: 20 });

      expect(dailyListingsService.findMyListings).toHaveBeenCalledWith(mockUser.id, { page: 1, pageSize: 20 });
      expect(result.total).toBe(1);
    });

    it('retrieves a single vendor listing using ownership enforcement', async () => {
      const result = await vendorController.findOne(mockUser, 'listing-1');

      expect(dailyListingsService.findOwnedById).toHaveBeenCalledWith(mockUser.id, 'listing-1');
      expect(result.id).toBe('listing-1');
    });

    it('publishes listing', async () => {
      const result = await vendorController.publish(mockUser, 'listing-1');

      expect(dailyListingsService.publish).toHaveBeenCalledWith(mockUser.id, 'listing-1');
      expect(result.status).toBe(ListingLifecycleStatus.PUBLISHED);
    });

    it('withdraws listing', async () => {
      const result = await vendorController.withdraw(mockUser, 'listing-1', {
        reason: 'Reserved for private catering',
      });

      expect(dailyListingsService.withdraw).toHaveBeenCalledWith(mockUser.id, 'listing-1', {
        reason: 'Reserved for private catering',
      });
      expect(result.status).toBe(ListingLifecycleStatus.WITHDRAWN);
    });

    it('adds photo', async () => {
      const result = await vendorController.addPhoto(mockUser, 'listing-1', {
        url: 'https://cdn.example.com/photo.jpg',
      });

      expect(dailyListingsService.addPhoto).toHaveBeenCalledWith(mockUser.id, 'listing-1', {
        url: 'https://cdn.example.com/photo.jpg',
      });
      expect(result.id).toBe('photo-1');
    });

    it('withdraws photo', async () => {
      const result = await vendorController.withdrawPhoto(mockUser, 'listing-1', 'photo-1', {
        reason: 'Wrong image',
      });

      expect(dailyListingsService.withdrawPhoto).toHaveBeenCalledWith(
        mockUser.id,
        'listing-1',
        'photo-1',
        { reason: 'Wrong image' },
      );
      expect(result.withdrawnReason).toBe('Wrong image');
    });

    it('sets primary photo', async () => {
      const result = await vendorController.setPrimaryPhoto(mockUser, 'listing-1', 'photo-1');

      expect(dailyListingsService.setPrimaryPhoto).toHaveBeenCalledWith(
        mockUser.id,
        'listing-1',
        'photo-1',
      );
      expect(result.isPrimary).toBe(true);
    });
  });

  describe('DailyListingsController (Public Discovery)', () => {
    it('discovers active listings with activeOnly forced to true', async () => {
      const result = await publicController.findActiveListings({ page: 1, pageSize: 20 });

      expect(dailyListingsService.findMany).toHaveBeenCalledWith({
        page: 1,
        pageSize: 20,
        activeOnly: true,
      });
      expect(result.items.length).toBe(1);
    });

    it('discovers aggregated Available-Today marketplace catalogue items', async () => {
      const result = await publicController.getAvailableToday({ page: 1, pageSize: 12 });

      expect(dailyListingsService.getAvailableTodayMarketplace).toHaveBeenCalledWith({
        page: 1,
        pageSize: 12,
      });
      expect(result.items).toBeDefined();
    });

    it('retrieves public listing detail through findPublicById (fail-closed)', async () => {
      const result = await publicController.findOne('listing-1');

      expect(dailyListingsService.findPublicById).toHaveBeenCalledWith('listing-1');
      expect(result.id).toBe('listing-1');
    });

    it('finds active listings for a catalogue item', async () => {
      const result = await publicController.findByCatalogueItem('cat-item-1');

      expect(dailyListingsService.findActiveByCatalogueItemId).toHaveBeenCalledWith('cat-item-1');
      expect(result.length).toBe(1);
    });
  });

  describe('AdminDailyListingsController', () => {
    it('allows admin to query all listings', async () => {
      const result = await adminController.findAll({ page: 1, pageSize: 20 });

      expect(dailyListingsService.findMany).toHaveBeenCalledWith({ page: 1, pageSize: 20 });
      expect(result.total).toBe(1);
    });

    it('suspends listing with audited reason', async () => {
      const result = await adminController.suspend(mockAdminUser, 'listing-1', {
        reason: 'Regulatory investigation',
      });

      expect(dailyListingsService.suspend).toHaveBeenCalledWith(mockAdminUser.id, 'listing-1', {
        reason: 'Regulatory investigation',
      });
      expect(result.status).toBe(ListingLifecycleStatus.SUSPENDED);
    });

    it('reinstates listing after audit', async () => {
      const result = await adminController.reinstate(mockAdminUser, 'listing-1');

      expect(dailyListingsService.reinstate).toHaveBeenCalledWith(mockAdminUser.id, 'listing-1');
      expect(result.status).toBe(ListingLifecycleStatus.PUBLISHED);
    });
  });
});
