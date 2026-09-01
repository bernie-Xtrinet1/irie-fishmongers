'use client';

import { UserRole } from '@iriefishmongers/types';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';

import { Button } from '@/components/ui/button';
import {
  type CartResponse,
  getCart,
  removeCartItem,
  updateCartItemQuantity,
} from '@/lib/api/cart';
import { useAuth } from '@/lib/auth/auth-context';

const CART_QUERY_KEY = ['cart'] as const;

function formatCartAmount(value: string): string {
  const amount = Number(value);

  if (!Number.isFinite(amount)) {
    return value;
  }

  return amount.toLocaleString('en-JM', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export function CartView(): React.ReactElement {
  const { status, user } = useAuth();
  const queryClient = useQueryClient();

  const isCustomer =
    status === 'authenticated' &&
    user?.roles.includes(UserRole.CUSTOMER) === true;

  const cartQuery = useQuery({
    queryKey: CART_QUERY_KEY,
    queryFn: getCart,
    enabled: isCustomer,
  });

  const updateQuantity = useMutation({
    mutationFn: ({
      itemId,
      quantity,
    }: {
      itemId: string;
      quantity: number;
    }) => updateCartItemQuantity(itemId, quantity),
    onSuccess: (cart) => {
      queryClient.setQueryData<CartResponse>(CART_QUERY_KEY, cart);
    },
  });

  const removeItem = useMutation({
    mutationFn: removeCartItem,
    onSuccess: (cart) => {
      queryClient.setQueryData<CartResponse>(CART_QUERY_KEY, cart);
    },
  });

  function changeQuantity(itemId: string, quantity: number): void {
    if (!Number.isInteger(quantity) || quantity < 1) {
      return;
    }

    updateQuantity.mutate({
      itemId,
      quantity,
    });
  }

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
        <h1 className="text-3xl font-semibold text-gray-900">Your cart</h1>
        <div className="mt-8 rounded-card border border-gray-200 bg-white p-6">
          <p className="text-gray-700">Sign in to view and manage your cart.</p>
          <Link
            href="/login?returnUrl=%2Fcart"
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
        <h1 className="text-3xl font-semibold text-gray-900">Your cart</h1>
        <div className="mt-8 rounded-card border border-gray-200 bg-white p-6">
          <p className="text-gray-700">
            Shopping carts are available to customer accounts.
          </p>
        </div>
      </main>
    );
  }

  if (cartQuery.isPending) {
    return (
      <main className="mx-auto max-w-5xl px-4 py-10">
        <h1 className="text-3xl font-semibold text-gray-900">Your cart</h1>
        <p className="mt-8 text-gray-600">Loading your cart…</p>
      </main>
    );
  }

  if (cartQuery.isError) {
    return (
      <main className="mx-auto max-w-5xl px-4 py-10">
        <h1 className="text-3xl font-semibold text-gray-900">Your cart</h1>
        <div className="mt-8 rounded-card border border-gray-200 bg-white p-6">
          <p className="text-gray-700">We could not load your cart.</p>
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
        <h1 className="text-3xl font-semibold text-gray-900">Your cart</h1>
        <div className="mt-8 rounded-card border border-gray-200 bg-white p-6">
          <p className="text-gray-700">Your cart is empty.</p>
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

  const mutationError = updateQuantity.isError || removeItem.isError;

  return (
    <main className="mx-auto max-w-5xl px-4 py-10">
      <h1 className="text-3xl font-semibold text-gray-900">Your cart</h1>

      {mutationError ? (
        <p role="alert" className="mt-4 text-sm text-irie-red">
          We could not update your cart. Please try again.
        </p>
      ) : null}

      <div className="mt-8 space-y-4">
        {cart.items.map((item) => {
          const updating =
            updateQuantity.isPending &&
            updateQuantity.variables?.itemId === item.id;

          const removing =
            removeItem.isPending &&
            removeItem.variables === item.id;

          const itemPending = updating || removing;

          return (
            <article
              key={item.id}
              className="rounded-card border border-gray-200 bg-white p-5"
            >
              <div className="flex flex-col justify-between gap-4 sm:flex-row">
                <div>
                  <Link
                    href={`/products/${item.productId}`}
                    className="font-semibold text-gray-900 hover:text-irie-green"
                  >
                    {item.productName}
                  </Link>

                  <p className="mt-1 text-sm text-gray-500">
                    {formatCartAmount(item.unitPrice)} per {item.unit}
                  </p>

                  <p className="mt-2 font-medium text-gray-900">
                    Subtotal: {formatCartAmount(item.subtotal)}
                  </p>

                  {itemPending ? (
                    <p
                      className="mt-2 text-sm text-gray-500"
                      aria-live="polite"
                    >
                      {removing ? 'Removing…' : 'Updating…'}
                    </p>
                  ) : null}
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium text-gray-700">
                    Quantity
                  </span>

                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    aria-label={`Decrease quantity of ${item.productName}`}
                    disabled={itemPending || item.quantity <= 1}
                    onClick={() => {
                      changeQuantity(item.id, item.quantity - 1);
                    }}
                  >
                    −
                  </Button>

                  <input
                    id={`quantity-${item.id}`}
                    aria-label={`Quantity of ${item.productName}`}
                    type="number"
                    min={1}
                    value={item.quantity}
                    disabled={itemPending}
                    onChange={(event) => {
                      changeQuantity(item.id, Number(event.target.value));
                    }}
                    className="w-20 rounded-md border border-gray-300 px-3 py-1.5 text-center text-sm"
                  />

                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    aria-label={`Increase quantity of ${item.productName}`}
                    disabled={itemPending}
                    onClick={() => {
                      changeQuantity(item.id, item.quantity + 1);
                    }}
                  >
                    +
                  </Button>

                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={itemPending}
                    onClick={() => removeItem.mutate(item.id)}
                  >
                    Remove
                  </Button>
                </div>
              </div>
            </article>
          );
        })}
      </div>

      <div className="mt-8 flex justify-end">
        <div className="w-full rounded-card border border-gray-200 bg-white p-5 sm:w-80">
          <div className="flex items-center justify-between text-lg font-semibold text-gray-900">
            <span>Total</span>
            <span>{formatCartAmount(cart.total)}</span>
          </div>

          <Link
            href="/checkout"
            className="mt-5 block rounded-md bg-irie-green px-4 py-2 text-center font-medium text-white hover:opacity-90"
          >
            Proceed to checkout
          </Link>

          <p className="mt-3 text-sm text-gray-500">
            You can prepare your delivery details before order placement and
            payment are enabled.
          </p>
        </div>
      </div>
    </main>
  );
}
