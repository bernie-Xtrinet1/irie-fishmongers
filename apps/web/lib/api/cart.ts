import { apiPost } from '../api-client';

export interface AddCartItemInput {
  productId: string;
  quantity: number;
}

export interface CartItemResponse {
  id: string;
  cartId: string;
  productId: string;
  quantity: number;
}

// Calls the existing, unmodified POST /cart/items endpoint (CUSTOMER role,
// JWT-protected). This app has no authentication flow yet, so an
// unauthenticated call genuinely returns 401 - callers should surface that
// as "please sign in", not silently succeed.
export function addCartItem(input: AddCartItemInput): Promise<CartItemResponse> {
  return apiPost<CartItemResponse>('/cart/items', input);
}
