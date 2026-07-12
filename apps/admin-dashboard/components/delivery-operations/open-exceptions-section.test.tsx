import {
  DeliveryExceptionType,
  Parish,
  type DeliveryExceptionWithContext,
  type Paginated,
} from '@iriefishmongers/types';
import type { UseQueryResult } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { useDeliveryExceptions, useResolveDeliveryException } from '@/lib/hooks/use-delivery-operations';
import { OpenExceptionsSection } from './open-exceptions-section';

jest.mock('@/lib/hooks/use-delivery-operations');

const push = jest.fn();
let searchParams = new URLSearchParams();

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push }),
  usePathname: () => '/delivery-operations',
  useSearchParams: () => searchParams,
}));

const mockUseDeliveryExceptions = useDeliveryExceptions as jest.MockedFunction<typeof useDeliveryExceptions>;
const mockUseResolveDeliveryException = useResolveDeliveryException as jest.MockedFunction<
  typeof useResolveDeliveryException
>;

function exception(overrides: Partial<DeliveryExceptionWithContext> = {}): DeliveryExceptionWithContext {
  return {
    id: 'exception-1',
    deliveryId: 'delivery-1',
    vendorOrderId: 'vendor-order-1',
    type: DeliveryExceptionType.CUSTOMER_UNAVAILABLE,
    reason: 'Customer did not answer the door after three attempts',
    photos: [],
    notes: null,
    resolved: false,
    resolvedAt: null,
    resolvedById: null,
    vendorBusinessName: "Vera's Catch",
    customerName: 'Cara Customer',
    deliveryAddressLine1: '1 Test Street',
    deliveryParish: Parish.KINGSTON,
    driverName: 'Dana Driver',
    createdAt: '2026-07-12T00:00:00.000Z',
    ...overrides,
  };
}

function withData(
  data: Paginated<DeliveryExceptionWithContext>,
): UseQueryResult<Paginated<DeliveryExceptionWithContext>> {
  return { data, isPending: false, isError: false, refetch: jest.fn() } as unknown as UseQueryResult<
    Paginated<DeliveryExceptionWithContext>
  >;
}

describe('OpenExceptionsSection', () => {
  const mutate = jest.fn();

  beforeEach(() => {
    searchParams = new URLSearchParams();
    push.mockReset();
    mutate.mockReset();
    mockUseResolveDeliveryException.mockReturnValue({
      mutate,
      isPending: false,
    } as unknown as ReturnType<typeof useResolveDeliveryException>);
  });

  it('shows an empty state when there are no open exceptions', () => {
    mockUseDeliveryExceptions.mockReturnValue(withData({ items: [], total: 0, page: 1, pageSize: 20 }));

    render(<OpenExceptionsSection />);

    expect(screen.getByText('No open delivery exceptions.')).toBeInTheDocument();
  });

  it('renders an exception row with vendor, customer, and driver context', () => {
    mockUseDeliveryExceptions.mockReturnValue(withData({ items: [exception()], total: 1, page: 1, pageSize: 20 }));

    render(<OpenExceptionsSection />);

    expect(screen.getByText("Vera's Catch")).toBeInTheDocument();
    expect(screen.getByText('Cara Customer')).toBeInTheDocument();
    expect(screen.getByText('Dana Driver')).toBeInTheDocument();
    expect(screen.getByText('Customer Unavailable')).toBeInTheDocument();
  });

  it('requires confirmation before resolving an exception', async () => {
    mockUseDeliveryExceptions.mockReturnValue(withData({ items: [exception()], total: 1, page: 1, pageSize: 20 }));
    const user = userEvent.setup();

    render(<OpenExceptionsSection />);

    await user.click(screen.getByRole('button', { name: 'Resolve' }));

    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText(/does not change the underlying delivery's status/i)).toBeInTheDocument();
    expect(mutate).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole('button', { name: 'Resolve' }));
    expect(mutate).toHaveBeenCalledWith('exception-1');
  });
});
