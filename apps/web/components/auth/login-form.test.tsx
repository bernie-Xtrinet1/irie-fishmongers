import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ApiError } from '@/lib/api-client';
import { useAuth } from '@/lib/auth/auth-context';

import { LoginForm } from './login-form';

const push = jest.fn();

jest.mock('next/navigation', () => ({
  useRouter: () => ({
    push,
  }),
}));

jest.mock('@/lib/auth/auth-context', () => ({
  useAuth: jest.fn(),
}));

const mockUseAuth = useAuth as jest.MockedFunction<typeof useAuth>;

describe('LoginForm', () => {
  const login = jest.fn();

  beforeEach(() => {
    push.mockReset();
    login.mockReset();

    mockUseAuth.mockReturnValue({
      status: 'unauthenticated',
      user: null,
      login,
      logout: jest.fn(),
    });
  });

  it('submits trimmed email and password then returns to the marketplace', async () => {
    login.mockResolvedValue(undefined);

    const user = userEvent.setup();

    render(<LoginForm />);

    await user.type(screen.getByLabelText('Email address'), '  customer@example.com  ');
    await user.type(screen.getByLabelText('Password'), 'Password123');

    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    await waitFor(() => {
      expect(login).toHaveBeenCalledWith('customer@example.com', 'Password123');
    });

    expect(push).toHaveBeenCalledWith('/');
  });

  it('shows a friendly message when credentials are rejected', async () => {
    login.mockRejectedValue(new ApiError('Unauthorized', 401));

    const user = userEvent.setup();

    render(<LoginForm />);

    await user.type(screen.getByLabelText('Email address'), 'customer@example.com');
    await user.type(screen.getByLabelText('Password'), 'wrong-password');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Email or password is incorrect.',
    );

    expect(push).not.toHaveBeenCalled();
  });

  it('shows a generic message when login fails unexpectedly', async () => {
    login.mockRejectedValue(new Error('network failure'));

    const user = userEvent.setup();

    render(<LoginForm />);

    await user.type(screen.getByLabelText('Email address'), 'customer@example.com');
    await user.type(screen.getByLabelText('Password'), 'Password123');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'We could not sign you in. Please try again.',
    );
  });

  it('requires email and password fields', () => {
    render(<LoginForm />);

    expect(screen.getByLabelText('Email address')).toBeRequired();
    expect(screen.getByLabelText('Password')).toBeRequired();
  });

  it('shows a successful registration notice when requested', () => {
    render(<LoginForm registered />);

    expect(screen.getByRole('status')).toHaveTextContent(
      'Your account was created successfully. Sign in to continue.',
    );
  });

  it('links new users to registration', () => {
    render(<LoginForm />);

    expect(screen.getByRole('link', { name: 'Create an account' })).toHaveAttribute(
      'href',
      '/register',
    );
  });
});
