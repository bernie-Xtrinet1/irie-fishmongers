import {
  UserRole,
  UserStatus,
  type AuthUser,
} from '@iriefishmongers/types';
import { render, screen } from '@testing-library/react';

import { AccountView } from './account-view';
import { useAuth } from '@/lib/auth/auth-context';

jest.mock('@/lib/auth/auth-context');

const mockUseAuth = useAuth as jest.MockedFunction<typeof useAuth>;

const customer: AuthUser = {
  id: 'customer-1',
  email: 'customer@example.com',
  firstName: 'Customer',
  lastName: 'One',
  phone: '8765551234',
  status: UserStatus.ACTIVE,
  roles: [UserRole.CUSTOMER],
  createdAt: '2026-08-31T00:00:00.000Z',
};

const vendor: AuthUser = {
  ...customer,
  id: 'vendor-1',
  email: 'vendor@example.com',
  firstName: 'Vendor',
  roles: [UserRole.VENDOR],
};

const driver: AuthUser = {
  ...customer,
  id: 'driver-1',
  email: 'driver@example.com',
  firstName: 'Driver',
  roles: [UserRole.DRIVER],
};

describe('AccountView', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('shows the session-loading state while authentication is restored', () => {
    mockUseAuth.mockReturnValue({
      status: 'loading',
      user: null,
      login: jest.fn(),
      logout: jest.fn(),
    });

    render(<AccountView />);

    expect(screen.getByText('Loading your account…')).toBeInTheDocument();
  });

  it('prompts an unauthenticated visitor to sign in with the account return URL', () => {
    mockUseAuth.mockReturnValue({
      status: 'unauthenticated',
      user: null,
      login: jest.fn(),
      logout: jest.fn(),
    });

    render(<AccountView />);

    expect(
      screen.getByRole('heading', { name: 'Your account' }),
    ).toBeInTheDocument();

    expect(screen.getByText('Sign in to view your account.')).toBeInTheDocument();

    expect(screen.getByRole('link', { name: 'Sign in' })).toHaveAttribute(
      'href',
      '/login?returnUrl=%2Faccount',
    );
  });

  it('does not expose the account view to non-customer/non-vendor roles', () => {
    mockUseAuth.mockReturnValue({
      status: 'authenticated',
      user: driver,
      login: jest.fn(),
      logout: jest.fn(),
    });

    render(<AccountView />);

    expect(
      screen.getByText('This account page is available to customer and vendor accounts.'),
    ).toBeInTheDocument();

    expect(screen.queryByText('Account details')).not.toBeInTheDocument();
  });

  it('renders a Catch of the Day link to /vendor/daily-listings for signed-in vendors', () => {
    mockUseAuth.mockReturnValue({
      status: 'authenticated',
      user: vendor,
      login: jest.fn(),
      logout: jest.fn(),
    });

    render(<AccountView />);

    expect(screen.getByText('Vendor')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Catch of the Day' })).toHaveAttribute(
      'href',
      '/vendor/daily-listings',
    );
  });

  it('hides the vendor Catch of the Day link from customer-only accounts', () => {
    mockUseAuth.mockReturnValue({
      status: 'authenticated',
      user: customer,
      login: jest.fn(),
      logout: jest.fn(),
    });

    render(<AccountView />);

    expect(screen.queryByRole('link', { name: 'Catch of the Day' })).not.toBeInTheDocument();
  });

  it('renders the authenticated customer account information', () => {
    mockUseAuth.mockReturnValue({
      status: 'authenticated',
      user: customer,
      login: jest.fn(),
      logout: jest.fn(),
    });

    render(<AccountView />);

    expect(
      screen.getByRole('heading', { name: 'Your account' }),
    ).toBeInTheDocument();

    expect(
      screen.getByRole('heading', { name: 'Account details' }),
    ).toBeInTheDocument();

    expect(screen.getByText('Customer One')).toBeInTheDocument();
    expect(screen.getByText('customer@example.com')).toBeInTheDocument();
    expect(screen.getByText('8765551234')).toBeInTheDocument();
    expect(screen.getByText('Customer')).toBeInTheDocument();
    expect(screen.getByText('Active')).toBeInTheDocument();
    expect(screen.getByText('31 August 2026')).toBeInTheDocument();

    expect(
      screen.getByText('Account information is currently read-only.'),
    ).toBeInTheDocument();
  });

  it('shows a clear fallback when the customer has no phone number', () => {
    mockUseAuth.mockReturnValue({
      status: 'authenticated',
      user: {
        ...customer,
        phone: null,
      },
      login: jest.fn(),
      logout: jest.fn(),
    });

    render(<AccountView />);

    expect(screen.getByText('Not provided')).toBeInTheDocument();
  });

  it('humanizes compound account statuses', () => {
    mockUseAuth.mockReturnValue({
      status: 'authenticated',
      user: {
        ...customer,
        status: UserStatus.PENDING_VERIFICATION,
      },
      login: jest.fn(),
      logout: jest.fn(),
    });

    render(<AccountView />);

    expect(screen.getByText('Pending Verification')).toBeInTheDocument();
  });
});
