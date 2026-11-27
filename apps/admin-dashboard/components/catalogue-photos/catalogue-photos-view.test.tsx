import type { AdminCataloguePhotoItem, ManagedSpecies } from '@iriefishmongers/types';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import * as api from '@/lib/api/catalogue-photos';
import { useAuth } from '@/lib/auth/auth-context';
import { CataloguePhotosView } from './catalogue-photos-view';

jest.mock('@/lib/auth/auth-context');
jest.mock('@/lib/api/catalogue-photos');

const mockUseAuth = useAuth as jest.MockedFunction<typeof useAuth>;
const mockFetchList = api.fetchAdminCataloguePhotos as jest.MockedFunction<
  typeof api.fetchAdminCataloguePhotos
>;
const mockFetchBlob = api.fetchProtectedCataloguePhotoBlob as jest.MockedFunction<
  typeof api.fetchProtectedCataloguePhotoBlob
>;
const mockFetchHistory = api.fetchAdminCataloguePhotoHistory as jest.MockedFunction<
  typeof api.fetchAdminCataloguePhotoHistory
>;

function renderView() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <CataloguePhotosView />
    </QueryClientProvider>,
  );
}

const sampleSpecies: ManagedSpecies[] = [
  {
    id: 'sp-tilapia',
    commercialName: 'Tilapia',
    scientificName: 'Oreochromis niloticus',
    regulatoryStatus: 'UNRESTRICTED',
  },
];

const samplePhotos: AdminCataloguePhotoItem[] = [
  {
    id: 'photo-tilapia-1',
    speciesId: 'sp-tilapia',
    catalogueItemId: 'cat-1',
    versionGroupId: 'grp-1',
    versionNumber: 1,
    replacesPhotoId: null,
    isDefault: true,
    title: 'Nile Tilapia / Red Belly',
    scientificName: 'Oreochromis niloticus',
    jamaicanAliases: ['Tilapia', 'Red Belly'],
    imageUrl: 'https://stiriestaging.blob.core.windows.net/catalogue-photos/published/tilapia/grp-1/v1.png',
    lifecycleStatus: 'APPROVED' as const,
    approvalStatus: 'APPROVED' as const,
    storageProvider: 'AZURE_BLOB',
    storageContainer: 'catalogue-photos',
    storageKey: 'published/tilapia/grp-1/v1.png',
    mimeType: 'image/png',
    fileSizeBytes: 24000,
    widthPx: 900,
    heightPx: 600,
    sourceName: 'Wikimedia Commons',
    sourceUrl: 'https://commons.wikimedia.org',
    photographer: 'Bjørn Christian Tørrissen',
    licenseName: 'CC BY-SA 3.0',
    licenseUrl: 'https://creativecommons.org/licenses/by-sa/3.0/',
    modifications: 'Cropped/resized to 900x600 PNG',
    requiresAttribution: true,
    publishedAt: '2026-11-26T00:00:00.000Z',
    rejectedAt: null,
    rejectionReason: null,
    retiredAt: null,
    retirementReason: null,
    createdAt: '2026-11-26T00:00:00.000Z',
    updatedAt: '2026-11-26T00:00:00.000Z',
    usageCount: 2,
    species: sampleSpecies[0]!,
  },
  {
    id: 'photo-tilapia-draft',
    speciesId: 'sp-tilapia',
    catalogueItemId: 'cat-1',
    versionGroupId: 'grp-2',
    versionNumber: 1,
    replacesPhotoId: null,
    isDefault: false,
    title: 'Tilapia Draft Photo 2',
    scientificName: 'Oreochromis niloticus',
    jamaicanAliases: ['Red Belly', 'Pond Fish'],
    imageUrl: '/api/v1/admin/catalogue-photos/photo-tilapia-draft/image',
    lifecycleStatus: 'DRAFT' as const,
    approvalStatus: 'PENDING' as const,
    storageProvider: 'AZURE_BLOB',
    storageContainer: 'catalogue-photos-drafts',
    storageKey: 'drafts/tilapia/photo-tilapia-draft/v1.png',
    mimeType: 'image/png',
    fileSizeBytes: 21000,
    widthPx: 900,
    heightPx: 600,
    sourceName: 'Company Studio',
    sourceUrl: 'https://iriefishmongers.com',
    photographer: 'Irie Studio',
    licenseName: 'Company Owned',
    licenseUrl: 'https://iriefishmongers.com/credits',
    modifications: 'Cropped 3:2',
    requiresAttribution: true,
    publishedAt: null,
    rejectedAt: null,
    rejectionReason: null,
    retiredAt: null,
    retirementReason: null,
    createdAt: '2026-11-26T01:00:00.000Z',
    updatedAt: '2026-11-26T01:00:00.000Z',
    usageCount: 0,
    species: sampleSpecies[0]!,
  },
];

describe('CataloguePhotosView', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    global.URL.createObjectURL = jest.fn(() => 'blob:mock-preview');
    global.URL.revokeObjectURL = jest.fn();
    mockFetchBlob.mockResolvedValue(new Blob(['png'], { type: 'image/png' }));
    mockFetchList.mockResolvedValue({
      items: samplePhotos,
      species: sampleSpecies,
      storageConfigured: true,
    });
    const firstPhoto = samplePhotos[0]!;
    mockFetchHistory.mockResolvedValue({
      photo: firstPhoto,
      versions: [
        firstPhoto,
        {
          ...firstPhoto,
          id: 'photo-tilapia-0',
          versionNumber: 0,
          lifecycleStatus: 'RETIRED',
          usageCount: 1,
        },
      ],
      auditLogs: [],
    });
  });

  it('shows thumbnails, aliases, usage counts, and full administrator controls', async () => {
    mockUseAuth.mockReturnValue({
      status: 'authenticated',
      user: {
        id: 'admin-1',
        email: 'admin@test.local',
        firstName: 'Ada',
        lastName: 'Admin',
        status: 'ACTIVE',
        roles: ['ADMINISTRATOR'],
        canManageCataloguePhotos: true,
      },
      login: jest.fn(),
      logout: jest.fn(),
    });

    renderView();

    await waitFor(() => {
      expect(screen.getByText('Nile Tilapia / Red Belly')).toBeInTheDocument();
    });
    expect(screen.getByText('Tilapia Draft Photo 2')).toBeInTheDocument();
    expect(screen.getByTestId('usage-count-photo-tilapia-1')).toHaveTextContent('2');
    expect(screen.getByTestId('approve-photo-btn-photo-tilapia-draft')).toBeInTheDocument();
    expect(screen.getByTestId('retire-photo-btn-photo-tilapia-1')).toBeInTheDocument();
    expect(screen.getByTestId('replace-photo-btn-photo-tilapia-1')).toBeInTheDocument();

    // Open Replace dialog and verify product usage banner
    await userEvent.click(screen.getByTestId('replace-photo-btn-photo-tilapia-1'));
    expect(screen.getByTestId('replace-usage-banner')).toHaveTextContent(
      '2 product listing(s) currently use Nile Tilapia / Red Belly (v1)',
    );
  });

  it('hides publish, set-default, retire, and bulk-switch actions for permitted non-admin editors', async () => {
    mockUseAuth.mockReturnValue({
      status: 'authenticated',
      user: {
        id: 'staff-1',
        email: 'editor@test.local',
        firstName: 'Ed',
        lastName: 'Editor',
        status: 'ACTIVE',
        roles: ['OPERATIONS_STAFF'],
        canManageCataloguePhotos: true,
      },
      login: jest.fn(),
      logout: jest.fn(),
    });

    renderView();

    await waitFor(() => {
      expect(screen.getByText('Nile Tilapia / Red Belly')).toBeInTheDocument();
    });
    expect(screen.getByTestId('open-upload-catalogue-photo-btn')).toBeInTheDocument();
    expect(screen.getByTestId('replace-photo-btn-photo-tilapia-1')).toBeInTheDocument();
    expect(screen.queryByTestId('approve-photo-btn-photo-tilapia-draft')).not.toBeInTheDocument();
    expect(screen.queryByTestId('retire-photo-btn-photo-tilapia-1')).not.toBeInTheDocument();

    await userEvent.click(screen.getByTestId('history-photo-btn-photo-tilapia-1'));
    await waitFor(() => {
      expect(screen.getByText(/Version Lineage/i)).toBeInTheDocument();
    });
    expect(screen.queryByTestId('bulk-switch-panel')).not.toBeInTheDocument();
  });

  it('switches only selected listings and displays affected listings in audit history', async () => {
    mockUseAuth.mockReturnValue({
      status: 'authenticated',
      user: {
        id: 'admin-1',
        email: 'admin@test.local',
        firstName: 'Ada',
        lastName: 'Admin',
        status: 'ACTIVE',
        roles: ['ADMINISTRATOR'],
        canManageCataloguePhotos: true,
      },
      login: jest.fn(),
      logout: jest.fn(),
    });

    const mockBulkSwitch = api.bulkSwitchCatalogueListings as jest.MockedFunction<
      typeof api.bulkSwitchCatalogueListings
    >;
    mockBulkSwitch.mockResolvedValue({
      fromPhotoId: 'photo-tilapia-0',
      toPhotoId: 'photo-tilapia-1',
      switchedCount: 1,
      affectedProductIds: ['listing-selected'],
    });

    const firstPhoto = samplePhotos[0]!;
    mockFetchHistory.mockResolvedValue({
      photo: firstPhoto,
      versions: [
        firstPhoto,
        {
          ...firstPhoto,
          id: 'photo-tilapia-0',
          versionNumber: 0,
          lifecycleStatus: 'RETIRED',
          usageCount: 2,
        },
      ],
      versionListings: {
        'photo-tilapia-0': [
          {
            id: 'listing-selected',
            name: 'Tilapia Whole (Selected)',
            vendorId: 'v-1',
            vendorName: 'Harbour Fresh',
            isActive: true,
          },
          {
            id: 'listing-unselected',
            name: 'Tilapia Fillet (Keep)',
            vendorId: 'v-2',
            vendorName: 'Port Royal Catch',
            isActive: true,
          },
        ],
      },
      auditLogs: [
        {
          id: 'audit-switch-1',
          cataloguePhotoId: 'photo-tilapia-1',
          versionGroupId: 'grp-1',
          action: 'BULK_SWITCH_LISTINGS',
          actorUserId: 'admin-1',
          actorEmail: 'admin@test.local',
          affectedCount: 1,
          details: {
            affectedProductIds: ['listing-selected'],
            affectedListings: [{ id: 'listing-selected', name: 'Tilapia Whole (Selected)', vendorId: 'v-1' }],
          },
          createdAt: '2026-11-27T08:00:00.000Z',
        },
      ],
    });

    renderView();
    await waitFor(() => {
      expect(screen.getByText('Nile Tilapia / Red Belly')).toBeInTheDocument();
    });

    await userEvent.click(screen.getByTestId('history-photo-btn-photo-tilapia-1'));
    await waitFor(() => {
      expect(screen.getByTestId('bulk-switch-listing-selector')).toBeInTheDocument();
    });

    expect(screen.getAllByText(/Tilapia Whole \(Selected\)/).length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText(/Affected listings: Tilapia Whole \(Selected\)/)).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('bulk-switch-listing-checkbox-listing-unselected'));
    await userEvent.click(screen.getByTestId('confirm-bulk-switch-checkbox'));
    await userEvent.click(screen.getByTestId('execute-bulk-switch-btn'));

    await waitFor(() => {
      expect(mockBulkSwitch).toHaveBeenCalledWith(
        'photo-tilapia-1',
        'photo-tilapia-0',
        ['listing-selected'],
      );
    });
  });
});
