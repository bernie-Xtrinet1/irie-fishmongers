'use client';

import { UserRole } from '@iriefishmongers/types';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { getCart } from '@/lib/api/cart';
import {
  formatParish,
  PARISHES,
  type Parish,
  resolveDeliveryZone,
} from '@/lib/api/delivery-zones';
import { useAuth } from '@/lib/auth/auth-context';

const CART_QUERY_KEY = ['cart'] as const;

function formatAmount(value: string): string {
  const amount = Number(value);

  if (!Number.isFinite(amount)) {
    return value;
  }

  return amount.toLocaleString('en-JM', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function isPlausiblePhoneNumber(value: string): boolean {
  const trimmed = value.trim();

  if (!/^\+?[0-9() .-]+$/.test(trimmed)) {
    return false;
  }

  const digits = trimmed.replace(/\D/g, '');

  return digits.length >= 7 && digits.length <= 15;
}

export function CheckoutPreparationView(): React.ReactElement {
  const { status, user } = useAuth();

  const isCustomer =
    status === 'authenticated' &&
    user?.roles.includes(UserRole.CUSTOMER) === true;

  const cartQuery = useQuery({
    queryKey: CART_QUERY_KEY,
    queryFn: getCart,
    enabled: isCustomer,
  });

  const [addressLine1, setAddressLine1] = useState('');
  const [addressLine2, setAddressLine2] = useState('');
  const [parish, setParish] = useState<Parish | ''>('');
  const [phone, setPhone] = useState(user?.phone?.trim() ?? '');
  const phoneInitializedRef = useRef(false);

  useEffect(() => {
    if (!isCustomer || phoneInitializedRef.current) {
      return;
    }

    setPhone(user?.phone?.trim() ?? '');
    phoneInitializedRef.current = true;
  }, [isCustomer, user?.phone]);

  const zoneQuery = useQuery({
    queryKey: ['delivery-zone', parish],
    queryFn: () => resolveDeliveryZone(parish as Parish),
    enabled: isCustomer && parish !== '',
  });

  if (status === 'loading') {
    return (
      <main className="mx-auto max-w-5xl px-4 py-10">
        <p className="text-gray-600">Loading checkout preparation…</p>
      </main>
    );
  }

  if (status === 'unauthenticated') {
    return (
      <main className="mx-auto max-w-5xl px-4 py-10">
        <h1 className="text-3xl font-semibold text-gray-900">
          Delivery details
        </h1>

        <div className="mt-8 rounded-card border border-gray-200 bg-white p-6">
          <p className="text-gray-700">
            Sign in to prepare your delivery details.
          </p>

          <Link
            href="/login?returnUrl=%2Fcheckout"
            className="mt-4 inline-block font-medium text-irie-green hover:underline"
          >
            Sign in
          </Link>
        </div>
      </main>
    );
  }

  if (!isCustomer) {
    return (
      <main className="mx-auto max-w-5xl px-4 py-10">
        <h1 className="text-3xl font-semibold text-gray-900">
          Delivery details
        </h1>

        <div className="mt-8 rounded-card border border-gray-200 bg-white p-6">
          <p className="text-gray-700">
            Checkout preparation is available to customer accounts.
          </p>
        </div>
      </main>
    );
  }

  if (cartQuery.isPending) {
    return (
      <main className="mx-auto max-w-5xl px-4 py-10">
        <h1 className="text-3xl font-semibold text-gray-900">
          Delivery details
        </h1>
        <p className="mt-8 text-gray-600">Loading your cart…</p>
      </main>
    );
  }

  if (cartQuery.isError) {
    return (
      <main className="mx-auto max-w-5xl px-4 py-10">
        <h1 className="text-3xl font-semibold text-gray-900">
          Delivery details
        </h1>

        <div className="mt-8 rounded-card border border-gray-200 bg-white p-6">
          <p className="text-gray-700">
            We could not load your cart for checkout preparation.
          </p>

          <Button
            variant="secondary"
            className="mt-4"
            onClick={() => {
              void cartQuery.refetch();
            }}
          >
            Try again
          </Button>
        </div>
      </main>
    );
  }

  const cart = cartQuery.data;

  if (cart.items.length === 0) {
    return (
      <main className="mx-auto max-w-5xl px-4 py-10">
        <h1 className="text-3xl font-semibold text-gray-900">
          Delivery details
        </h1>

        <div className="mt-8 rounded-card border border-gray-200 bg-white p-6">
          <p className="text-gray-700">
            Add an item to your cart before preparing checkout.
          </p>

          <Link
            href="/"
            className="mt-4 inline-block font-medium text-irie-green hover:underline"
          >
            Continue shopping
          </Link>
        </div>
      </main>
    );
  }

  const addressValid = addressLine1.trim().length >= 3;
  const phoneValid = isPlausiblePhoneNumber(phone);
  const preparationComplete =
    addressValid &&
    parish !== '' &&
    phoneValid &&
    zoneQuery.isSuccess &&
    zoneQuery.data.zoneId !== null;

  return (
    <main className="mx-auto max-w-5xl px-4 py-10">
      <div>
        <h1 className="text-3xl font-semibold text-gray-900">
          Delivery details
        </h1>
        <p className="mt-2 text-gray-600">
          Prepare the delivery information for your marketplace order.
        </p>
      </div>

      <div className="mt-8 grid gap-8 lg:grid-cols-[1fr_22rem]">
        <section
          aria-labelledby="delivery-details-heading"
          className="rounded-card border border-gray-200 bg-white p-6"
        >
          <h2
            id="delivery-details-heading"
            className="text-xl font-semibold text-gray-900"
          >
            Delivery information
          </h2>

          <div className="mt-6 space-y-5">
            <div>
              <label
                htmlFor="delivery-address-line-1"
                className="block text-sm font-medium text-gray-700"
              >
                Address line 1
              </label>
              <input
                id="delivery-address-line-1"
                type="text"
                value={addressLine1}
                onChange={(event) => setAddressLine1(event.target.value)}
                className="mt-2 w-full rounded-md border border-gray-300 px-3 py-2"
                autoComplete="address-line1"
              />
              {addressLine1.length > 0 && !addressValid ? (
                <p className="mt-1 text-sm text-irie-red">
                  Address line 1 must contain at least 3 characters.
                </p>
              ) : null}
            </div>

            <div>
              <label
                htmlFor="delivery-address-line-2"
                className="block text-sm font-medium text-gray-700"
              >
                Address line 2 (optional)
              </label>
              <input
                id="delivery-address-line-2"
                type="text"
                value={addressLine2}
                onChange={(event) => setAddressLine2(event.target.value)}
                className="mt-2 w-full rounded-md border border-gray-300 px-3 py-2"
                autoComplete="address-line2"
              />
            </div>

            <div>
              <label
                htmlFor="delivery-parish"
                className="block text-sm font-medium text-gray-700"
              >
                Parish
              </label>
              <select
                id="delivery-parish"
                value={parish}
                onChange={(event) =>
                  setParish(event.target.value as Parish | '')
                }
                className="mt-2 w-full rounded-md border border-gray-300 px-3 py-2"
              >
                <option value="">Select a parish</option>
                {PARISHES.map((value) => (
                  <option key={value} value={value}>
                    {formatParish(value)}
                  </option>
                ))}
              </select>

              {zoneQuery.isFetching ? (
                <p className="mt-2 text-sm text-gray-500">
                  Checking delivery coverage…
                </p>
              ) : null}

              {zoneQuery.isError ? (
                <p role="alert" className="mt-2 text-sm text-irie-red">
                  We could not check delivery coverage for this parish.
                </p>
              ) : null}

              {zoneQuery.isSuccess && zoneQuery.data.zoneId !== null ? (
                <p className="mt-2 text-sm text-irie-green">
                  Delivery coverage is available for this parish.
                </p>
              ) : null}

              {zoneQuery.isSuccess && zoneQuery.data.zoneId === null ? (
                <p className="mt-2 text-sm text-irie-red">
                  This parish is not currently mapped to a delivery zone.
                </p>
              ) : null}
            </div>

            <div>
              <label
                htmlFor="delivery-phone"
                className="block text-sm font-medium text-gray-700"
              >
                Delivery phone
              </label>
              <input
                id="delivery-phone"
                type="tel"
                value={phone}
                onChange={(event) => setPhone(event.target.value)}
                className="mt-2 w-full rounded-md border border-gray-300 px-3 py-2"
                autoComplete="tel"
              />
              {phone.length > 0 && !phoneValid ? (
                <p className="mt-1 text-sm text-irie-red">
                  Enter a valid delivery phone number.
                </p>
              ) : null}
            </div>
          </div>
        </section>

        <aside className="h-fit rounded-card border border-gray-200 bg-white p-6">
          <h2 className="text-xl font-semibold text-gray-900">
            Order summary
          </h2>

          <div className="mt-5 space-y-4">
            {cart.items.map((item) => (
              <div
                key={item.id}
                className="border-b border-gray-100 pb-4 last:border-b-0"
              >
                <p className="font-medium text-gray-900">
                  {item.productName}
                </p>
                <p className="mt-1 text-sm text-gray-500">
                  Quantity {item.quantity}
                </p>
                <p className="mt-1 text-sm text-gray-700">
                  {formatAmount(item.subtotal)}
                </p>
              </div>
            ))}
          </div>

          <div className="mt-5 flex items-center justify-between border-t border-gray-200 pt-5 text-lg font-semibold text-gray-900">
            <span>Total</span>
            <span>{formatAmount(cart.total)}</span>
          </div>

          <div className="mt-6 rounded-md bg-gray-50 p-4">
            <p className="text-sm text-gray-600">
              Order placement and payment are not enabled in this preparation
              stage. Your cart will not be submitted from this page.
            </p>
          </div>

          <Button
            type="button"
            className="mt-5 w-full"
            disabled
            aria-disabled="true"
          >
            {preparationComplete
              ? 'Order placement coming later'
              : 'Complete delivery details'}
          </Button>

          <Link
            href="/cart"
            className="mt-4 block text-center text-sm font-medium text-irie-green hover:underline"
          >
            Return to cart
          </Link>
        </aside>
      </div>
    </main>
  );
}
