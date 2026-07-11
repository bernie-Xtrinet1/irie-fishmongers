import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { useAuth } from '@/lib/auth/auth-context';
import LoginPage from './page';

jest.mock('@/lib/auth/auth-context');
jest.mock('next/navigation', () => ({
  useRouter: () => ({ replace: jest.fn() }),
}));

const mockUseAuth = useAuth as jest.MockedFunction<typeof useAuth>;

describe('LoginPage', () => {
  const login = jest.fn();

  beforeEach(() => {
    login.mockReset();
    mockUseAuth.mockReturnValue({
      status: 'unauthenticated',
      user: null,
      login,
      logout: jest.fn(),
    });
  });

  it('shows validation errors for an empty submission and never calls login', async () => {
    const user = userEvent.setup();
    render(<LoginPage />);

    await user.click(screen.getByRole('button', { name: /sign in/i }));

    expect(await screen.findByText('Email is required')).toBeInTheDocument();
    expect(screen.getByText('Password is required')).toBeInTheDocument();
    expect(login).not.toHaveBeenCalled();
  });

  it('calls login with the entered credentials', async () => {
    login.mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(<LoginPage />);

    await user.type(screen.getByLabelText(/email/i), 'admin@example.com');
    await user.type(screen.getByLabelText(/password/i), 'AdminPass1');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    await waitFor(() => expect(login).toHaveBeenCalledWith('admin@example.com', 'AdminPass1'));
  });

  it('surfaces the rejection message when login rejects (e.g. non-admin account)', async () => {
    login.mockRejectedValue(new Error('This account does not have admin access.'));
    const user = userEvent.setup();
    render(<LoginPage />);

    await user.type(screen.getByLabelText(/email/i), 'customer@example.com');
    await user.type(screen.getByLabelText(/password/i), 'CustomerPass1');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent('This account does not have admin access.');
  });
});
