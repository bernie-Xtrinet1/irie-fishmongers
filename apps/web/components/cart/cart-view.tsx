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
          const itemPending =
            (updateQuantity.isPending &&
              updateQuantity.variables?.itemId === item.id) ||
            (removeItem.isPending && removeItem.variables === item.id);

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
                    {item.unitPrice} per {item.unit}
                  </p>
                  <p className="mt-2 font-medium text-gray-900">
                    Subtotal: {item.subtotal}
                  </p>
                </div>

                <div className="flex items-center gap-3">
                  <label
                    htmlFor={`quantity-${item.id}`}
                    className="text-sm font-medium text-gray-700"
                  >
                    Quantity
                  </label>
                  <input
                    id={`quantity-${item.id}`}
                    type="number"
                    min={1}
                    value={item.quantity}
                    disabled={itemPending}
                    onChange={(event) => {
                      const quantity = Number(event.target.value);

                      if (Number.isInteger(quantity) && quantity >= 1) {
                        updateQuantity.mutate({
                          itemId: item.id,
                          quantity,
                        });
                      }
                    }}
                    className="w-20 rounded-md border border-gray-300 px-3 py-1.5 text-sm"
                  />

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
            <span>{cart.total}</span>
          </div>
          <p className="mt-3 text-sm text-gray-500">
            Checkout will be enabled in a later marketplace phase.
          </p>
        </div>
      </div>
    </main>
  );
}
