'use client';

import Image from 'next/image';
import Link from 'next/link';

import { UserRole } from '@iriefishmongers/types';

import { useAuth } from '@/lib/auth/auth-context';

export function MarketplaceHeader(): React.ReactElement {
  const { status, user, logout } = useAuth();

  const isCustomer = user?.roles.includes(UserRole.CUSTOMER) ?? false;
  const isVendor = user?.roles.includes(UserRole.VENDOR) ?? false;
  const isDriver = user?.roles.includes(UserRole.DRIVER) ?? false;
  const displayName = user ? `${user.firstName} ${user.lastName}`.trim() || user.email : '';

  return (
    <header className="border-b border-gray-200 bg-white">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-4 py-4">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
          <Link
            href="/"
            className="text-xl font-semibold text-gray-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-irie-green"
          >
            <span className="inline-flex items-center gap-2">
              <Image src="/irie-fishmongers-logo.webp" alt="" width={56} height={40} />
              <span>Irie Fishmongers</span>
            </span>
          </Link>

          <nav
            aria-label="Marketplace navigation"
            className="flex flex-wrap items-center gap-x-4 gap-y-1"
          >
            <Link
              href="/"
              className="text-sm font-medium text-gray-700 hover:text-irie-green focus:outline-none focus-visible:ring-2 focus-visible:ring-irie-green"
            >
              Marketplace
            </Link>

            <Link
              href="/platform"
              className="text-sm font-medium text-gray-700 hover:text-irie-green"
            >
              Platform access
            </Link>

            {status === 'unauthenticated' || (status === 'authenticated' && isCustomer) ? (
              <Link
                href="/cart"
                className="text-sm font-medium text-gray-700 hover:text-irie-green focus:outline-none focus-visible:ring-2 focus-visible:ring-irie-green"
              >
                Cart
              </Link>
            ) : null}

            {status === 'authenticated' && isCustomer ? (
              <Link
                href="/orders"
                className="text-sm font-medium text-gray-700 hover:text-irie-green focus:outline-none focus-visible:ring-2 focus-visible:ring-irie-green"
              >
                Orders
              </Link>
            ) : null}

            {status === 'authenticated' && (isCustomer || isVendor || isDriver) ? (
              <Link
                href="/account"
                className="text-sm font-medium text-gray-700 hover:text-irie-green focus:outline-none focus-visible:ring-2 focus-visible:ring-irie-green"
              >
                Account
              </Link>
            ) : null}
          </nav>
        </div>

        <div className="flex items-center gap-3">
          {status === 'loading' ? (
            <span className="text-sm text-gray-500" aria-live="polite">
              Loading account…
            </span>
          ) : status === 'authenticated' && user ? (
            <>
              <div className="hidden text-right sm:block">
                <p className="text-sm font-medium text-gray-900">{displayName}</p>
                <p className="text-xs text-gray-500">{user.email}</p>
              </div>

              <button
                type="button"
                onClick={() => {
                  void logout();
                }}
                className="inline-flex h-9 items-center justify-center rounded-button border border-irie-green bg-white px-4 text-sm font-medium text-irie-green transition-colors hover:bg-irie-green/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-irie-green focus-visible:ring-offset-2"
              >
                Sign Out
              </button>
            </>
          ) : (
            <>
              <Link
                href="/login"
                className="inline-flex h-9 items-center justify-center rounded-button border border-irie-green bg-white px-4 text-sm font-medium text-irie-green transition-colors hover:bg-irie-green/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-irie-green focus-visible:ring-offset-2"
              >
                Sign In
              </Link>

              <Link
                href="/register"
                className="inline-flex h-9 items-center justify-center rounded-button bg-irie-green px-4 text-sm font-medium text-white transition-colors hover:bg-irie-green/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-irie-green focus-visible:ring-offset-2"
              >
                Register
              </Link>
            </>
          )}
        </div>
      </div>
    </header>
  );
}
