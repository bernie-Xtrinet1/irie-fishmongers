import { apiDelete, apiGet, apiPatch, apiPost } from '../api-client';
import {
  addCartItem,
  getCart,
  removeCartItem,
  updateCartItemQuantity,
  type CartResponse,
} from './cart';

jest.mock('../api-client', () => ({
  apiDelete: jest.fn(),
  apiGet: jest.fn(),
  apiPatch: jest.fn(),
  apiPost: jest.fn(),
}));

const mockApiDelete = apiDelete as jest.MockedFunction<typeof apiDelete>;
const mockApiGet = apiGet as jest.MockedFunction<typeof apiGet>;
const mockApiPatch = apiPatch as jest.MockedFunction<typeof apiPatch>;
const mockApiPost = apiPost as jest.MockedFunction<typeof apiPost>;

const cart: CartResponse = {
  id: 'cart-1',
  items: [
    {
      id: 'item-1',
      productId: 'product-1',
      productName: 'Fresh Red Snapper',
      vendorId: 'vendor-1',
      unitPrice: '2500.00',
      unit: 'LB',
      quantity: 2,
      subtotal: '5000.00',
    },
  ],
  total: '5000.00',
};

describe('cart API', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('gets the authenticated customer cart', async () => {
    mockApiGet.mockResolvedValue(cart);

    await expect(getCart()).resolves.toEqual(cart);

    expect(mockApiGet).toHaveBeenCalledWith('/cart');
  });

  it('adds an item with an idempotency key', async () => {
    mockApiPost.mockResolvedValue(cart);

    await expect(
      addCartItem({ productId: 'product-1', quantity: 2 }),
    ).resolves.toEqual(cart);

    expect(mockApiPost).toHaveBeenCalledTimes(1);

    const addCall = mockApiPost.mock.calls[0];

    expect(addCall).toBeDefined();

    const [path, body, init] = addCall!;

    expect(path).toBe('/cart/items');
    expect(body).toEqual({
      productId: 'product-1',
      quantity: 2,
    });

    const headers = init?.headers as Record<string, string> | undefined;

    expect(headers?.['Idempotency-Key']).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it('generates a new idempotency key for each logical add operation', async () => {
    mockApiPost.mockResolvedValue(cart);

    await addCartItem({ productId: 'product-1', quantity: 1 });
    await addCartItem({ productId: 'product-1', quantity: 1 });

    const firstCall = mockApiPost.mock.calls[0];
    const secondCall = mockApiPost.mock.calls[1];

    expect(firstCall).toBeDefined();
    expect(secondCall).toBeDefined();

    const firstInit = firstCall![2];
    const secondInit = secondCall![2];

    const firstHeaders = firstInit?.headers as Record<string, string> | undefined;
    const secondHeaders = secondInit?.headers as Record<string, string> | undefined;

    expect(firstHeaders?.['Idempotency-Key']).toEqual(expect.any(String));
    expect(secondHeaders?.['Idempotency-Key']).toEqual(expect.any(String));
    expect(firstHeaders?.['Idempotency-Key']).not.toBe(secondHeaders?.['Idempotency-Key']);
  });

  it('updates an item quantity', async () => {
    mockApiPatch.mockResolvedValue(cart);

    await expect(updateCartItemQuantity('item-1', 3)).resolves.toEqual(cart);

    expect(mockApiPatch).toHaveBeenCalledWith(
      '/cart/items/item-1',
      { quantity: 3 },
    );
  });

  it('removes an item', async () => {
    mockApiDelete.mockResolvedValue(cart);

    await expect(removeCartItem('item-1')).resolves.toEqual(cart);

    expect(mockApiDelete).toHaveBeenCalledWith('/cart/items/item-1');
  });
});
