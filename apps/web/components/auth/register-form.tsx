'use client';

import { UserRole, type AuthUser, type RegisterRequest, type SelfRegisterableRole } from '@iriefishmongers/types';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { ApiError, apiPost } from '@/lib/api-client';

const STRONG_PASSWORD_PATTERN = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).{8,}$/;

const ACCOUNT_TYPES: Array<{ value: SelfRegisterableRole; label: string }> = [
  { value: UserRole.CUSTOMER, label: 'Customer' },
  { value: UserRole.VENDOR, label: 'Vendor' },
  { value: UserRole.DRIVER, label: 'Driver' },
  { value: UserRole.FISHERMAN, label: 'Fisherman' },
];

function registrationErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 409) {
      return 'An account with this email already exists.';
    }

    if (error.status === 400) {
      return 'Please check your registration details and try again.';
    }
  }

  return 'We could not create your account. Please try again.';
}

export function RegisterForm(): React.ReactElement {
  const router = useRouter();

  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [role, setRole] = useState<SelfRegisterableRole>(UserRole.CUSTOMER);
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setErrorMessage(null);

    if (!STRONG_PASSWORD_PATTERN.test(password)) {
      setErrorMessage(
        'Password must be at least 8 characters and include an uppercase letter, a lowercase letter, and a number.',
      );
      return;
    }

    if (password !== confirmPassword) {
      setErrorMessage('Passwords do not match.');
      return;
    }

    setIsSubmitting(true);

    const trimmedPhone = phone.trim();

    const request: RegisterRequest = {
      firstName: firstName.trim(),
      lastName: lastName.trim(),
      email: email.trim(),
      password,
      confirmPassword,
      role,
      ...(trimmedPhone ? { phone: trimmedPhone } : {}),
    };

    try {
      await apiPost<AuthUser>('/auth/register', request);
      router.push('/login?registered=1');
    } catch (error) {
      setErrorMessage(registrationErrorMessage(error));
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <form
      onSubmit={(event) => {
        void handleSubmit(event);
      }}
      className="space-y-5"
    >
      <div className="grid gap-5 sm:grid-cols-2">
        <div>
          <label htmlFor="firstName" className="block text-sm font-medium text-gray-700">
            First name
          </label>
          <input
            id="firstName"
            name="firstName"
            type="text"
            autoComplete="given-name"
            required
            value={firstName}
            onChange={(event) => setFirstName(event.target.value)}
            className="mt-1 block w-full rounded-md border border-gray-300 bg-white px-3 py-2.5 text-sm text-gray-900 outline-none transition focus:border-irie-green focus:ring-2 focus:ring-irie-green/20"
          />
        </div>

        <div>
          <label htmlFor="lastName" className="block text-sm font-medium text-gray-700">
            Last name
          </label>
          <input
            id="lastName"
            name="lastName"
            type="text"
            autoComplete="family-name"
            required
            value={lastName}
            onChange={(event) => setLastName(event.target.value)}
            className="mt-1 block w-full rounded-md border border-gray-300 bg-white px-3 py-2.5 text-sm text-gray-900 outline-none transition focus:border-irie-green focus:ring-2 focus:ring-irie-green/20"
          />
        </div>
      </div>

      <div>
        <label htmlFor="email" className="block text-sm font-medium text-gray-700">
          Email address
        </label>
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          className="mt-1 block w-full rounded-md border border-gray-300 bg-white px-3 py-2.5 text-sm text-gray-900 outline-none transition focus:border-irie-green focus:ring-2 focus:ring-irie-green/20"
        />
      </div>

      <div>
        <label htmlFor="phone" className="block text-sm font-medium text-gray-700">
          Phone number <span className="font-normal text-gray-500">(optional)</span>
        </label>
        <input
          id="phone"
          name="phone"
          type="tel"
          autoComplete="tel"
          placeholder="+18765551234"
          value={phone}
          onChange={(event) => setPhone(event.target.value)}
          className="mt-1 block w-full rounded-md border border-gray-300 bg-white px-3 py-2.5 text-sm text-gray-900 outline-none transition focus:border-irie-green focus:ring-2 focus:ring-irie-green/20"
        />
      </div>

      <div>
        <label htmlFor="role" className="block text-sm font-medium text-gray-700">
          Account type
        </label>
        <select
          id="role"
          name="role"
          value={role}
          onChange={(event) => setRole(event.target.value as SelfRegisterableRole)}
          className="mt-1 block w-full rounded-md border border-gray-300 bg-white px-3 py-2.5 text-sm text-gray-900 outline-none transition focus:border-irie-green focus:ring-2 focus:ring-irie-green/20"
        >
          {ACCOUNT_TYPES.map((accountType) => (
            <option key={accountType.value} value={accountType.value}>
              {accountType.label}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label htmlFor="password" className="block text-sm font-medium text-gray-700">
          Password
        </label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="new-password"
          required
          minLength={8}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          className="mt-1 block w-full rounded-md border border-gray-300 bg-white px-3 py-2.5 text-sm text-gray-900 outline-none transition focus:border-irie-green focus:ring-2 focus:ring-irie-green/20"
        />
        <p className="mt-1 text-xs leading-5 text-gray-500">
          Use at least 8 characters with uppercase, lowercase, and a number.
        </p>
      </div>

      <div>
        <label htmlFor="confirmPassword" className="block text-sm font-medium text-gray-700">
          Confirm password
        </label>
        <input
          id="confirmPassword"
          name="confirmPassword"
          type="password"
          autoComplete="new-password"
          required
          value={confirmPassword}
          onChange={(event) => setConfirmPassword(event.target.value)}
          className="mt-1 block w-full rounded-md border border-gray-300 bg-white px-3 py-2.5 text-sm text-gray-900 outline-none transition focus:border-irie-green focus:ring-2 focus:ring-irie-green/20"
        />
      </div>

      {errorMessage ? (
        <p role="alert" className="text-sm text-irie-red">
          {errorMessage}
        </p>
      ) : null}

      <Button type="submit" className="w-full" loading={isSubmitting}>
        Create account
      </Button>

      <p className="text-center text-sm text-gray-600">
        Already have an account?{' '}
        <Link
          href="/login"
          className="font-medium text-irie-green hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-irie-green"
        >
          Sign in
        </Link>
      </p>
    </form>
  );
}
