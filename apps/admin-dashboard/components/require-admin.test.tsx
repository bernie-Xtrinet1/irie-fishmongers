import { render, screen, waitFor } from '@testing-library/react';
import React from 'react';

import type { useAuth } from '@/lib/auth/auth-context';

const mockReplace = jest.fn();
const mockLogout = jest.fn().mockResolvedValue(undefined);
const mockUseAuth = jest.fn<ReturnType<typeof useAuth>, []>();

jest.mock('next/navigation', () => ({
  useRouter: () => ({ replace: mockReplace }),
}));

jest.mock('@/lib/auth/auth-context', () => ({
  useAuth: (): ReturnType<typeof useAuth> => mockUseAuth(),
}));

import { RequireAdmin } from './require-admin';

describe('RequireAdmin', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('redirects unauthenticated users to /login without rendering protected children', () => {
    mockUseAuth.mockReturnValue({
      status: 'unauthenticated',
      user: null,
      logout: mockLogout,
      login: jest.fn(),
    });

    render(
      <RequireAdmin>
        <div>Secret Admin Dashboard</div>
      </RequireAdmin>,
    );

    expect(screen.queryByText('Secret Admin Dashboard')).not.toBeInTheDocument();
    expect(screen.getByText('Loading…')).toBeInTheDocument();
    expect(mockReplace).toHaveBeenCalledWith('/login');
    expect(mockLogout).not.toHaveBeenCalled();
  });

  it.each(['CUSTOMER', 'VENDOR', 'DRIVER'] as const)(
    'denies authenticated %s users, revokes session, and never renders children',
    async (role) => {
      mockUseAuth.mockReturnValue({
        status: 'authenticated',
        user: {
          id: `${role.toLowerCase()}-1`,
          email: `${role.toLowerCase()}@example.com`,
          firstName: 'Test',
          lastName: 'User',
          status: 'ACTIVE',
          roles: [role],
        },
        logout: mockLogout,
        login: jest.fn(),
      });

      render(
        <RequireAdmin>
          <div>Secret Admin Dashboard</div>
        </RequireAdmin>,
      );

      expect(screen.queryByText('Secret Admin Dashboard')).not.toBeInTheDocument();
      expect(screen.getByText('Loading…')).toBeInTheDocument();
      await waitFor(() => expect(mockLogout).toHaveBeenCalledTimes(1));
    },
  );

  it.each(['SUSPENDED', 'DEACTIVATED', 'PENDING_VERIFICATION'] as const)(
    'denies %s administrator accounts and revokes session without rendering children',
    async (status) => {
      mockUseAuth.mockReturnValue({
        status: 'authenticated',
        user: {
          id: 'admin-inactive',
          email: 'admin@example.com',
          firstName: 'Inactive',
          lastName: 'Admin',
          status,
          roles: ['ADMINISTRATOR'],
        },
        logout: mockLogout,
        login: jest.fn(),
      });

      render(
        <RequireAdmin>
          <div>Secret Admin Dashboard</div>
        </RequireAdmin>,
      );

      expect(screen.queryByText('Secret Admin Dashboard')).not.toBeInTheDocument();
      await waitFor(() => expect(mockLogout).toHaveBeenCalledTimes(1));
    },
  );

  it('renders protected children for an ACTIVE OPERATIONS_STAFF user', () => {
    mockUseAuth.mockReturnValue({
      status: 'authenticated',
      user: {
        id: 'staff-1',
        email: 'staff.operations@iriefishmongers.test',
        firstName: 'Ops',
        lastName: 'Staff',
        status: 'ACTIVE',
        roles: ['OPERATIONS_STAFF'],
      },
      logout: mockLogout,
      login: jest.fn(),
    });

    render(
      <RequireAdmin>
        <div>Secret Admin Dashboard</div>
      </RequireAdmin>,
    );

    expect(screen.getByText('Secret Admin Dashboard')).toBeInTheDocument();
    expect(mockLogout).not.toHaveBeenCalled();
  });

  it('renders protected children for an ACTIVE ADMINISTRATOR', () => {
    mockUseAuth.mockReturnValue({
      status: 'authenticated',
      user: {
        id: 'admin-1',
        email: 'admin@example.com',
        firstName: 'Active',
        lastName: 'Admin',
        status: 'ACTIVE',
        roles: ['ADMINISTRATOR'],
      },
      logout: mockLogout,
      login: jest.fn(),
    });

    render(
      <RequireAdmin>
        <div>Secret Admin Dashboard</div>
      </RequireAdmin>,
    );

    expect(screen.getByText('Secret Admin Dashboard')).toBeInTheDocument();
    expect(mockLogout).not.toHaveBeenCalled();
    expect(mockReplace).not.toHaveBeenCalled();
  });
});
