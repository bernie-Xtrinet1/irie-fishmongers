import { QueryClient } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { apiPost, configureApiClient } from '@/lib/api-client';
import { AuthProvider, useAuth } from './auth-context';

jest.mock('@/lib/api-client', () => ({
  apiPost: jest.fn(),
  configureApiClient: jest.fn(),
}));

const mockApiPost = apiPost as jest.MockedFunction<typeof apiPost>;
const mockConfigureApiClient = configureApiClient as jest.MockedFunction<typeof configureApiClient>;

const authenticatedSession = {
  accessToken: 'access-token',
  refreshToken: 'refresh-token',
  user: {
    id: 'user-1',
    email: 'customer@example.com',
    firstName: 'Cara',
    lastName: 'Customer',
    phone: null,
    status: 'ACTIVE',
    roles: ['CUSTOMER'],
    createdAt: '2026-08-30T12:00:00.000Z',
  },
};

function TestConsumer(): React.ReactElement {
  const { status, user, login, logout } = useAuth();

  return (
    <div>
      <span data-testid="status">{status}</span>
      <span data-testid="user">{user?.email ?? 'none'}</span>

      <button
        onClick={() => {
          login('customer@example.com', 'Password!23').catch(() => undefined);
        }}
      >
        login
      </button>

      <button
        onClick={() => {
          logout().catch(() => undefined);
        }}
      >
        logout
      </button>
    </div>
  );
}

describe('Web AuthProvider', () => {
  let queryClient: QueryClient;
  let clearSpy: jest.SpiedFunction<QueryClient['clear']>;

  beforeEach(() => {
    queryClient = new QueryClient();
    clearSpy = jest.spyOn(queryClient, 'clear');

    mockApiPost.mockReset();
    mockConfigureApiClient.mockReset();
  });

  it('restores an authenticated session with silent refresh', async () => {
    mockApiPost.mockResolvedValueOnce(authenticatedSession);

    render(
      <AuthProvider queryClient={queryClient}>
        <TestConsumer />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('status')).toHaveTextContent('authenticated');
    });

    expect(screen.getByTestId('user')).toHaveTextContent('customer@example.com');
    expect(mockApiPost).toHaveBeenCalledWith('/auth/refresh', {});
  });

  it('becomes unauthenticated when silent refresh fails', async () => {
    mockApiPost.mockRejectedValueOnce(new Error('No refresh cookie'));

    render(
      <AuthProvider queryClient={queryClient}>
        <TestConsumer />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('status')).toHaveTextContent('unauthenticated');
    });

    expect(screen.getByTestId('user')).toHaveTextContent('none');
  });

  it('clears cached server state before exposing a newly logged-in account', async () => {
    mockApiPost
      .mockRejectedValueOnce(new Error('No refresh cookie'))
      .mockResolvedValueOnce(authenticatedSession);

    const user = userEvent.setup();

    render(
      <AuthProvider queryClient={queryClient}>
        <TestConsumer />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('status')).toHaveTextContent('unauthenticated');
    });

    await user.click(screen.getByRole('button', { name: 'login' }));

    await waitFor(() => {
      expect(screen.getByTestId('status')).toHaveTextContent('authenticated');
    });

    expect(screen.getByTestId('user')).toHaveTextContent('customer@example.com');
    expect(mockApiPost).toHaveBeenCalledWith('/auth/login', {
      email: 'customer@example.com',
      password: 'Password!23',
    });
    expect(clearSpy).toHaveBeenCalled();
  });

  it('clears cached server state and session on logout', async () => {
    mockApiPost
      .mockResolvedValueOnce(authenticatedSession)
      .mockResolvedValueOnce({ success: true });

    const user = userEvent.setup();

    render(
      <AuthProvider queryClient={queryClient}>
        <TestConsumer />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('status')).toHaveTextContent('authenticated');
    });

    await user.click(screen.getByRole('button', { name: 'logout' }));

    await waitFor(() => {
      expect(screen.getByTestId('status')).toHaveTextContent('unauthenticated');
    });

    expect(screen.getByTestId('user')).toHaveTextContent('none');
    expect(mockApiPost).toHaveBeenCalledWith('/auth/logout', {});
    expect(clearSpy).toHaveBeenCalled();
  });

  it('keeps refreshed access tokens in memory and clears an unauthorized session', async () => {
    mockApiPost.mockResolvedValueOnce(authenticatedSession);

    render(
      <AuthProvider queryClient={queryClient}>
        <TestConsumer />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('status')).toHaveTextContent('authenticated');
    });

    expect(mockConfigureApiClient).toHaveBeenCalledTimes(1);

    const config = mockConfigureApiClient.mock.calls[0]?.[0];

    expect(config).toBeDefined();

    if (!config) {
      throw new Error('API client configuration was not registered');
    }

    expect(config.getAccessToken()).toBe('access-token');

    act(() => {
      config.onTokenRefreshed('refreshed-access-token');
    });

    expect(config.getAccessToken()).toBe('refreshed-access-token');

    act(() => {
      config.onUnauthorized();
    });

    expect(screen.getByTestId('status')).toHaveTextContent('unauthenticated');
    expect(screen.getByTestId('user')).toHaveTextContent('none');
    expect(config.getAccessToken()).toBeNull();
    expect(clearSpy).toHaveBeenCalled();
  });
});
