import { EmergencyResponseStatus, type EmergencyResponse } from '@iriefishmongers/types';
import type { UseQueryResult } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import {
  useAcknowledgeEmergencyResponse,
  useEmergencyResponses,
  useUpdateEmergencyResponseStatus,
} from '@/lib/hooks/use-cold-chain';
import { EmergencyResponsesSection } from './emergency-responses-section';

jest.mock('@/lib/hooks/use-cold-chain');

const push = jest.fn();
let searchParams = new URLSearchParams();

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push }),
  usePathname: () => '/cold-chain',
  useSearchParams: () => searchParams,
}));

const mockUseEmergencyResponses = useEmergencyResponses as jest.MockedFunction<typeof useEmergencyResponses>;
const mockUseAcknowledge = useAcknowledgeEmergencyResponse as jest.MockedFunction<typeof useAcknowledgeEmergencyResponse>;
const mockUseUpdateStatus = useUpdateEmergencyResponseStatus as jest.MockedFunction<typeof useUpdateEmergencyResponseStatus>;

function response(overrides: Partial<EmergencyResponse> = {}): EmergencyResponse {
  return {
    id: 'response-1',
    alertId: 'alert-1',
    assignedToId: null,
    status: EmergencyResponseStatus.OPEN,
    actionsTaken: null,
    rootCause: null,
    correctiveAction: null,
    preventiveAction: null,
    acknowledgedAt: null,
    resolvedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function withData(data: EmergencyResponse[]): UseQueryResult<EmergencyResponse[]> {
  return { data, isPending: false, isError: false, refetch: jest.fn() } as unknown as UseQueryResult<
    EmergencyResponse[]
  >;
}

describe('EmergencyResponsesSection', () => {
  const acknowledgeMutate = jest.fn();
  const updateStatusMutateAsync = jest.fn();

  beforeEach(() => {
    searchParams = new URLSearchParams();
    push.mockReset();
    acknowledgeMutate.mockReset();
    updateStatusMutateAsync.mockReset().mockResolvedValue(response());
    mockUseAcknowledge.mockReturnValue({
      mutate: acknowledgeMutate,
      isPending: false,
    } as unknown as ReturnType<typeof useAcknowledgeEmergencyResponse>);
    mockUseUpdateStatus.mockReturnValue({
      mutateAsync: updateStatusMutateAsync,
    } as unknown as ReturnType<typeof useUpdateEmergencyResponseStatus>);
  });

  it('shows an empty state when no emergency responses match the filter', () => {
    mockUseEmergencyResponses.mockReturnValue(withData([]));

    render(<EmergencyResponsesSection />);

    expect(screen.getByText('No emergency responses match this filter.')).toBeInTheDocument();
  });

  it('acknowledges an OPEN response directly with no confirmation dialog', async () => {
    mockUseEmergencyResponses.mockReturnValue(withData([response()]));
    const user = userEvent.setup();

    render(<EmergencyResponsesSection />);

    await user.click(screen.getByRole('button', { name: 'Acknowledge' }));

    expect(acknowledgeMutate).toHaveBeenCalledWith('response-1');
  });

  it('requires root cause and corrective action before resolving a CONTAINED response', async () => {
    mockUseEmergencyResponses.mockReturnValue(withData([response({ status: EmergencyResponseStatus.CONTAINED })]));
    const user = userEvent.setup();

    render(<EmergencyResponsesSection />);

    await user.click(screen.getByRole('button', { name: 'Resolve' }));

    const dialog = await screen.findByRole('dialog', { name: 'Resolve emergency response' });
    await user.click(within(dialog).getByRole('button', { name: 'Resolve' }));

    expect(await within(dialog).findByText('Root cause must be at least 10 characters')).toBeInTheDocument();
    expect(updateStatusMutateAsync).not.toHaveBeenCalled();

    await user.type(within(dialog).getByLabelText('Root cause'), 'Freezer unit compressor failure overnight');
    await user.type(within(dialog).getByLabelText('Corrective action'), 'Replaced compressor and re-verified logs');
    await user.click(within(dialog).getByRole('button', { name: 'Resolve' }));

    expect(updateStatusMutateAsync).toHaveBeenCalledWith({
      id: 'response-1',
      input: {
        status: EmergencyResponseStatus.RESOLVED,
        rootCause: 'Freezer unit compressor failure overnight',
        correctiveAction: 'Replaced compressor and re-verified logs',
        preventiveAction: '',
      },
    });
  });
});
