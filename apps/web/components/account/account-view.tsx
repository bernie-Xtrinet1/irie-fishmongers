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
      <dd className="mt-1 break-all text-base text-gray-900 sm:break-normal">{value}</dd>
    </div>
  );
}

export function AccountView(): React.ReactElement {
  const { status, user } = useAuth();

  const isCustomer =
    status === 'authenticated' &&
    user?.roles.includes(UserRole.CUSTOMER) === true;
  const isVendor =
    status === 'authenticated' &&
    user?.roles.includes(UserRole.VENDOR) === true;
  const isDriver =
    status === 'authenticated' &&
    user?.roles.includes(UserRole.DRIVER) === true;

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

  if ((!isCustomer && !isVendor && !isDriver) || !user) {
    return (
      <main className="mx-auto max-w-5xl px-4 py-10">
        <h1 className="text-3xl font-semibold text-gray-900">Your account</h1>
        <div className="mt-8 rounded-card border border-gray-200 bg-white p-6">
          <p className="text-gray-700">
            This account page is available to customer, vendor, and driver accounts.
          </p>
        </div>
      </main>
    );
  }

  const displayName =
    `${user.firstName} ${user.lastName}`.trim() || user.email;
  const accountTypeLabel = [
    isCustomer ? 'Customer' : null,
    isVendor ? 'Vendor' : null,
    isDriver ? 'Driver' : null,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <main className="mx-auto max-w-5xl px-4 py-10">
      <div>
        <h1 className="text-3xl font-semibold text-gray-900">Your account</h1>
        <p className="mt-2 text-gray-600">
          Review the account information associated with your marketplace profile.
        </p>
      </div>

      {isVendor ? (
        <section
          aria-labelledby="vendor-workspace-heading"
          className="mt-8 rounded-card border border-irie-green/25 bg-irie-green/5 p-6"
        >
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2
                id="vendor-workspace-heading"
                className="text-xl font-semibold text-gray-900"
              >
                Vendor workspace
              </h2>
              <p className="mt-1 text-sm text-gray-600">
                Manage standard seafood products or publish daily Catch of the Day listings from verified lots.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <Link
                href="/vendor/products"
                className="inline-flex h-11 shrink-0 items-center justify-center rounded-button border border-irie-green bg-white px-5 text-sm font-medium text-irie-green transition-colors hover:bg-irie-green/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-irie-green focus-visible:ring-offset-2"
              >
                My Products
              </Link>
              <Link
                href="/vendor/daily-listings"
                className="inline-flex h-11 shrink-0 items-center justify-center rounded-button bg-irie-green px-5 text-sm font-medium text-white transition-colors hover:bg-irie-green/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-irie-green focus-visible:ring-offset-2"
              >
                Catch of the Day
              </Link>
            </div>
          </div>
        </section>
      ) : null}

      {isDriver ? (
        <section
          aria-labelledby="driver-workspace-heading"
          className="mt-8 rounded-card border border-ocean-blue/25 bg-ocean-blue/5 p-6"
        >
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2
                id="driver-workspace-heading"
                className="text-xl font-semibold text-gray-900"
              >
                Driver workspace
              </h2>
              <p className="mt-1 text-sm text-gray-600">
                Manage your availability, claim ready pickups, schedule delivery windows, and update delivery progress.
              </p>
            </div>
            <Link
              href="/driver/deliveries"
              className="inline-flex h-11 shrink-0 items-center justify-center rounded-button bg-ocean-blue px-5 text-sm font-medium text-white transition-colors hover:bg-ocean-blue/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ocean-blue focus-visible:ring-offset-2"
            >
              My Deliveries
            </Link>
          </div>
        </section>
      ) : null}

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
          <AccountDetail label="Account type" value={accountTypeLabel} />
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
