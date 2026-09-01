'use client';

import { UserRole } from '@iriefishmongers/types';
import Link from 'next/link';

import { useAuth } from '@/lib/auth/auth-context';

function formatStatus(value: string): string {
  return value
    .toLowerCase()
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function formatMemberSince(value: string): string {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleDateString('en-JM', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

function AccountDetail({
  label,
  value,
}: {
  label: string;
  value: string;
}): React.ReactElement {
  return (
    <div className="border-b border-gray-100 py-4 last:border-b-0">
      <dt className="text-sm font-medium text-gray-500">{label}</dt>
      <dd className="mt-1 text-base text-gray-900">{value}</dd>
    </div>
  );
}

export function AccountView(): React.ReactElement {
  const { status, user } = useAuth();

  const isCustomer =
    status === 'authenticated' &&
    user?.roles.includes(UserRole.CUSTOMER) === true;

  if (status === 'loading') {
    return (
      <main className="mx-auto max-w-5xl px-4 py-10">
        <p className="text-gray-600">Loading your account…</p>
      </main>
    );
  }

  if (status === 'unauthenticated') {
    return (
      <main className="mx-auto max-w-5xl px-4 py-10">
        <h1 className="text-3xl font-semibold text-gray-900">Your account</h1>
        <div className="mt-8 rounded-card border border-gray-200 bg-white p-6">
          <p className="text-gray-700">Sign in to view your account.</p>
          <Link
            href="/login?returnUrl=%2Faccount"
            className="mt-4 inline-block font-medium text-irie-green hover:underline"
          >
            Sign in
          </Link>
        </div>
      </main>
    );
  }

  if (!isCustomer || !user) {
    return (
      <main className="mx-auto max-w-5xl px-4 py-10">
        <h1 className="text-3xl font-semibold text-gray-900">Your account</h1>
        <div className="mt-8 rounded-card border border-gray-200 bg-white p-6">
          <p className="text-gray-700">
            This account page is available to customer accounts.
          </p>
        </div>
      </main>
    );
  }

  const displayName =
    `${user.firstName} ${user.lastName}`.trim() || user.email;

  return (
    <main className="mx-auto max-w-5xl px-4 py-10">
      <div>
        <h1 className="text-3xl font-semibold text-gray-900">Your account</h1>
        <p className="mt-2 text-gray-600">
          Review the account information associated with your marketplace profile.
        </p>
      </div>

      <section
        aria-labelledby="account-details-heading"
        className="mt-8 rounded-card border border-gray-200 bg-white p-6"
      >
        <h2
          id="account-details-heading"
          className="text-xl font-semibold text-gray-900"
        >
          Account details
        </h2>

        <dl className="mt-4">
          <AccountDetail label="Name" value={displayName} />
          <AccountDetail label="Email" value={user.email} />
          <AccountDetail label="Phone" value={user.phone?.trim() || 'Not provided'} />
          <AccountDetail label="Account type" value="Customer" />
          <AccountDetail label="Account status" value={formatStatus(user.status)} />
          <AccountDetail
            label="Member since"
            value={formatMemberSince(user.createdAt)}
          />
        </dl>
      </section>

      <p className="mt-6 text-sm text-gray-500">
        Account information is currently read-only.
      </p>
    </main>
  );
}
