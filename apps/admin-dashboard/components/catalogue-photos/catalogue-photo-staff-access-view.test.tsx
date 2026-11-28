import {
  type CataloguePhotoStaffAccessResponse,
  type UpdateCataloguePhotoStaffAccessResponse,
  UserRole,
  UserStatus,
} from '@iriefishmongers/types';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import * as api from '@/lib/api/catalogue-photos';
import { useAuth } from '@/lib/auth/auth-context';
import { CataloguePhotoStaffAccessView } from './catalogue-photo-staff-access-view';

jest.mock('@/lib/auth/auth-context');
jest.mock('@/lib/api/catalogue-photos');

const mockUseAuth = useAuth as jest.MockedFunction<typeof useAuth>;
const mockFetchStaffAccess = api.fetchCataloguePhotoStaffAccess as jest.MockedFunction<
  typeof api.fetchCataloguePhotoStaffAccess
>;
const mockUpdateStaffAccess = api.updateCataloguePhotoStaffAccess as jest.MockedFunction<
  typeof api.updateCataloguePhotoStaffAccess
>;

function renderStaffAccessView() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <CataloguePhotoStaffAccessView />
    </QueryClientProvider>,
  );
}

const initialResponse: CataloguePhotoStaffAccessResponse = {
  staff: [
    {
      id: 'staff-ops-1',
      email: 'staff.operations@iriefishmongers.test',
      firstName: 'Ops',
      lastName: 'Staff',
      status: UserStatus.ACTIVE,
      roles: [UserRole.OPERATIONS_STAFF],
      canManageCataloguePhotos: false,
      updatedAt: '2026-11-28T00:00:00.000Z',
    },
  ],
  auditLogs: [],
};

describe('CataloguePhotoStaffAccessView', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUseAuth.mockReturnValue({
      status: 'authenticated',
      user: {
        id: 'primary-admin-1',
        email: 'bernard.uat@iriefishmongers.test',
        firstName: 'Bernard',
        lastName: 'UAT',
        status: 'ACTIVE',
        roles: ['ADMINISTRATOR'],
        canAuthorizeVendorSettlements: true,
        canManageCataloguePhotos: true,
      },
      login: jest.fn(),
      logout: jest.fn(),
    });
    mockFetchStaffAccess.mockResolvedValue(initialResponse);
  });

  it('shows eligible staff, opens confirmation explanation before saving, and updates via API', async () => {
    const grantResponse: UpdateCataloguePhotoStaffAccessResponse = {
      changed: true,
      staff: {
        ...initialResponse.staff[0]!,
        canManageCataloguePhotos: true,
        updatedAt: '2026-11-28T12:00:00.000Z',
      },
      auditLog: {
        id: 'audit-1',
        targetUserId: 'staff-ops-1',
        targetEmail: 'staff.operations@iriefishmongers.test',
        actorUserId: 'primary-admin-1',
        actorEmail: 'bernard.uat@iriefishmongers.test',
        permissionName: 'canManageCataloguePhotos',
        action: 'GRANT_CATALOGUE_PHOTO_ACCESS',
        previousValue: false,
        newValue: true,
        createdAt: '2026-11-28T12:00:00.000Z',
      },
    };
    mockUpdateStaffAccess.mockResolvedValue(grantResponse);
    mockFetchStaffAccess
      .mockResolvedValueOnce(initialResponse)
      .mockResolvedValueOnce({
        staff: [grantResponse.staff],
        auditLogs: [grantResponse.auditLog!],
      });

    renderStaffAccessView();

    await waitFor(() => {
      expect(screen.getByText('staff.operations@iriefishmongers.test')).toBeInTheDocument();
    });
    expect(screen.getByTestId('staff-access-badge-staff-ops-1')).toHaveTextContent('No Access');

    await userEvent.click(screen.getByTestId('toggle-staff-access-btn-staff-ops-1'));

    const dialog = await screen.findByTestId('confirm-staff-access-dialog');
    expect(dialog).toHaveTextContent('Ops Staff (staff.operations@iriefishmongers.test)');
    expect(dialog).toHaveTextContent(
      'viewing private drafts, uploading photos, editing metadata, and uploading replacement drafts',
    );
    expect(mockUpdateStaffAccess).not.toHaveBeenCalled();

    await userEvent.click(screen.getByTestId('confirm-staff-access-btn'));

    await waitFor(() => {
      expect(mockUpdateStaffAccess).toHaveBeenCalledTimes(1);
    });
    expect(mockUpdateStaffAccess.mock.calls[0]?.[0]).toEqual({
      targetUserId: 'staff-ops-1',
      canManageCataloguePhotos: true,
    });

    await waitFor(() => {
      expect(screen.getByTestId('staff-access-badge-staff-ops-1')).toHaveTextContent(
        'Access Granted',
      );
    });
    expect(screen.getByTestId('staff-access-audit-row-audit-1')).toHaveTextContent(
      'bernard.uat@iriefishmongers.test',
    );
  });

  it('prompts revoke confirmation with immediate session-block warning', async () => {
    mockFetchStaffAccess.mockResolvedValue({
      staff: [{ ...initialResponse.staff[0]!, canManageCataloguePhotos: true }],
      auditLogs: [],
    });

    renderStaffAccessView();

    await waitFor(() => {
      expect(screen.getByTestId('staff-access-badge-staff-ops-1')).toHaveTextContent(
        'Access Granted',
      );
    });

    await userEvent.click(screen.getByTestId('toggle-staff-access-btn-staff-ops-1'));

    const dialog = await screen.findByTestId('confirm-staff-access-dialog');
    expect(dialog).toHaveTextContent('Revoke Catalogue Photos Access');
    expect(dialog).toHaveTextContent(
      'Revoking access blocks any active session for this account on its next protected Catalogue Photos request',
    );
  });
});
