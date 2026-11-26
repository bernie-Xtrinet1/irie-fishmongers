import type { Metadata } from 'next';
import Link from 'next/link';

import { MarketplaceShell } from '@/components/marketplace/marketplace-shell';

export const metadata: Metadata = {
  title: 'Platform access | Irie Fishmongers',
  alternates: { canonical: '/platform' },
};

const marketplaceRoles = [
  {
    title: 'Shoppers',
    description:
      'Browse Jamaican seafood, shop Available Today, and sign in to manage your orders.',
    href: '/',
    action: 'Browse the marketplace',
  },
  {
    title: 'Vendors',
    description:
      'Apply to sell seafood. Approved vendors can manage their Catch of the Day listings.',
    href: '/login?returnUrl=%2Fvendor%2Fdaily-listings',
    action: 'Vendor sign in',
  },
  {
    title: 'Drivers',
    description:
      'Apply to deliver. Approved drivers can go online, claim pickups, and update deliveries.',
    href: '/login?returnUrl=%2Fdriver%2Fdeliveries',
    action: 'Driver sign in',
  },
];

export const dynamic = 'force-dynamic';

export default function PlatformAccessPage(): React.ReactElement {
  const configuredUrl = process.env.IRIE_OPERATIONS_PORTAL_URL;
  const operationsPortalUrl = configuredUrl?.startsWith('https://') ? configuredUrl : undefined;

  return (
    <MarketplaceShell>
      <main className="mx-auto max-w-6xl px-4 py-10 sm:py-16">
        <h1 className="text-3xl font-semibold text-gray-900 sm:text-4xl">Platform access</h1>
        <div className="mt-6 flex flex-wrap gap-4">
          <Link href="/login?returnUrl=%2Faccount" className="font-medium text-gray-900 underline">
            Sign in
          </Link>
          <Link href="/register" className="font-medium text-gray-900 underline">
            Create an account
          </Link>
        </div>

        <div className="mt-8 grid gap-5 sm:grid-cols-2">
          {marketplaceRoles.map(({ title, description, href, action }) => (
            <section key={title} className="rounded-2xl border border-gray-200 bg-white p-6">
              <h2 className="text-xl font-semibold text-gray-900">{title}</h2>
              <p className="mt-2 text-sm leading-6 text-gray-600">{description}</p>
              <Link href={href} className="mt-4 inline-block font-medium text-gray-900 underline">
                {action}
              </Link>
            </section>
          ))}
          <section className="rounded-2xl border border-gray-200 bg-white p-6">
            <h2 className="text-xl font-semibold text-gray-900">Staff &amp; administrators</h2>
            <p className="mt-2 text-sm leading-6 text-gray-600">
              Use your assigned operations account and approved network to access the staff portal.
            </p>
            {operationsPortalUrl ? (
              <a
                href={operationsPortalUrl}
                className="mt-4 inline-block font-medium text-gray-900 underline"
              >
                Open the staff portal
              </a>
            ) : (
              <p className="mt-4 text-sm text-gray-600">
                Contact your administrator for your staff portal link.
              </p>
            )}
          </section>
        </div>
      </main>
    </MarketplaceShell>
  );
}
