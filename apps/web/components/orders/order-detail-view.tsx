'use client';

import { UserRole } from '@iriefishmongers/types';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';

import { ApiError } from '@/lib/api-client';
import {
  getCustomerOrder,
  type OrderResponse,
} from '@/lib/api/orders';
import { useAuth } from '@/lib/auth/auth-context';
import { Button } from '@/components/ui/button';

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

function formatEnum(value: string): string {
  return value
    .toLowerCase()
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function formatUnit(value: string): string {
  const normalized = value.toLowerCase();

  if (normalized.startsWith('per_')) {
    return normalized.slice(4).replaceAll('_', ' ');
  }

  return normalized.replaceAll('_', ' ');
}

function formatOrderDate(value: string): string {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleDateString('en-JM', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

function getOrderTotal(order: OrderResponse): string {
  const total = order.vendorOrders.reduce((sum, vendorOrder) => {
    const subtotal = Number(vendorOrder.subtotal);
    return Number.isFinite(subtotal) ? sum + subtotal : sum;
  }, 0);

  return total.toLocaleString('en-JM', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function getReturnUrl(orderId: string): string {
  return `/orders/${encodeURIComponent(orderId)}`;
}

export function OrderDetailView({
  orderId,
}: {
  orderId: string;
}): React.ReactElement {
  const { status, user } = useAuth();

  const isCustomer =
    status === 'authenticated' &&
    user?.roles.includes(UserRole.CUSTOMER) === true;

  const orderQuery = useQuery({
    queryKey: ['orders', orderId],
    queryFn: () => getCustomerOrder(orderId),
    enabled: isCustomer,
  });

  if (status === 'loading') {
    return (
      <main className="mx-auto max-w-5xl px-4 py-10">
        <p className="text-gray-600">Loading your account…</p>
      </main>
    );
  }

  if (status === 'unauthenticated') {
    const returnUrl = getReturnUrl(orderId);

    return (
      <main className="mx-auto max-w-5xl px-4 py-10">
        <h1 className="text-3xl font-semibold text-gray-900">Order details</h1>

        <div className="mt-8 rounded-card border border-gray-200 bg-white p-6">
          <p className="text-gray-700">Sign in to view this order.</p>

          <Link
            href={`/login?returnUrl=${encodeURIComponent(returnUrl)}`}
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
        <h1 className="text-3xl font-semibold text-gray-900">Order details</h1>

        <div className="mt-8 rounded-card border border-gray-200 bg-white p-6">
          <p className="text-gray-700">
            Order details are available to customer accounts.
          </p>
        </div>
      </main>
    );
  }

  if (orderQuery.isPending) {
    return (
      <main className="mx-auto max-w-5xl px-4 py-10">
        <p className="text-gray-600">Loading your order…</p>
      </main>
    );
  }

  if (orderQuery.isError) {
    const notFound =
      orderQuery.error instanceof ApiError && orderQuery.error.status === 404;

    return (
      <main className="mx-auto max-w-5xl px-4 py-10">
        <h1 className="text-3xl font-semibold text-gray-900">Order details</h1>

        <div className="mt-8 rounded-card border border-gray-200 bg-white p-6">
          <p className="text-gray-700">
            {notFound
              ? 'Order not found.'
              : 'We could not load this order.'}
          </p>

          {!notFound ? (
            <Button
              variant="secondary"
              className="mt-4"
              onClick={() => {
                void orderQuery.refetch();
              }}
            >
              Try again
            </Button>
          ) : null}

          <Link
            href="/orders"
            className="mt-4 block font-medium text-irie-green hover:underline"
          >
            Back to your orders
          </Link>
        </div>
      </main>
    );
  }

  const order = orderQuery.data;

  return (
    <main className="mx-auto max-w-5xl px-4 py-10">
      <Link
        href="/orders"
        className="text-sm font-medium text-irie-green hover:underline"
      >
        ← Back to your orders
      </Link>

      <div className="mt-5 flex flex-col justify-between gap-4 sm:flex-row">
        <div>
          <h1 className="text-3xl font-semibold text-gray-900">
            Order {order.id}
          </h1>
          <p className="mt-2 text-sm text-gray-500">
            Placed {formatOrderDate(order.createdAt)}
          </p>
        </div>

        <div className="sm:text-right">
          <p className="text-sm text-gray-500">Order total</p>
          <p className="text-2xl font-semibold text-gray-900">
            {getOrderTotal(order)}
          </p>
        </div>
      </div>

      <section className="mt-8 rounded-card border border-gray-200 bg-white p-6">
        <h2 className="text-lg font-semibold text-gray-900">
          Delivery information
        </h2>

        <dl className="mt-4 grid gap-4 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-gray-500">Address</dt>
            <dd className="mt-1 text-gray-900">
              {order.deliveryAddressLine1}
              {order.deliveryAddressLine2
                ? `, ${order.deliveryAddressLine2}`
                : ''}
            </dd>
          </div>

          <div>
            <dt className="text-gray-500">Parish</dt>
            <dd className="mt-1 text-gray-900">
              {formatEnum(order.deliveryParish)}
            </dd>
          </div>

          <div>
            <dt className="text-gray-500">Phone</dt>
            <dd className="mt-1 text-gray-900">{order.deliveryPhone}</dd>
          </div>
        </dl>
      </section>

      <section className="mt-8">
        <h2 className="text-xl font-semibold text-gray-900">Order items</h2>

        <div className="mt-4 space-y-5">
          {order.vendorOrders.map((vendorOrder) => (
            <article
              key={vendorOrder.id}
              className="rounded-card border border-gray-200 bg-white p-6"
            >
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="text-sm text-gray-500">Status</p>
                  <p className="font-medium text-gray-900">
                    {formatEnum(vendorOrder.status)}
                  </p>
                </div>

                <div className="text-right">
                  <p className="text-sm text-gray-500">Vendor subtotal</p>
                  <p className="font-semibold text-gray-900">
                    {formatAmount(vendorOrder.subtotal)}
                  </p>
                </div>
              </div>

              <div className="mt-5 divide-y divide-gray-100 border-t border-gray-100">
                {vendorOrder.items.map((item) => (
                  <div
                    key={item.id}
                    className="flex flex-col justify-between gap-3 py-4 sm:flex-row"
                  >
                    <div>
                      <p className="font-medium text-gray-900">
                        {item.productName}
                      </p>
                      <p className="mt-1 text-sm text-gray-500">
                        Quantity: {item.quantity}
                      </p>
                      <p className="mt-1 text-sm text-gray-500">
                        Unit price: {formatAmount(item.unitPrice)} per{' '}
                        {formatUnit(item.unit)}
                      </p>
                    </div>

                    <div className="sm:text-right">
                      <p className="text-sm text-gray-500">Subtotal</p>
                      <p className="font-medium text-gray-900">
                        {formatAmount(item.subtotal)}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            </article>
          ))}
        </div>
      </section>
    </main>
  );
}
