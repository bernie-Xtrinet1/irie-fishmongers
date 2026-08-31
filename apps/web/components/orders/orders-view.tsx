'use client';

import { UserRole } from '@iriefishmongers/types';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import {
  getCustomerOrders,
  type OrderResponse,
} from '@/lib/api/orders';
import { useAuth } from '@/lib/auth/auth-context';

const PAGE_SIZE = 20;

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

function formatStatus(value: string): string {
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

export function OrdersView(): React.ReactElement {
  const { status, user } = useAuth();
  const [page, setPage] = useState(1);

  const isCustomer =
    status === 'authenticated' &&
    user?.roles.includes(UserRole.CUSTOMER) === true;

  const ordersQuery = useQuery({
    queryKey: ['orders', page, PAGE_SIZE],
    queryFn: () => getCustomerOrders(page, PAGE_SIZE),
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
    return (
      <main className="mx-auto max-w-5xl px-4 py-10">
        <h1 className="text-3xl font-semibold text-gray-900">Your orders</h1>
        <div className="mt-8 rounded-card border border-gray-200 bg-white p-6">
          <p className="text-gray-700">Sign in to view your order history.</p>
          <Link
            href="/login?returnUrl=%2Forders"
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
        <h1 className="text-3xl font-semibold text-gray-900">Your orders</h1>
        <div className="mt-8 rounded-card border border-gray-200 bg-white p-6">
          <p className="text-gray-700">
            Order history is available to customer accounts.
          </p>
        </div>
      </main>
    );
  }

  if (ordersQuery.isPending) {
    return (
      <main className="mx-auto max-w-5xl px-4 py-10">
        <h1 className="text-3xl font-semibold text-gray-900">Your orders</h1>
        <p className="mt-8 text-gray-600">Loading your orders…</p>
      </main>
    );
  }

  if (ordersQuery.isError) {
    return (
      <main className="mx-auto max-w-5xl px-4 py-10">
        <h1 className="text-3xl font-semibold text-gray-900">Your orders</h1>
        <div className="mt-8 rounded-card border border-gray-200 bg-white p-6">
          <p className="text-gray-700">We could not load your orders.</p>
          <Button
            variant="secondary"
            className="mt-4"
            onClick={() => {
              void ordersQuery.refetch();
            }}
          >
            Try again
          </Button>
        </div>
      </main>
    );
  }

  const orders = ordersQuery.data;

  if (orders.items.length === 0) {
    return (
      <main className="mx-auto max-w-5xl px-4 py-10">
        <h1 className="text-3xl font-semibold text-gray-900">Your orders</h1>
        <div className="mt-8 rounded-card border border-gray-200 bg-white p-6">
          <p className="text-gray-700">You have not placed any orders yet.</p>
          <Link
            href="/"
            className="mt-4 inline-block font-medium text-irie-green hover:underline"
          >
            Browse the marketplace
          </Link>
        </div>
      </main>
    );
  }

  const firstOrderNumber = (orders.page - 1) * orders.pageSize + 1;
  const lastOrderNumber = Math.min(
    firstOrderNumber + orders.items.length - 1,
    orders.total,
  );
  const hasPreviousPage = orders.page > 1;
  const hasNextPage = orders.page * orders.pageSize < orders.total;

  return (
    <main className="mx-auto max-w-5xl px-4 py-10">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold text-gray-900">Your orders</h1>
          <p className="mt-2 text-sm text-gray-600">
            Showing {firstOrderNumber}–{lastOrderNumber} of {orders.total}
          </p>
        </div>
      </div>

      <div className="mt-8 space-y-4">
        {orders.items.map((order) => (
          <article
            key={order.id}
            className="rounded-card border border-gray-200 bg-white p-5"
          >
            <div className="flex flex-col justify-between gap-4 sm:flex-row">
              <div>
                <p className="text-sm text-gray-500">
                  Order placed {formatOrderDate(order.createdAt)}
                </p>

                <Link
                  href={`/orders/${order.id}`}
                  className="mt-1 inline-block font-semibold text-gray-900 hover:text-irie-green"
                >
                  Order {order.id}
                </Link>
              </div>

              <div className="sm:text-right">
                <p className="text-sm text-gray-500">Order total</p>
                <p className="font-semibold text-gray-900">
                  {getOrderTotal(order)}
                </p>
              </div>
            </div>

            <div className="mt-5 space-y-4 border-t border-gray-100 pt-4">
              {order.vendorOrders.map((vendorOrder) => (
                <div key={vendorOrder.id}>
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <p className="text-sm font-medium text-gray-900">
                      {formatStatus(vendorOrder.status)}
                    </p>

                    <p className="text-sm font-medium text-gray-700">
                      Subtotal: {formatAmount(vendorOrder.subtotal)}
                    </p>
                  </div>

                  <ul className="mt-2 space-y-1 text-sm text-gray-600">
                    {vendorOrder.items.map((item) => (
                      <li key={item.id}>
                        {item.productName} — {item.quantity} ×{' '}
                        {formatAmount(item.unitPrice)} per {formatUnit(item.unit)}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </article>
        ))}
      </div>

      <div className="mt-8 flex items-center justify-between">
        <Button
          variant="secondary"
          disabled={!hasPreviousPage || ordersQuery.isFetching}
          onClick={() => {
            setPage((currentPage) => Math.max(1, currentPage - 1));
          }}
        >
          Previous
        </Button>

        <span className="text-sm text-gray-600">Page {orders.page}</span>

        <Button
          variant="secondary"
          disabled={!hasNextPage || ordersQuery.isFetching}
          onClick={() => {
            setPage((currentPage) => currentPage + 1);
          }}
        >
          Next
        </Button>
      </div>
    </main>
  );
}
