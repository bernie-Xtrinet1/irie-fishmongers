import type { UseQueryResult } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { SummaryCard } from './summary-card';

function query(overrides: Partial<UseQueryResult<{ value: number }>>): UseQueryResult<{ value: number }> {
  return {
    data: undefined,
    isPending: false,
    isError: false,
    isFetching: false,
    refetch: jest.fn(),
    ...overrides,
  } as UseQueryResult<{ value: number }>;
}

describe('SummaryCard', () => {
  it('shows a skeleton while the first load is pending', () => {
    render(<SummaryCard title="Widget" query={query({ isPending: true })}>{() => <p>loaded</p>}</SummaryCard>);

    expect(screen.getByText('Widget')).toBeInTheDocument();
    expect(screen.queryByText('loaded')).not.toBeInTheDocument();
  });

  it('shows an error state with a working retry action', async () => {
    const refetch = jest.fn();
    const user = userEvent.setup();

    render(
      <SummaryCard title="Widget" query={query({ isError: true, refetch })}>
        {() => <p>loaded</p>}
      </SummaryCard>,
    );

    expect(screen.getByText('Unable to load this data.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /retry/i }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('renders the loaded content and marks a background refetch without hiding it', () => {
    render(
      <SummaryCard title="Widget" query={query({ data: { value: 42 }, isFetching: true })}>
        {(data) => <p>value is {data.value}</p>}
      </SummaryCard>,
    );

    expect(screen.getByText('value is 42')).toBeInTheDocument();
    // aria-busy signals a background refresh without re-showing the skeleton.
    expect(screen.getByText('Widget').closest('[aria-busy]')).toHaveAttribute('aria-busy', 'true');
  });
});
