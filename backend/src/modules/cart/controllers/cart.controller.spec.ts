import { CartResponseEntity } from '../entities/cart-response.entity';
import { CartService } from '../services/cart.service';
import { CartController } from './cart.controller';

const cart: CartResponseEntity = { id: 'cart-1', items: [], total: '0' };
const user = { id: 'user-1', email: 'a@b.com', roles: ['CUSTOMER' as const] };

describe('CartController', () => {
  let cartService: jest.Mocked<Pick<CartService, 'getCart' | 'addItem' | 'updateItemQuantity' | 'removeItem'>>;
  let controller: CartController;

  beforeEach(() => {
    cartService = {
      getCart: jest.fn().mockResolvedValue(cart),
      addItem: jest.fn().mockResolvedValue(cart),
      updateItemQuantity: jest.fn().mockResolvedValue(cart),
      removeItem: jest.fn().mockResolvedValue(cart),
    };
    controller = new CartController(cartService as unknown as CartService);
  });

  it('gets the cart', async () => {
    await expect(controller.getCart(user)).resolves.toEqual(cart);
  });

  it('adds an item', async () => {
    await controller.addItem(user, { productId: 'product-1', quantity: 2 });
    expect(cartService.addItem).toHaveBeenCalledWith('user-1', { productId: 'product-1', quantity: 2 });
  });

  it('updates item quantity', async () => {
    await controller.updateItemQuantity(user, 'item-1', { quantity: 5 });
    expect(cartService.updateItemQuantity).toHaveBeenCalledWith('user-1', 'item-1', { quantity: 5 });
  });

  it('removes an item', async () => {
    await controller.removeItem(user, 'item-1');
    expect(cartService.removeItem).toHaveBeenCalledWith('user-1', 'item-1');
  });
});
