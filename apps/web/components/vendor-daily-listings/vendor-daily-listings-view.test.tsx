import {
  FoodSafetyStatus,
  ListingLifecycleStatus,
  ListingPhotoModerationStatus,
  Parish,
  ProductUnit,
  SeafoodStorageType,
  UserRole,
  UserStatus,
  VendorStatus,
  VendorTier,
  WeightUnit,
  type DailyListingPhotoResponse,
  type DailyListingResponse,
  type SeafoodCatalogueItem,
  type SeafoodLotAdmin,
  type VendorAdmin,
} from '@iriefishmongers/types';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import { ApiError } from '@/lib/api-client';
import {
  addDailyListingPhoto,
  createDailyListing,
  fetchMyDailyListing,
  fetchMyDailyListings,
  publishDailyListing,
  setPrimaryDailyListingPhoto,
  updateDailyListing,
  withdrawDailyListing,
} from '@/lib/api/daily-listings';
import {
  evaluateRegulatoryEligibility,
  fetchLandingSites,
  fetchManagedSpecies,
  fetchMySeafoodLots,
  fetchMyVendorCompliance,
  fetchMyVendorProfile,
  fetchPublishedCatalogue,
} from '@/lib/api/vendors';
import { useAuth } from '@/lib/auth/auth-context';

import { VendorDailyListingsView } from './vendor-daily-listings-view';

jest.mock('@/lib/auth/auth-context');
jest.mock('@/lib/api/daily-listings', () => ({
  fetchMyDailyListings: jest.fn(),
  fetchMyDailyListing: jest.fn(),
  createDailyListing: jest.fn(),
  updateDailyListing: jest.fn(),
  publishDailyListing: jest.fn(),
  withdrawDailyListing: jest.fn(),
  addDailyListingPhoto: jest.fn(),
  setPrimaryDailyListingPhoto: jest.fn(),
  withdrawDailyListingPhoto: jest.fn(),
}));
jest.mock('@/lib/api/vendors', () => ({
  fetchMyVendorProfile: jest.fn(),
  fetchMyVendorCompliance: jest.fn(),
  fetchMySeafoodLots: jest.fn(),
  fetchPublishedCatalogue: jest.fn(),
  fetchLandingSites: jest.fn(),
  fetchManagedSpecies: jest.fn(),
  evaluateRegulatoryEligibility: jest.fn(),
}));

const mockUseAuth = useAuth as jest.MockedFunction<typeof useAuth>;
const mockFetchVendor = fetchMyVendorProfile as jest.MockedFunction<typeof fetchMyVendorProfile>;
const mockFetchCompliance = fetchMyVendorCompliance as jest.MockedFunction<
  typeof fetchMyVendorCompliance
>;
const mockFetchLots = fetchMySeafoodLots as jest.MockedFunction<typeof fetchMySeafoodLots>;
const mockFetchCatalogue = fetchPublishedCatalogue as jest.MockedFunction<
  typeof fetchPublishedCatalogue
>;
const mockFetchSites = fetchLandingSites as jest.MockedFunction<typeof fetchLandingSites>;
const mockFetchSpecies = fetchManagedSpecies as jest.MockedFunction<typeof fetchManagedSpecies>;
const mockEvaluateReg = evaluateRegulatoryEligibility as jest.MockedFunction<
  typeof evaluateRegulatoryEligibility
>;
const mockFetchMyListings = fetchMyDailyListings as jest.MockedFunction<
  typeof fetchMyDailyListings
>;
const mockFetchMyListing = fetchMyDailyListing as jest.MockedFunction<typeof fetchMyDailyListing>;
const mockCreateListing = createDailyListing as jest.MockedFunction<typeof createDailyListing>;
const mockUpdateListing = updateDailyListing as jest.MockedFunction<typeof updateDailyListing>;
const mockAddPhoto = addDailyListingPhoto as jest.MockedFunction<typeof addDailyListingPhoto>;
const mockSetPrimary = setPrimaryDailyListingPhoto as jest.MockedFunction<
  typeof setPrimaryDailyListingPhoto
>;
const mockPublishListing = publishDailyListing as jest.MockedFunction<
  typeof publishDailyListing
>;
const mockWithdrawListing = withdrawDailyListing as jest.MockedFunction<
  typeof withdrawDailyListing
>;

const vendorUser = {
  id: 'vendor-user-1',
  email: 'vendor@example.com',
  firstName: 'Vera',
  lastName: 'Vendor',
  phone: null,
  status: UserStatus.ACTIVE,
  roles: [UserRole.VENDOR],
  createdAt: '2026-08-31T00:00:00.000Z',
};

const vendorProfile: VendorAdmin = {
  id: 'vendor-1',
  userId: 'vendor-user-1',
  businessName: 'Harbour Catch Co.',
  description: null,
  phone: '8765550100',
  parish: Parish.KINGSTON,
  logoUrl: null,
  status: VendorStatus.APPROVED,
  tier: VendorTier.COMMUNITY_FISHER,
  complianceScore: 95,
  termsAcceptedAt: '2026-08-31T00:00:00.000Z',
  primaryZoneId: null,
  createdAt: '2026-08-31T00:00:00.000Z',
  updatedAt: '2026-08-31T00:00:00.000Z',
};

const safeLot: SeafoodLotAdmin = {
  id: 'lot-safe-1',
  lotNumber: 'LOT-2026-0101',
  vendorId: 'vendor-1',
  species: 'Red Snapper',
  storageType: SeafoodStorageType.FRESH,
  catchDate: new Date(Date.now() - 3600_000).toISOString(),
  catchLocation: 'Old Harbour Bay',
  landingSite: 'Old Harbour Bay',
  weight: '60',
  weightUnit: WeightUnit.POUNDS,
  freshnessGrade: null,
  qualityScore: 94,
  foodSafetyStatus: FoodSafetyStatus.SAFE,
  statusNotes: null,
  createdAt: new Date(Date.now() - 3600_000).toISOString(),
  retentionExpiresAt: new Date(Date.now() + 86400_000).toISOString(),
};

const holdLot: SeafoodLotAdmin = {
  ...safeLot,
  id: 'lot-hold-1',
  lotNumber: 'LOT-2026-0102',
  species: 'Queen Conch',
  foodSafetyStatus: FoodSafetyStatus.SAFETY_HOLD,
  statusNotes: 'Pending inspector clearance',
};

const snapperCatalogue: SeafoodCatalogueItem = {
  id: 'cat-1',
  name: 'Fresh Red Snapper',
  scientificName: 'Lutjanus campechanus',
  commonName: 'Red Snapper',
  jamaicanNames: ['Snapper'],
  description: 'Whole red snapper',
  categoryId: 'category-1',
  categoryName: 'Reef Fish',
  compositionMode: 'SINGLE_SPECIES',
  lifecycleStatus: 'PUBLISHED',
  referenceImageUrl: null,
  typicalUnit: ProductUnit.PER_POUND,
};

function renderWithQuery(): ReturnType<typeof render> {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <VendorDailyListingsView />
    </QueryClientProvider>,
  );
}

describe('VendorDailyListingsView', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockFetchVendor.mockResolvedValue(vendorProfile);
    mockFetchCompliance.mockResolvedValue({
      tier: VendorTier.COMMUNITY_FISHER,
      canSell: true,
      requiredDocuments: [{ type: 'GOVERNMENT_ID', status: 'APPROVED' }],
    });
    mockFetchLots.mockResolvedValue({
      items: [safeLot, holdLot],
      total: 2,
      page: 1,
      pageSize: 100,
    });
    mockFetchCatalogue.mockResolvedValue({
      data: [snapperCatalogue],
      meta: { total: 1, page: 1, limit: 100 },
    });
    mockFetchSites.mockResolvedValue([]);
    mockFetchSpecies.mockResolvedValue([]);
    mockFetchMyListings.mockResolvedValue({
      items: [],
      total: 0,
      page: 1,
      limit: 100,
      totalPages: 0,
    });
    mockEvaluateReg.mockResolvedValue({
      eligible: true,
      reasons: [],
      evaluatedAt: new Date().toISOString(),
      mode: 'ENFORCING',
    });
  });

  it('denies unauthenticated and non-vendor accounts cleanly', () => {
    mockUseAuth.mockReturnValue({
      status: 'unauthenticated',
      user: null,
      login: jest.fn(),
      logout: jest.fn(),
    });
    const { unmount } = renderWithQuery();
    expect(screen.getByRole('link', { name: 'Sign in' })).toHaveAttribute(
      'href',
      '/login?returnUrl=%2Fvendor%2Fdaily-listings',
    );
    expect(mockFetchVendor).not.toHaveBeenCalled();
    unmount();

    mockUseAuth.mockReturnValue({
      status: 'authenticated',
      user: { ...vendorUser, roles: [UserRole.CUSTOMER] },
      login: jest.fn(),
      logout: jest.fn(),
    });
    renderWithQuery();
    expect(
      screen.getByText('This page is available only to signed-in vendor accounts.'),
    ).toBeInTheDocument();
    expect(mockFetchMyListings).not.toHaveBeenCalled();
  });

  it('explains why no eligible lots exist and surfaces ineligible lot reasons', async () => {
    mockUseAuth.mockReturnValue({
      status: 'authenticated',
      user: vendorUser,
      login: jest.fn(),
      logout: jest.fn(),
    });
    mockFetchLots.mockResolvedValue({
      items: [holdLot],
      total: 1,
      page: 1,
      pageSize: 100,
    });

    renderWithQuery();

    const newBtn = await screen.findByRole('button', { name: /New catch listing/i });
    await waitFor(() => expect(newBtn).toBeEnabled());
    fireEvent.click(newBtn);

    expect(
      await screen.findByText(/You do not have any eligible seafood lots to list yet\./i),
    ).toBeInTheDocument();
    expect(screen.getByText(/LOT-2026-0102/i)).toBeInTheDocument();
    expect(
      screen.getByText(/Food safety status is SAFETY_HOLD; only SAFE lots may be listed \(Pending inspector clearance\)\./i),
    ).toBeInTheDocument();
  });

  it('runs Draft -> Photo (with retry) -> Primary -> Review (handles rejected publish) -> Publish -> Withdraw', async () => {
    mockUseAuth.mockReturnValue({
      status: 'authenticated',
      user: vendorUser,
      login: jest.fn(),
      logout: jest.fn(),
    });

    const baseDraft: DailyListingResponse = {
      id: 'dl-1',
      vendorId: 'vendor-1',
      productId: 'prod-1',
      catalogueItemId: 'cat-1',
      lotId: 'lot-safe-1',
      landingSiteId: null,
      listingTitle: 'Harbour Morning Snapper',
      description: 'Freshly caught',
      catchDate: safeLot.catchDate,
      availableFrom: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 8 * 3600_000).toISOString(),
      unit: ProductUnit.PER_POUND,
      price: 950,
      currency: 'JMD',
      quantityUploaded: 25,
      quantityAvailable: 25,
      quantityReserved: 0,
      quantitySold: 0,
      deliveryAvailable: true,
      pickupAvailable: true,
      status: ListingLifecycleStatus.DRAFT,
      derivedStatus: 'DRAFT',
      publishedAt: null,
      withdrawnAt: null,
      withdrawnReason: null,
      suspendedAt: null,
      suspensionReason: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      primaryPhoto: null,
      photos: [],
      speciesDeclarations: [],
      catalogueItem: {
        id: 'cat-1',
        name: 'Fresh Red Snapper',
        commonName: 'Red Snapper',
        categoryId: 'category-1',
        compositionMode: 'SINGLE_SPECIES',
      },
      lot: {
        id: 'lot-safe-1',
        lotNumber: 'LOT-2026-0101',
        publicTraceToken: 'trace-1',
        foodSafetyStatus: 'SAFE',
      },
    };

    const photo1: DailyListingPhotoResponse = {
      id: 'photo-1',
      vendorDailyListingId: 'dl-1',
      url: 'https://images.example.com/snapper-1.jpg',
      caption: 'On ice',
      isPrimary: true,
      moderationStatus: ListingPhotoModerationStatus.APPROVED,
      uploadedAt: new Date().toISOString(),
      captureDate: null,
      withdrawnAt: null,
      withdrawnReason: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const photo2: DailyListingPhotoResponse = {
      ...photo1,
      id: 'photo-2',
      url: 'https://images.example.com/snapper-2.jpg',
      caption: 'Whole side',
      isPrimary: false,
    };

    const listingWithTwoPhotos: DailyListingResponse = {
      ...baseDraft,
      primaryPhoto: { ...photo2, isPrimary: true },
      photos: [{ ...photo1, isPrimary: false }, { ...photo2, isPrimary: true }],
    };

    const publishedListing: DailyListingResponse = {
      ...listingWithTwoPhotos,
      status: ListingLifecycleStatus.PUBLISHED,
      derivedStatus: 'PUBLISHED',
      publishedAt: new Date().toISOString(),
    };

    let serverListing: DailyListingResponse = baseDraft;
    mockCreateListing.mockImplementation(() => {
      serverListing = baseDraft;
      return Promise.resolve(serverListing);
    });
    mockAddPhoto
      .mockRejectedValueOnce(new Error('Temporary network hiccup'))
      .mockImplementationOnce(() => {
        serverListing = { ...baseDraft, primaryPhoto: photo1, photos: [photo1] };
        return Promise.resolve(photo1);
      })
      .mockImplementationOnce(() => {
        serverListing = { ...baseDraft, primaryPhoto: photo1, photos: [photo1, photo2] };
        return Promise.resolve(photo2);
      });
    mockFetchMyListing.mockImplementation(() => Promise.resolve(serverListing));
    mockSetPrimary.mockImplementationOnce(() => {
      serverListing = listingWithTwoPhotos;
      return Promise.resolve({ ...photo2, isPrimary: true });
    });
    mockPublishListing
      .mockRejectedValueOnce(new ApiError('Closed season regulatory restriction', 400))
      .mockImplementationOnce(() => {
        serverListing = publishedListing;
        return Promise.resolve(publishedListing);
      });
    mockWithdrawListing.mockImplementationOnce(() => {
      serverListing = {
        ...publishedListing,
        status: ListingLifecycleStatus.WITHDRAWN,
        derivedStatus: 'WITHDRAWN',
        withdrawnReason: 'Sold out at pier',
      };
      return Promise.resolve(serverListing);
    });

    renderWithQuery();
    const newBtn = await screen.findByRole('button', { name: /New catch listing/i });
    await waitFor(() => expect(newBtn).toBeEnabled());
    fireEvent.click(newBtn);

    // Draft step: invalid missing price preserves title and surfaces validation message
    fireEvent.change(screen.getByLabelText('Catch title'), {
      target: { value: 'Harbour Morning Snapper' },
    });
    fireEvent.change(screen.getByLabelText('Quantity *'), { target: { value: '25' } });
    fireEvent.click(screen.getByRole('button', { name: /Save draft & continue to photos/i }));
    expect(
      await screen.findByText(/Price per unit must be greater than 0 JMD\./i),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Catch title')).toHaveValue('Harbour Morning Snapper');

    // Fill price and create draft
    fireEvent.change(screen.getByLabelText('Price per unit (JMD) *'), { target: { value: '950' } });
    fireEvent.click(screen.getByRole('button', { name: /Save draft & continue to photos/i }));

    await waitFor(() => expect(mockCreateListing).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/Step 2 · Actual catch photographs/i)).toBeInTheDocument();

    // Photo step: failed submission preserves draft + URL input and allows retry
    fireEvent.change(screen.getByLabelText('Actual catch photograph URL *'), {
      target: { value: 'https://images.example.com/snapper-1.jpg' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Add catch photo/i }));
    expect(await screen.findByText(/Temporary network hiccup/i)).toBeInTheDocument();
    expect(screen.getByLabelText('Actual catch photograph URL *')).toHaveValue(
      'https://images.example.com/snapper-1.jpg',
    );

    fireEvent.click(screen.getByRole('button', { name: /Retry photo upload/i }));
    expect(await screen.findByText(/Attached catch photos \(1\)/i)).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Add catch photo/i })).toBeEnabled(),
    );

    // Add second photo and promote it to primary
    fireEvent.change(screen.getByLabelText('Actual catch photograph URL *'), {
      target: { value: 'https://images.example.com/snapper-2.jpg' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Add catch photo/i }));
    expect(await screen.findByText(/Attached catch photos \(2\)/i)).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Set as primary/i })).toBeEnabled(),
    );

    fireEvent.click(screen.getByRole('button', { name: /Set as primary/i }));
    await waitFor(() => expect(mockSetPrimary).toHaveBeenCalledWith('dl-1', 'photo-2'));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Continue to Review/i })).toBeEnabled(),
    );

    // Review step: handle rejected publication cleanly preserving draft
    fireEvent.click(screen.getByRole('button', { name: /Continue to Review/i }));
    expect(await screen.findByText(/Step 3 · Review & publish/i)).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Publish to Available Today/i })).toBeEnabled(),
    );

    fireEvent.click(screen.getByRole('button', { name: /Publish to Available Today/i }));
    expect(
      await screen.findByText(/Publication rejected — your draft was preserved/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/Closed season regulatory restriction/i)).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Publish to Available Today/i })).toBeEnabled(),
    );

    // Retry publish cleanly -> Published confirmation + link to Available Today
    fireEvent.click(screen.getByRole('button', { name: /Publish to Available Today/i }));
    expect(
      await screen.findByText(/Step 4 · Published to Available Today/i),
    ).toBeInTheDocument();
    const availableLinks = screen.getAllByRole('link', { name: /View on Available Today/i });
    expect(availableLinks[0]).toHaveAttribute('href', '/#available-today');
    // Edit published listing details (price) and return cleanly to Published view
    mockUpdateListing.mockImplementationOnce((_id, payload) => {
      serverListing = { ...publishedListing, price: payload.price ?? publishedListing.price };
      return Promise.resolve(serverListing);
    });
    await waitFor(() =>
      expect(screen.getAllByRole('button', { name: /Edit details/i })[0]).toBeEnabled(),
    );
    fireEvent.click(screen.getAllByRole('button', { name: /Edit details/i })[0]!);
    expect(
      await screen.findByText(/Step 1 · Edit published listing details/i),
    ).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Price per unit (JMD) *'), { target: { value: '980' } });
    fireEvent.click(screen.getByRole('button', { name: /Save listing updates/i }));
    await waitFor(() =>
      expect(mockUpdateListing).toHaveBeenCalledWith(
        'dl-1',
        expect.objectContaining({ price: 980 }),
      ),
    );
    expect(
      await screen.findByText(/Step 4 · Published to Available Today/i),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Withdraw from sale/i })).toBeEnabled(),
    );

    // Withdraw published listing from Step 4
    fireEvent.click(screen.getByRole('button', { name: /Withdraw from sale/i }));
    fireEvent.change(screen.getByLabelText(/Reason for withdrawal/i), {
      target: { value: 'Sold out at pier' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Confirm withdrawal/i }));
    await waitFor(() =>
      expect(mockWithdrawListing).toHaveBeenCalledWith('dl-1', 'Sold out at pier'),
    );
  });

  it('handles inaccessible/cross-vendor listing (403) without exposing another vendor draft', async () => {
    mockUseAuth.mockReturnValue({
      status: 'authenticated',
      user: vendorUser,
      login: jest.fn(),
      logout: jest.fn(),
    });
    const stubListing: DailyListingResponse = {
      id: 'dl-1',
      vendorId: 'vendor-1',
      productId: 'prod-1',
      catalogueItemId: 'cat-1',
      lotId: 'lot-safe-1',
      landingSiteId: null,
      listingTitle: 'Morning Catch',
      description: null,
      catchDate: safeLot.catchDate,
      availableFrom: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 8 * 3600_000).toISOString(),
      unit: ProductUnit.PER_POUND,
      price: 900,
      currency: 'JMD',
      quantityUploaded: 10,
      quantityAvailable: 10,
      quantityReserved: 0,
      quantitySold: 0,
      deliveryAvailable: true,
      pickupAvailable: true,
      status: ListingLifecycleStatus.DRAFT,
      derivedStatus: 'DRAFT',
      publishedAt: null,
      withdrawnAt: null,
      withdrawnReason: null,
      suspendedAt: null,
      suspensionReason: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      primaryPhoto: null,
      photos: [],
      speciesDeclarations: [],
    };
    mockFetchMyListings.mockResolvedValueOnce({
      items: [stubListing],
      total: 1,
      page: 1,
      limit: 100,
      totalPages: 1,
    });
    mockFetchMyListing.mockRejectedValueOnce(new ApiError('Forbidden', 403));

    renderWithQuery();
    fireEvent.click(await screen.findByRole('button', { name: /Continue draft/i }));

    expect(
      await screen.findByText(/does not exist or does not belong to your vendor account/i),
    ).toBeInTheDocument();
  });

  it('labels bundled /demo-products/red-snapper.png as Sample Photo (Demo) in preview, attached card, and review', async () => {
    mockUseAuth.mockReturnValue({
      status: 'authenticated',
      user: vendorUser,
      login: jest.fn(),
      logout: jest.fn(),
    });
    const demoPhotoUrl =
      'https://ca-irie-web.agreeablerock-458effa7.eastus2.azurecontainerapps.io/demo-products/red-snapper.png';
    const demoPhoto: DailyListingPhotoResponse = {
      id: 'photo-demo-1',
      vendorDailyListingId: 'dl-demo-1',
      url: demoPhotoUrl,
      caption: 'Sample Red Snapper photo',
      isPrimary: true,
      moderationStatus: ListingPhotoModerationStatus.APPROVED,
      uploadedAt: new Date().toISOString(),
      captureDate: null,
      withdrawnAt: null,
      withdrawnReason: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const draftWithDemoPhoto: DailyListingResponse = {
      id: 'dl-demo-1',
      vendorId: 'vendor-1',
      productId: 'prod-1',
      catalogueItemId: 'cat-1',
      lotId: 'lot-safe-1',
      landingSiteId: null,
      listingTitle: 'Demo Snapper Draft',
      description: null,
      catchDate: safeLot.catchDate,
      availableFrom: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 8 * 3600_000).toISOString(),
      unit: ProductUnit.PER_POUND,
      price: 1200,
      currency: 'JMD',
      quantityUploaded: 15,
      quantityAvailable: 15,
      quantityReserved: 0,
      quantitySold: 0,
      deliveryAvailable: true,
      pickupAvailable: true,
      status: ListingLifecycleStatus.DRAFT,
      derivedStatus: 'DRAFT',
      publishedAt: null,
      withdrawnAt: null,
      withdrawnReason: null,
      suspendedAt: null,
      suspensionReason: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      primaryPhoto: demoPhoto,
      photos: [demoPhoto],
      speciesDeclarations: [],
    };
    mockFetchMyListings.mockResolvedValueOnce({
      items: [draftWithDemoPhoto],
      total: 1,
      page: 1,
      limit: 100,
      totalPages: 1,
    });
    mockFetchMyListing.mockResolvedValue(draftWithDemoPhoto);

    renderWithQuery();
    fireEvent.click(await screen.findByRole('button', { name: /Photos \(1\)/i }));

    expect(screen.getByTestId('demo-sample-photo-attached-badge')).toHaveTextContent(
      /Sample Photo \(Demo\)/i,
    );

    fireEvent.change(screen.getByLabelText('Actual catch photograph URL *'), {
      target: { value: demoPhotoUrl },
    });
    expect(screen.getByTestId('demo-sample-photo-preview-badge')).toHaveTextContent(
      /Sample Photo \(Demo\)/i,
    );

    fireEvent.click(screen.getByRole('button', { name: /Continue to Review/i }));
    expect(await screen.findByTestId('review-sample-photo-badge')).toHaveTextContent(
      /Sample Photo \(Demo\)/i,
    );
  });
});
