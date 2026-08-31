import { apiDelete, apiGet, apiPatch, apiPost } from '../api-client';

export interface AddCartItemInput {
  productId: string;
  quantity: number;
}

export interface CartItemResponse {
  id: string;
  productId: string;
  productName: string;
  vendorId: string;
  unitPrice: string;
  unit: string;
  quantity: number;
  subtotal: string;
}

export interface CartResponse {
  id: string;
  items: CartItemResponse[];
  total: string;
}

function createIdempotencyKey(): string {
  if (typeof crypto === 'undefined' || typeof crypto.randomUUID !== 'function') {
    throw new Error('Secure UUID generation is not available in this browser.');
  }

  return crypto.randomUUID();
}

export function getCart(): Promise<CartResponse> {
  return apiGet<CartResponse>('/cart');
}

export function addCartItem(input: AddCartItemInput): Promise<CartResponse> {
  return apiPost<CartResponse>('/cart/items', input, {
    headers: {
      'Idempotency-Key': createIdempotencyKey(),
    },
  });
}

export function updateCartItemQuantity(
  itemId: string,
  quantity: number,
): Promise<CartResponse> {
  return apiPatch<CartResponse>(`/cart/items/${itemId}`, { quantity });
}

export function removeCartItem(itemId: string): Promise<CartResponse> {
  return apiDelete<CartResponse>(`/cart/items/${itemId}`);
}
