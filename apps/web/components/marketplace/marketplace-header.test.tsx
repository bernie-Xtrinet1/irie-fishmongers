import { fireEvent, render, screen } from '@testing-library/react';

import { UserRole, UserStatus } from '@iriefishmongers/types';

import { MarketplaceHeader } from './marketplace-header';
import { useAuth } from '@/lib/auth/auth-context';

jest.mock('@/lib/auth/auth-context', () => ({
  useAuth: jest.fn(),
}));

const mockedUseAuth = jest.mocked(useAuth);
const logout = jest.fn().mockResolvedValue(undefined);

const customerUser = {
  id: 'customer-1',
  email: 'customer@example.com',
  firstName: 'Irie',
  lastName: 'Customer',
  phone: null,
  status: UserStatus.ACTIVE,
  roles: [UserRole.CUSTOMER],
  createdAt: '2026-08-31T00:00:00.000Z',
};

const vendorUser = {
  ...customerUser,
  id: 'vendor-1',
  email: 'vendor@example.com',
  firstName: 'Irie',
  lastName: 'Vendor',
  roles: [UserRole.VENDOR],
};

describe('MarketplaceHeader', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('shows marketplace, cart, sign in, and register when logged out', () => {
    mockedUseAuth.mockReturnValue({
      status: 'unauthenticated',
      user: null,
      login: jest.fn(),
      logout,
    });

    render(<MarketplaceHeader />);

    expect(screen.getByRole('link', { name: 'Irie Fishmongers' })).toHaveAttribute('href', '/');
    expect(screen.getByRole('link', { name: 'Marketplace' })).toHaveAttribute('href', '/');
    expect(screen.getByRole('link', { name: 'Cart' })).toHaveAttribute('href', '/cart');
    expect(screen.queryByRole('link', { name: 'Orders' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Sign In' })).toHaveAttribute('href', '/login');
    expect(screen.getByRole('link', { name: 'Register' })).toHaveAttribute('href', '/register');
  });

  it('does not flash auth actions or cart while session status is loading', () => {
    mockedUseAuth.mockReturnValue({
      status: 'loading',
      user: null,
      login: jest.fn(),
      logout,
    });

    render(<MarketplaceHeader />);

    expect(screen.getByText('Loading account…')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Cart' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Orders' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Sign In' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Register' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Sign Out' })).not.toBeInTheDocument();
  });

  it('shows customer identity, cart, and sign out when authenticated as a customer', () => {
    mockedUseAuth.mockReturnValue({
      status: 'authenticated',
      user: customerUser,
      login: jest.fn(),
      logout,
    });

    render(<MarketplaceHeader />);

    expect(screen.getByText('Irie Customer')).toBeInTheDocument();
    expect(screen.getByText('customer@example.com')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Cart' })).toHaveAttribute('href', '/cart');
    expect(screen.getByRole('link', { name: 'Orders' })).toHaveAttribute('href', '/orders');
    expect(screen.getByRole('button', { name: 'Sign Out' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Sign In' })).not.toBeInTheDocument();
  });

  it('does not show cart to an authenticated non-customer role', () => {
    mockedUseAuth.mockReturnValue({
      status: 'authenticated',
      user: vendorUser,
      login: jest.fn(),
      logout,
    });

    render(<MarketplaceHeader />);

    expect(screen.getByText('Irie Vendor')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Cart' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Orders' })).not.toBeInTheDocument();
  });

  it('calls logout when Sign Out is selected', () => {
    mockedUseAuth.mockReturnValue({
      status: 'authenticated',
      user: customerUser,
      login: jest.fn(),
      logout,
    });

    render(<MarketplaceHeader />);

    fireEvent.click(screen.getByRole('button', { name: 'Sign Out' }));

    expect(logout).toHaveBeenCalledTimes(1);
  });
});
