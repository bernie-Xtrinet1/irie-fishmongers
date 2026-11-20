import { QueryClient } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { apiPost, configureApiClient } from '@/lib/api-client';
import { AuthProvider, useAuth } from './auth-context';

jest.mock('@/lib/api-client', () => ({
  apiPost: jest.fn(),
  configureApiClient: jest.fn(),
}));

const replace = jest.fn();
jest.mock('next/navigation', () => ({
  useRouter: () => ({ replace }),
}));

const mockApiPost = apiPost as jest.MockedFunction<typeof apiPost>;

function TestConsumer(): React.ReactElement {
  const { status, user, login } = useAuth();
  return (
    <div>
      <span data-testid="status">{status}</span>
      <span data-testid="user">{user?.email ?? 'none'}</span>
      <button
        onClick={() => {
          login('someone@example.com', 'password').catch(() => undefined);
        }}
      >
        login
      </button>
    </div>
  );
}

describe('AuthProvider - non-administrator session revocation', () => {
  let queryClient: QueryClient;
  let clearSpy: jest.SpiedFunction<QueryClient['clear']>;

  beforeEach(() => {
    queryClient = new QueryClient();
    clearSpy = jest.spyOn(queryClient, 'clear');
    mockApiPost.mockReset();
    jest.clearAllMocks();
    replace.mockReset();
  });

  it('revokes the session and never authenticates when silent refresh resolves a non-admin user', async () => {
    mockApiPost.mockResolvedValueOnce({
      accessToken: 'token',
      refreshToken: 'refresh',
      user: { id: '1', email: 'customer@example.com', firstName: 'Cara', lastName: 'Customer', roles: ['CUSTOMER'] },
    }); // POST /auth/refresh (silent refresh on mount)
    mockApiPost.mockResolvedValueOnce({ success: true }); // POST /auth/logout (revocation)

    render(
      <AuthProvider queryClient={queryClient}>
        <TestConsumer />
      </AuthProvider>,
    );

    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('unauthenticated'));

    expect(screen.getByTestId('user')).toHaveTextContent('none');
    expect(mockApiPost).toHaveBeenNthCalledWith(1, '/auth/refresh', {});
    expect(mockApiPost).toHaveBeenNthCalledWith(2, '/auth/logout', {});
    expect(clearSpy).toHaveBeenCalled();
    // No protected route redirect happens here - status simply never
    // becomes 'authenticated', so RequireAdmin's own effect sends the
    // browser to /login.
  });

  it('revokes and clears cache when SUSPENDED admin refreshes or onTokenRefreshed loses admin role', async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(['admin-vendors'], [{ id: 'v1' }]);
    const clearSpy = jest.spyOn(queryClient, 'clear');

    mockApiPost.mockResolvedValueOnce({
      accessToken: 'admin-token',
      user: {
        id: 'admin-1',
        email: 'admin@example.com',
        firstName: 'Admin',
        lastName: 'User',
        status: 'ACTIVE',
        roles: ['ADMINISTRATOR'],
      },
    });
    mockApiPost.mockResolvedValueOnce({ success: true });

    function MiniProbe(): React.ReactElement {
      const { status, user } = useAuth();
      return (
        <div>
          <span data-testid="mini-status">{status}</span>
          <span data-testid="mini-user">{user ? user.roles.join(',') : 'none'}</span>
        </div>
      );
    }

    render(
      <AuthProvider queryClient={queryClient}>
        <MiniProbe />
      </AuthProvider>,
    );

    await waitFor(() => expect(screen.getByTestId('mini-status')).toHaveTextContent('authenticated'));
    expect(queryClient.getQueryData(['admin-vendors'])).toEqual([{ id: 'v1' }]);

    const mockConfigure = configureApiClient as jest.MockedFunction<typeof configureApiClient>;
    const lastConfig = mockConfigure.mock.calls[mockConfigure.mock.calls.length - 1]?.[0];
    expect(lastConfig).toBeDefined();

    act(() => {
      lastConfig!.onTokenRefreshed('next-token', {
        id: 'admin-1',
        roles: ['CUSTOMER'],
        status: 'ACTIVE',
      });
    });

    expect(clearSpy).toHaveBeenCalled();
    expect(queryClient.getQueryData(['admin-vendors'])).toBeUndefined();
    expect(screen.getByTestId('mini-status')).toHaveTextContent('unauthenticated');
    expect(screen.getByTestId('mini-user')).toHaveTextContent('none');
    expect(replace).toHaveBeenCalledWith('/login');
  });

  it('clears cache, session, and navigates on onUnauthorized and rejects SUSPENDED admin on login', async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(['admin-recalls'], [{ id: 'r1' }]);
    const clearSpy = jest.spyOn(queryClient, 'clear');

    mockApiPost.mockRejectedValueOnce(new Error('no refresh cookie'));
    mockApiPost.mockResolvedValueOnce({
      accessToken: 'susp-token',
      user: {
        id: 'admin-susp',
        email: 'susp@example.com',
        firstName: 'Susp',
        lastName: 'Admin',
        status: 'SUSPENDED',
        roles: ['ADMINISTRATOR'],
      },
    });
    mockApiPost.mockResolvedValueOnce({ success: true });

    let capturedError: unknown;
    function LoginCaller(): React.ReactElement {
      const { status, login } = useAuth();
      return (
        <div>
          <span data-testid="login-status">{status}</span>
          <button
            onClick={() => {
              void login('susp@example.com', 'password').catch((err) => {
                capturedError = err;
              });
            }}
          >
            trigger-login
          </button>
        </div>
      );
    }

    render(
      <AuthProvider queryClient={queryClient}>
        <LoginCaller />
      </AuthProvider>,
    );

    await waitFor(() => expect(screen.getByTestId('login-status')).toHaveTextContent('unauthenticated'));

    const mockConfigure = configureApiClient as jest.MockedFunction<typeof configureApiClient>;
    const lastConfig = mockConfigure.mock.calls[mockConfigure.mock.calls.length - 1]?.[0];
    act(() => {
      lastConfig!.onUnauthorized();
    });
    expect(clearSpy).toHaveBeenCalled();
    expect(replace).toHaveBeenCalledWith('/login');

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'trigger-login' }));
    await waitFor(() => expect(mockApiPost).toHaveBeenCalledWith('/auth/logout', {}));
    expect((capturedError as Error)?.message).toContain('admin access');
  });

  it('revokes the session and rejects when login succeeds for a non-administrator account', async () => {
    mockApiPost.mockRejectedValueOnce(new Error('no refresh cookie')); // initial silent refresh
    mockApiPost.mockResolvedValueOnce({
      accessToken: 'token',
      refreshToken: 'refresh',
      user: { id: '2', email: 'vendor@example.com', firstName: 'Vera', lastName: 'Vendor', roles: ['VENDOR'] },
    }); // POST /auth/login
    mockApiPost.mockResolvedValueOnce({ success: true }); // POST /auth/logout (revocation)

    const user = userEvent.setup();
    render(
      <AuthProvider queryClient={queryClient}>
        <TestConsumer />
      </AuthProvider>,
    );

    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('unauthenticated'));

    await user.click(screen.getByRole('button', { name: 'login' }));

    await waitFor(() => expect(mockApiPost).toHaveBeenCalledWith('/auth/logout', {}));
    expect(screen.getByTestId('status')).toHaveTextContent('unauthenticated');
    expect(screen.getByTestId('user')).toHaveTextContent('none');
    expect(clearSpy).toHaveBeenCalled();
  });
});
