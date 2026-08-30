import { UserRole } from '@iriefishmongers/types';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ApiError, apiPost } from '@/lib/api-client';

import { RegisterForm } from './register-form';

const push = jest.fn();

jest.mock('next/navigation', () => ({
  useRouter: () => ({
    push,
  }),
}));

jest.mock('@/lib/api-client', () => {
  const actual =
    jest.requireActual<typeof import('@/lib/api-client')>('@/lib/api-client');

  return {
    ...actual,
    apiPost: jest.fn(),
  };
});

const mockApiPost = apiPost as jest.MockedFunction<typeof apiPost>;

async function fillValidForm(): Promise<void> {
  const user = userEvent.setup();

  await user.type(screen.getByLabelText('First name'), 'Jane');
  await user.type(screen.getByLabelText('Last name'), 'Doe');
  await user.type(screen.getByLabelText('Email address'), 'jane@example.com');
  await user.type(screen.getByLabelText('Password'), 'StrongPass1');
  await user.type(screen.getByLabelText('Confirm password'), 'StrongPass1');
}

describe('RegisterForm', () => {
  beforeEach(() => {
    push.mockReset();
    mockApiPost.mockReset();
  });

  it('offers only the four self-registerable marketplace roles', () => {
    render(<RegisterForm />);

    const accountType = screen.getByLabelText('Account type');

    expect(accountType).toHaveValue(UserRole.CUSTOMER);

    expect(screen.getByRole('option', { name: 'Customer' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Vendor' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Driver' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Fisherman' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Administrator' })).not.toBeInTheDocument();
  });

  it('registers a customer and redirects to login with success state', async () => {
    mockApiPost.mockResolvedValue({});

    render(<RegisterForm />);
    await fillValidForm();

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Create account' }));

    await waitFor(() => {
      expect(mockApiPost).toHaveBeenCalledWith('/auth/register', {
        firstName: 'Jane',
        lastName: 'Doe',
        email: 'jane@example.com',
        password: 'StrongPass1',
        confirmPassword: 'StrongPass1',
        role: UserRole.CUSTOMER,
      });
    });

    expect(push).toHaveBeenCalledWith('/login?registered=1');
  });

  it('includes an optional phone number when supplied', async () => {
    mockApiPost.mockResolvedValue({});

    render(<RegisterForm />);

    await fillValidForm();

    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/Phone number/), '+18765551234');
    await user.selectOptions(screen.getByLabelText('Account type'), UserRole.VENDOR);
    await user.click(screen.getByRole('button', { name: 'Create account' }));

    await waitFor(() => {
      expect(mockApiPost).toHaveBeenCalledWith(
        '/auth/register',
        expect.objectContaining({
          phone: '+18765551234',
          role: UserRole.VENDOR,
        }),
      );
    });
  });

  it('rejects a password that does not meet the backend strength rule', async () => {
    render(<RegisterForm />);

    const user = userEvent.setup();

    await user.type(screen.getByLabelText('First name'), 'Jane');
    await user.type(screen.getByLabelText('Last name'), 'Doe');
    await user.type(screen.getByLabelText('Email address'), 'jane@example.com');
    await user.type(screen.getByLabelText('Password'), 'weakpass');
    await user.type(screen.getByLabelText('Confirm password'), 'weakpass');

    await user.click(screen.getByRole('button', { name: 'Create account' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Password must be at least 8 characters and include an uppercase letter, a lowercase letter, and a number.',
    );

    expect(mockApiPost).not.toHaveBeenCalled();
  });

  it('rejects mismatched password confirmation', async () => {
    render(<RegisterForm />);

    const user = userEvent.setup();

    await user.type(screen.getByLabelText('First name'), 'Jane');
    await user.type(screen.getByLabelText('Last name'), 'Doe');
    await user.type(screen.getByLabelText('Email address'), 'jane@example.com');
    await user.type(screen.getByLabelText('Password'), 'StrongPass1');
    await user.type(screen.getByLabelText('Confirm password'), 'StrongPass2');

    await user.click(screen.getByRole('button', { name: 'Create account' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Passwords do not match.');
    expect(mockApiPost).not.toHaveBeenCalled();
  });

  it('shows a useful message when the email is already registered', async () => {
    mockApiPost.mockRejectedValue(new ApiError('Conflict', 409));

    render(<RegisterForm />);
    await fillValidForm();

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Create account' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'An account with this email already exists.',
    );

    expect(push).not.toHaveBeenCalled();
  });
});
