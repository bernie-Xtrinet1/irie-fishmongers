'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { ApiError } from '@/lib/api-client';
import { useAuth } from '@/lib/auth/auth-context';

function loginErrorMessage(error: unknown): string {
  if (error instanceof ApiError && error.status === 401) {
    return 'Email or password is incorrect.';
  }

  return 'We could not sign you in. Please try again.';
}

export function LoginForm(): React.ReactElement {
  const router = useRouter();
  const { login } = useAuth();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();

    setErrorMessage(null);
    setIsSubmitting(true);

    try {
      await login(email.trim(), password);
      router.push('/');
    } catch (error) {
      setErrorMessage(loginErrorMessage(error));
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
        <label htmlFor="password" className="block text-sm font-medium text-gray-700">
          Password
        </label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          className="mt-1 block w-full rounded-md border border-gray-300 bg-white px-3 py-2.5 text-sm text-gray-900 outline-none transition focus:border-irie-green focus:ring-2 focus:ring-irie-green/20"
        />
      </div>

      {errorMessage ? (
        <p role="alert" className="text-sm text-irie-red">
          {errorMessage}
        </p>
      ) : null}

      <Button type="submit" className="w-full" loading={isSubmitting}>
        Sign in
      </Button>

      <p className="text-center text-sm text-gray-600">
        New to Irie Fishmongers?{' '}
        <Link
          href="/register"
          className="font-medium text-irie-green hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-irie-green"
        >
          Create an account
        </Link>
      </p>
    </form>
  );
}
