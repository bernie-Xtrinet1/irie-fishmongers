import {
  Parish,
  ProductAvailability,
  ProductUnit,
  UserRole,
  UserStatus,
  VendorStatus,
  VendorTier,
  type CataloguePhotoOption,
  type CategoryOption,
  type ManagedSpecies,
  type ProductResponse,
  type VendorAdmin,
} from '@iriefishmongers/types';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import {
  adjustProductStock,
  createProduct,
  fetchCategories,
  fetchMyProducts,
  setProductActive,
  updateProduct,
} from '@/lib/api/products';
import {
  fetchCataloguePhotos,
  fetchManagedSpecies,
  fetchMySeafoodLots,
  fetchMyVendorCompliance,
  fetchMyVendorProfile,
} from '@/lib/api/vendors';
import { useAuth } from '@/lib/auth/auth-context';

import { VendorProductsView } from './vendor-products-view';

jest.mock('@/lib/auth/auth-context');
jest.mock('@/lib/api/products', () => ({
  fetchCategories: jest.fn(),
  fetchMyProducts: jest.fn(),
  createProduct: jest.fn(),
  updateProduct: jest.fn(),
  adjustProductStock: jest.fn(),
  setProductActive: jest.fn(),
}));
jest.mock('@/lib/api/vendors', () => ({
  fetchMyVendorProfile: jest.fn(),
  fetchMyVendorCompliance: jest.fn(),
  fetchManagedSpecies: jest.fn(),
  fetchMySeafoodLots: jest.fn(),
  fetchCataloguePhotos: jest.fn(),
}));

const mockUseAuth = useAuth as jest.MockedFunction<typeof useAuth>;
const mockFetchVendor = fetchMyVendorProfile as jest.MockedFunction<typeof fetchMyVendorProfile>;
const mockFetchCompliance = fetchMyVendorCompliance as jest.MockedFunction<
  typeof fetchMyVendorCompliance
>;
const mockFetchCategories = fetchCategories as jest.MockedFunction<typeof fetchCategories>;
const mockFetchSpecies = fetchManagedSpecies as jest.MockedFunction<typeof fetchManagedSpecies>;
const mockFetchLots = fetchMySeafoodLots as jest.MockedFunction<typeof fetchMySeafoodLots>;
const mockFetchMyProducts = fetchMyProducts as jest.MockedFunction<typeof fetchMyProducts>;
const mockFetchCataloguePhotos = fetchCataloguePhotos as jest.MockedFunction<
  typeof fetchCataloguePhotos
>;
const mockCreateProduct = createProduct as jest.MockedFunction<typeof createProduct>;
const mockUpdateProduct = updateProduct as jest.MockedFunction<typeof updateProduct>;
const mockAdjustStock = adjustProductStock as jest.MockedFunction<typeof adjustProductStock>;
const mockSetProductActive = setProductActive as jest.MockedFunction<typeof setProductActive>;

const vendorUser = {
  id: 'user-vendor-1',
  email: 'vendor@example.com',
  firstName: 'Port',
  lastName: 'Vendor',
  phone: '8765550101',
  status: UserStatus.ACTIVE,
  roles: [UserRole.VENDOR],
  createdAt: '2026-10-01T00:00:00.000Z',
};

const approvedVendor: VendorAdmin = {
  id: 'vendor-1',
  userId: 'user-vendor-1',
  businessName: 'Port Royal Catch',
  description: null,
  phone: '8765550101',
  parish: Parish.KINGSTON,
  logoUrl: null,
  status: VendorStatus.APPROVED,
  tier: VendorTier.VERIFIED_VENDOR,
  complianceScore: 95,
  termsAcceptedAt: '2026-10-01T00:00:00.000Z',
  primaryZoneId: null,
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
};

const categories: CategoryOption[] = [
  { id: 'cat-fish', name: 'Fresh Fish', slug: 'fresh-fish' },
  { id: 'cat-shellfish', name: 'Shellfish', slug: 'shellfish' },
];

const tilapiaSpecies: ManagedSpecies = {
  id: 'sp-tilapia',
  commercialName: 'Tilapia',
  scientificName: 'Oreochromis niloticus',
  regulatoryStatus: 'UNRESTRICTED',
};

const conchSpecies: ManagedSpecies = {
  id: 'sp-conch',
  commercialName: 'Conch',
  scientificName: 'Lobatus gigas',
  regulatoryStatus: 'RESTRICTED',
};

const tilapiaPhoto: CataloguePhotoOption = {
  id: 'cp-tilapia-1',
  speciesId: 'sp-tilapia',
  catalogueItemId: 'item-tilapia-1',
  title: 'Tilapia (Oreochromis niloticus)',
  scientificName: 'Oreochromis niloticus',
  jamaicanAliases: ['Tilapia', 'Red Tilapia', 'Red Belly'],
  imageUrl: '/catalogue-photos/oreochromis-niloticus.png',
  sourceName: 'Wikimedia Commons · File:Oreochromis-niloticus-Nairobi.JPG',
  sourceUrl: 'https://commons.wikimedia.org/wiki/File:Oreochromis-niloticus-Nairobi.JPG',
  photographer: 'Bjørn Christian Tørrissen',
  licenseName: 'CC BY-SA 3.0',
  licenseUrl: 'https://creativecommons.org/licenses/by-sa/3.0/',
  modifications: 'Cropped/resized to 900x600 landscape PNG with neutral border padding',
  requiresAttribution: true,
  approvalStatus: 'APPROVED',
  species: tilapiaSpecies,
};

function renderWithQuery() {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={client}>
      <VendorProductsView />
    </QueryClientProvider>,
  );
}

describe('VendorProductsView', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFetchVendor.mockResolvedValue(approvedVendor);
    mockFetchCompliance.mockResolvedValue({
      tier: VendorTier.VERIFIED_VENDOR,
      canSell: true,
      requiredDocuments: [],
    });
    mockFetchCategories.mockResolvedValue(categories);
    mockFetchSpecies.mockResolvedValue([tilapiaSpecies, conchSpecies]);
    mockFetchLots.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 100 });
    mockAdjustStock.mockResolvedValue({} as ProductResponse);
    mockSetProductActive.mockResolvedValue({} as ProductResponse);
  });

  it('prompts unauthenticated visitors to sign in', () => {
    mockUseAuth.mockReturnValue({
      status: 'unauthenticated',
      user: null,
      login: jest.fn(),
      logout: jest.fn(),
    });

    renderWithQuery();
    expect(screen.getByText('Sign in required')).toBeInTheDocument();
  });

  it('lets a vendor search, preview, select a Tilapia catalogue photo, save, and see it selected upon reopening', async () => {
    mockUseAuth.mockReturnValue({
      status: 'authenticated',
      user: vendorUser,
      login: jest.fn(),
      logout: jest.fn(),
    });

    const savedTilapiaProduct: ProductResponse = {
      id: 'prod-tilapia-1',
      vendorId: 'vendor-1',
      categoryId: 'cat-fish',
      lotId: null,
      speciesId: 'sp-tilapia',
      speciesName: 'Tilapia (Oreochromis niloticus)',
      cataloguePhotoId: 'cp-tilapia-1',
      isCatalogueReferencePhoto: true,
      cataloguePhoto: tilapiaPhoto,
      name: 'Fresh Red Tilapia (Whole)',
      description: 'Farm-harvested tilapia cleaned and kept chilled at Kingston depot.',
      unit: ProductUnit.PER_POUND,
      price: '950',
      currency: 'JMD',
      quantityAvailable: 12,
      imageUrl: '/catalogue-photos/oreochromis-niloticus.png',
      isActive: true,
      availability: ProductAvailability.ACTIVE,
      createdAt: '2026-11-24T12:00:00.000Z',
    };

    mockFetchMyProducts
      .mockResolvedValueOnce({ items: [], total: 0, page: 1, pageSize: 100 })
      .mockResolvedValue({ items: [savedTilapiaProduct], total: 1, page: 1, pageSize: 100 });

    mockFetchCataloguePhotos.mockImplementation((query) => {
      if (query?.speciesId === 'sp-conch') {
        return Promise.resolve([]);
      }
      if (query?.speciesId === 'sp-tilapia') {
        if (
          query.search &&
          !'Red Belly Tilapia Oreochromis niloticus'.toLowerCase().includes(query.search.toLowerCase())
        ) {
          return Promise.resolve([]);
        }
        return Promise.resolve([tilapiaPhoto]);
      }
      return Promise.resolve([tilapiaPhoto]);
    });
    mockCreateProduct.mockResolvedValue(savedTilapiaProduct);
    mockUpdateProduct.mockResolvedValue({
      ...savedTilapiaProduct,
      price: '980',
    });

    renderWithQuery();

    const speciesSelect = await screen.findByTestId('product-species-select');
    await waitFor(() => expect(screen.getByText(/Tilapia \(Oreochromis niloticus\)/)).toBeInTheDocument());

    fireEvent.change(speciesSelect, { target: { value: 'sp-tilapia' } });
    fireEvent.click(screen.getByTestId('photo-mode-catalogue-tab'));

    const pickerCard = await screen.findByTestId('catalogue-photo-card-cp-tilapia-1');
    expect(pickerCard).toHaveTextContent('Red Belly');

    fireEvent.change(screen.getByTestId('catalogue-photo-search-input'), {
      target: { value: 'Red Belly' },
    });
    await waitFor(() =>
      expect(mockFetchCataloguePhotos).toHaveBeenCalledWith({
        speciesId: 'sp-tilapia',
        search: 'Red Belly',
      }),
    );

    const previewBtn = await screen.findByTestId('preview-catalogue-photo-cp-tilapia-1');
    fireEvent.click(previewBtn);
    const previewPanel = await screen.findByTestId('catalogue-photo-preview-panel');
    expect(previewPanel).toHaveTextContent('Bjørn Christian Tørrissen');
    expect(previewPanel).toHaveTextContent('CC BY-SA 3.0');
    expect(previewPanel).toHaveTextContent('Cropped/resized to 900x600 landscape PNG');

    fireEvent.click(screen.getByTestId('preview-select-catalogue-photo-btn'));
    expect(screen.getByTestId('selected-catalogue-photo-summary')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Product name *'), {
      target: { value: 'Fresh Red Tilapia (Whole)' },
    });
    fireEvent.change(screen.getByLabelText('Description *'), {
      target: { value: 'Farm-harvested tilapia cleaned and kept chilled at Kingston depot.' },
    });
    fireEvent.change(screen.getByLabelText('Price (JMD) *'), {
      target: { value: '950' },
    });
    fireEvent.change(screen.getByLabelText('Quantity available *'), {
      target: { value: '12' },
    });

    fireEvent.click(screen.getByTestId('save-product-submit-btn'));

    await waitFor(() => {
      expect(mockCreateProduct).toHaveBeenCalledWith(
        expect.objectContaining({
          speciesId: 'sp-tilapia',
          cataloguePhotoId: 'cp-tilapia-1',
          imageUrl: '/catalogue-photos/oreochromis-niloticus.png',
          name: 'Fresh Red Tilapia (Whole)',
          price: 950,
          quantityAvailable: 12,
        }),
      );
    });

    // Reopen saved product in edit mode and verify library photo stays selected
    const editBtn = await screen.findByTestId('edit-product-prod-tilapia-1');
    expect(screen.getByTestId('vendor-products-list')).toHaveTextContent('Catalogue reference photo');

    fireEvent.click(editBtn);

    expect(screen.getByTestId('photo-mode-catalogue-tab')).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('product-species-select')).toHaveValue('sp-tilapia');
    expect(await screen.findByTestId('selected-catalogue-photo-summary')).toHaveTextContent(
      'Tilapia (Oreochromis niloticus)',
    );

    // Edit price only and confirm cataloguePhotoId stays preserved
    fireEvent.change(screen.getByLabelText('Price (JMD) *'), {
      target: { value: '980' },
    });
    fireEvent.click(screen.getByTestId('save-product-submit-btn'));

    await waitFor(() => {
      expect(mockUpdateProduct).toHaveBeenCalledWith(
        'prod-tilapia-1',
        expect.objectContaining({
          speciesId: 'sp-tilapia',
          cataloguePhotoId: 'cp-tilapia-1',
          price: 980,
        }),
      );
    });
  });

  it('shows a regulatory warning and an empty catalogue photo state when a restricted species is selected', async () => {
    mockUseAuth.mockReturnValue({
      status: 'authenticated',
      user: vendorUser,
      login: jest.fn(),
      logout: jest.fn(),
    });
    mockFetchMyProducts.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 100 });
    mockFetchCataloguePhotos.mockResolvedValue([]);

    renderWithQuery();

    const speciesSelect = await screen.findByTestId('product-species-select');
    await waitFor(() => expect(screen.getByText(/Conch \(Lobatus gigas\)/)).toBeInTheDocument());

    fireEvent.change(speciesSelect, { target: { value: 'sp-conch' } });
    fireEvent.click(screen.getByTestId('photo-mode-catalogue-tab'));

    expect(screen.getByTestId('species-restriction-warning')).toHaveTextContent(/RESTRICTED/i);
    expect(await screen.findByTestId('catalogue-photo-empty-state')).toHaveTextContent(
      /Conch \(Lobatus gigas\) is currently restricted and has no approved catalogue photos available/i,
    );
    expect(screen.getByTestId('save-product-submit-btn')).toBeDisabled();
  });
});
