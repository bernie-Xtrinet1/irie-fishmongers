import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { useAuth } from '@/lib/auth/auth-context';
import { useHealthStatus } from '@/lib/hooks/use-health-status';
import { DashboardShell } from './dashboard-shell';

jest.mock('@/lib/auth/auth-context');
jest.mock('@/lib/hooks/use-health-status');
jest.mock('next/navigation', () => ({
  usePathname: () => '/vendors',
}));

const mockUseAuth = useAuth as jest.MockedFunction<typeof useAuth>;
const mockUseHealthStatus = useHealthStatus as jest.MockedFunction<typeof useHealthStatus>;

function mockHealth(value: unknown): void {
  mockUseHealthStatus.mockReturnValue(value as ReturnType<typeof useHealthStatus>);
}

describe('DashboardShell', () => {
  const logout = jest.fn();

  beforeEach(() => {
    logout.mockReset();
    mockUseAuth.mockReturnValue({
      status: 'authenticated',
      user: { id: '1', email: 'admin@example.com', firstName: 'Ada', lastName: 'Min', roles: ['ADMINISTRATOR'] },
      login: jest.fn(),
      logout,
    });
  });

  it('renders all in-scope nav items with the current route marked active', () => {
    mockHealth({ data: undefined, isPending: true });

    render(
      <DashboardShell>
        <div>content</div>
      </DashboardShell>,
    );

    expect(screen.getByRole('link', { name: 'Vendors' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Dashboard' })).not.toHaveAttribute('aria-current');
    expect(screen.getByRole('link', { name: 'Vendor Dashboard' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Sales Analytics' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Drivers' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Delivery Zones & Fleet' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Delivery Operations' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Cold Chain' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Recalls' })).toBeInTheDocument();
  });

  it('shows a checking state before the first health result loads', () => {
    mockHealth({ data: undefined, isPending: true });

    render(
      <DashboardShell>
        <div>content</div>
      </DashboardShell>,
    );

    expect(screen.getByText('Checking systems…')).toBeInTheDocument();
  });

  it('pairs the connectivity color with status text when systems are operational', () => {
    mockHealth({ data: { postgres: 'up', redis: 'up' }, isPending: false });

    render(
      <DashboardShell>
        <div>content</div>
      </DashboardShell>,
    );

    expect(screen.getByRole('status')).toHaveTextContent('All systems operational');
  });

  it('surfaces a degraded status when a dependency is down - never color alone', () => {
    mockHealth({ data: { postgres: 'up', redis: 'down' }, isPending: false });

    render(
      <DashboardShell>
        <div>content</div>
      </DashboardShell>,
    );

    expect(screen.getByRole('status')).toHaveTextContent('Service issue');
  });

  it('calls logout when the log out control is activated', async () => {
    mockHealth({ data: undefined, isPending: true });
    const user = userEvent.setup();

    render(
      <DashboardShell>
        <div>content</div>
      </DashboardShell>,
    );
    await user.click(screen.getByRole('button', { name: /log out/i }));

    expect(logout).toHaveBeenCalledTimes(1);
  });
});
