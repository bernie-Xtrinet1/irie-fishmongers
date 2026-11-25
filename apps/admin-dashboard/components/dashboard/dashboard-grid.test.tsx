import { render, screen } from '@testing-library/react';

import { useOptionalAuth } from '@/lib/auth/auth-context';
import { DashboardGrid } from './dashboard-grid';

jest.mock('@/lib/auth/auth-context', () => ({
  useOptionalAuth: jest.fn(),
}));

jest.mock('./financial-summary-card', () => ({
  FinancialSummaryCard: () => <div>FinancialSummaryCardMock</div>,
}));
jest.mock('./orders-summary-card', () => ({
  OrdersSummaryCard: () => <div>OrdersSummaryCardMock</div>,
}));
jest.mock('./vendor-summary-card', () => ({
  VendorSummaryCard: () => <div>VendorSummaryCardMock</div>,
}));
jest.mock('./driver-summary-card', () => ({
  DriverSummaryCard: () => <div>DriverSummaryCardMock</div>,
}));

const mockUseOptionalAuth = useOptionalAuth as jest.MockedFunction<typeof useOptionalAuth>;

describe('DashboardGrid', () => {
  it('hides FinancialSummaryCard for OPERATIONS_STAFF while keeping operational widgets', () => {
    mockUseOptionalAuth.mockReturnValue({
      status: 'authenticated',
      user: {
        id: 'staff-1',
        email: 'staff.operations@iriefishmongers.test',
        firstName: 'Ops',
        lastName: 'Staff',
        status: 'ACTIVE',
        roles: ['OPERATIONS_STAFF'],
      },
      login: jest.fn(),
      logout: jest.fn(),
    });

    render(<DashboardGrid />);

    expect(screen.queryByText('FinancialSummaryCardMock')).not.toBeInTheDocument();
    expect(screen.getByText('OrdersSummaryCardMock')).toBeInTheDocument();
    expect(screen.getByText('VendorSummaryCardMock')).toBeInTheDocument();
    expect(screen.getByText('DriverSummaryCardMock')).toBeInTheDocument();
  });

  it('renders FinancialSummaryCard for active ADMINISTRATOR', () => {
    mockUseOptionalAuth.mockReturnValue({
      status: 'authenticated',
      user: {
        id: 'admin-1',
        email: 'admin@demo.iriefishmongers.test',
        firstName: 'Ada',
        lastName: 'Admin',
        status: 'ACTIVE',
        roles: ['ADMINISTRATOR'],
      },
      login: jest.fn(),
      logout: jest.fn(),
    });

    render(<DashboardGrid />);

    expect(screen.getByText('FinancialSummaryCardMock')).toBeInTheDocument();
  });
});
