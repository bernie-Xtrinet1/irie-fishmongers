import type { DeliveryZone } from '@iriefishmongers/types';
import type { UseQueryResult } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { useCreateDeliveryZone, useDeliveryZones, useUpdateDeliveryZone } from '@/lib/hooks/use-delivery-zones';
import { ZonesSection } from './zones-section';

jest.mock('@/lib/hooks/use-delivery-zones');

const mockUseDeliveryZones = useDeliveryZones as jest.MockedFunction<typeof useDeliveryZones>;
const mockUseCreateDeliveryZone = useCreateDeliveryZone as jest.MockedFunction<typeof useCreateDeliveryZone>;
const mockUseUpdateDeliveryZone = useUpdateDeliveryZone as jest.MockedFunction<typeof useUpdateDeliveryZone>;

function zone(overrides: Partial<DeliveryZone> = {}): DeliveryZone {
  return {
    id: 'zone-1',
    name: 'Zone 1',
    code: 'ZONE_1',
    description: null,
    active: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function withZonesData(data: DeliveryZone[]): UseQueryResult<DeliveryZone[]> {
  return { data, isPending: false, isError: false, refetch: jest.fn() } as unknown as UseQueryResult<DeliveryZone[]>;
}

describe('ZonesSection', () => {
  const createMutateAsync = jest.fn();
  const updateMutateAsync = jest.fn();

  beforeEach(() => {
    createMutateAsync.mockReset().mockResolvedValue(zone());
    updateMutateAsync.mockReset().mockResolvedValue(zone());
    mockUseCreateDeliveryZone.mockReturnValue({
      mutateAsync: createMutateAsync,
    } as unknown as ReturnType<typeof useCreateDeliveryZone>);
    mockUseUpdateDeliveryZone.mockReturnValue({
      mutateAsync: updateMutateAsync,
    } as unknown as ReturnType<typeof useUpdateDeliveryZone>);
  });

  it('shows an empty state when no zones exist', () => {
    mockUseDeliveryZones.mockReturnValue(withZonesData([]));

    render(<ZonesSection />);

    expect(screen.getByText('No delivery zones yet.')).toBeInTheDocument();
  });

  it('renders zone rows with name, code, and active status', () => {
    mockUseDeliveryZones.mockReturnValue(withZonesData([zone()]));

    render(<ZonesSection />);

    expect(screen.getByText('Zone 1')).toBeInTheDocument();
    expect(screen.getByText('ZONE_1')).toBeInTheDocument();
    expect(screen.getByText('Active')).toBeInTheDocument();
  });

  it('submits the create-zone form with entered values', async () => {
    mockUseDeliveryZones.mockReturnValue(withZonesData([]));
    const user = userEvent.setup();

    render(<ZonesSection />);

    await user.click(screen.getByRole('button', { name: 'New zone' }));
    await user.type(screen.getByLabelText('Name'), 'New Zone');
    await user.type(screen.getByLabelText('Code'), 'NEW_ZONE');
    await user.click(screen.getByRole('button', { name: 'Create zone' }));

    expect(createMutateAsync).toHaveBeenCalledWith({ name: 'New Zone', code: 'NEW_ZONE', description: '' });
  });

  it('shows validation errors when required fields are missing', async () => {
    mockUseDeliveryZones.mockReturnValue(withZonesData([]));
    const user = userEvent.setup();

    render(<ZonesSection />);

    await user.click(screen.getByRole('button', { name: 'New zone' }));
    await user.click(screen.getByRole('button', { name: 'Create zone' }));

    expect(await screen.findByText('Name must be at least 2 characters')).toBeInTheDocument();
    expect(createMutateAsync).not.toHaveBeenCalled();
  });

  it('opens the edit dialog pre-filled with the zone values', async () => {
    mockUseDeliveryZones.mockReturnValue(withZonesData([zone({ description: 'Test description' })]));
    const user = userEvent.setup();

    render(<ZonesSection />);

    await user.click(screen.getByRole('button', { name: 'Edit' }));

    expect(screen.getByRole('dialog', { name: 'Edit Zone 1' })).toBeInTheDocument();
    expect(screen.getByLabelText('Name')).toHaveValue('Zone 1');
    expect(screen.getByLabelText('Description')).toHaveValue('Test description');
    expect(screen.getByRole('checkbox', { name: 'Active' })).toBeChecked();
  });
});
