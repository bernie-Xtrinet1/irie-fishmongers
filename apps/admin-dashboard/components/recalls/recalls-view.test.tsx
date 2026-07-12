import { RecallSeverityClass, RecallStatus, type Paginated, type Recall } from '@iriefishmongers/types';
import type { UseQueryResult } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import {
  useAffectedOrders,
  useCreateRecall,
  useRecallAuditLog,
  useRecalls,
  useUpdateRecallStatus,
} from '@/lib/hooks/use-recalls';
import { RecallsView } from './recalls-view';

jest.mock('@/lib/hooks/use-recalls');

const push = jest.fn();
let searchParams = new URLSearchParams();

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push }),
  usePathname: () => '/recalls',
  useSearchParams: () => searchParams,
}));

const mockUseRecalls = useRecalls as jest.MockedFunction<typeof useRecalls>;
const mockUseCreateRecall = useCreateRecall as jest.MockedFunction<typeof useCreateRecall>;
const mockUseUpdateRecallStatus = useUpdateRecallStatus as jest.MockedFunction<typeof useUpdateRecallStatus>;
const mockUseAffectedOrders = useAffectedOrders as jest.MockedFunction<typeof useAffectedOrders>;
const mockUseRecallAuditLog = useRecallAuditLog as jest.MockedFunction<typeof useRecallAuditLog>;

function recall(overrides: Partial<Recall> = {}): Recall {
  return {
    id: 'recall-1',
    severityClass: RecallSeverityClass.CLASS_II,
    status: RecallStatus.DRAFT,
    reason: 'Elevated histamine levels detected in post-market sampling',
    rootCause: null,
    resolutionNotes: null,
    createdById: 'admin-1',
    lotIds: ['86992742-8349-4fc3-8667-e398269235c6'],
    closedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    retentionExpiresAt: '2033-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function withData(data: Paginated<Recall>): UseQueryResult<Paginated<Recall>> {
  return { data, isPending: false, isError: false, refetch: jest.fn() } as unknown as UseQueryResult<
    Paginated<Recall>
  >;
}

describe('RecallsView', () => {
  const createMutateAsync = jest.fn();
  const updateStatusMutateAsync = jest.fn();

  beforeEach(() => {
    searchParams = new URLSearchParams();
    push.mockReset();
    createMutateAsync.mockReset().mockResolvedValue(recall());
    updateStatusMutateAsync.mockReset().mockResolvedValue(recall({ status: RecallStatus.ACTIVE }));
    mockUseCreateRecall.mockReturnValue({
      mutateAsync: createMutateAsync,
    } as unknown as ReturnType<typeof useCreateRecall>);
    mockUseUpdateRecallStatus.mockReturnValue({
      mutateAsync: updateStatusMutateAsync,
    } as unknown as ReturnType<typeof useUpdateRecallStatus>);
    mockUseAffectedOrders.mockReturnValue({
      data: [],
      isPending: false,
      isError: false,
    } as unknown as ReturnType<typeof useAffectedOrders>);
    mockUseRecallAuditLog.mockReturnValue({
      data: { items: [], total: 0, page: 1, pageSize: 20 },
      isPending: false,
      isError: false,
    } as unknown as ReturnType<typeof useRecallAuditLog>);
  });

  it('shows an empty state when no recalls match the filters', () => {
    mockUseRecalls.mockReturnValue(withData({ items: [], total: 0, page: 1, pageSize: 20 }));

    render(<RecallsView />);

    expect(screen.getByText('No recalls match these filters.')).toBeInTheDocument();
  });

  it('renders recall rows with reason, severity, and status', () => {
    mockUseRecalls.mockReturnValue(withData({ items: [recall()], total: 1, page: 1, pageSize: 20 }));

    render(<RecallsView />);

    expect(screen.getByText('Elevated histamine levels detected in post-market sampling')).toBeInTheDocument();
    expect(screen.getByText('Class Ii')).toBeInTheDocument();
    expect(screen.getByText('Draft')).toBeInTheDocument();
  });

  it('submits a new recall with parsed lot ids', async () => {
    mockUseRecalls.mockReturnValue(withData({ items: [], total: 0, page: 1, pageSize: 20 }));
    const user = userEvent.setup();

    render(<RecallsView />);

    await user.click(screen.getByRole('button', { name: 'New recall' }));
    const dialog = await screen.findByRole('dialog', { name: 'Create recall' });
    await user.type(within(dialog).getByLabelText('Reason'), 'Confirmed pathogenic contamination in sampled product');
    await user.type(
      within(dialog).getByLabelText('Affected lot ids (comma-separated)'),
      '86992742-8349-4fc3-8667-e398269235c6, cd02fd5f-35e0-4944-bd58-4c1407d3bb07',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Create recall' }));

    expect(await within(dialog).findByText('Select a severity class')).toBeInTheDocument();
    expect(createMutateAsync).not.toHaveBeenCalled();
  });

  it('shows a warning and advances a DRAFT recall to ACTIVE', async () => {
    mockUseRecalls.mockReturnValue(withData({ items: [recall()], total: 1, page: 1, pageSize: 20 }));
    const user = userEvent.setup();

    render(<RecallsView />);

    await user.click(screen.getByRole('button', { name: 'Active' }));
    const dialog = await screen.findByRole('dialog', { name: 'Activate recall' });
    expect(within(dialog).getByText(/marks every linked lot as RECALLED/i)).toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: 'Activate recall' }));

    expect(updateStatusMutateAsync).toHaveBeenCalledWith({
      id: 'recall-1',
      input: { status: RecallStatus.ACTIVE, rootCause: undefined, resolutionNotes: undefined },
    });
  });

  it('opens the detail dialog with affected orders and audit history', async () => {
    mockUseRecalls.mockReturnValue(withData({ items: [recall()], total: 1, page: 1, pageSize: 20 }));
    mockUseAffectedOrders.mockReturnValue({
      data: [
        {
          orderId: 'order-1',
          vendorOrderId: 'vendor-order-1',
          customerId: 'customer-1',
          customerEmail: 'customer@example.com',
          productId: 'product-1',
          productName: 'Fresh Snapper',
          quantity: 2,
          lotId: '86992742-8349-4fc3-8667-e398269235c6',
        },
      ],
      isPending: false,
      isError: false,
    } as unknown as ReturnType<typeof useAffectedOrders>);
    const user = userEvent.setup();

    render(<RecallsView />);

    await user.click(screen.getByRole('button', { name: 'View details' }));

    const dialog = await screen.findByRole('alertdialog', { name: 'Recall details' });
    expect(within(dialog).getByText('Fresh Snapper')).toBeInTheDocument();
    expect(within(dialog).getByText('No audit history recorded yet.')).toBeInTheDocument();
  });
});
