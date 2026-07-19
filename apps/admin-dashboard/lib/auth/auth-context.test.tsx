import { QueryClient } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { apiPost } from '@/lib/api-client';
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
