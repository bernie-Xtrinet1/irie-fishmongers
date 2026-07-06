import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ProductsRepository } from '../../products/repositories/products.repository';
import { VendorsRepository } from '../../vendors/repositories/vendors.repository';
import { AddCartItemDto } from '../dto/add-cart-item.dto';
import { UpdateCartItemDto } from '../dto/update-cart-item.dto';
import { CartResponseEntity } from '../entities/cart-response.entity';
import { CartRepository, CartWithItems } from '../repositories/cart.repository';

@Injectable()
export class CartService {
  constructor(
    private readonly cartRepository: CartRepository,
    private readonly productsRepository: ProductsRepository,
    private readonly vendorsRepository: VendorsRepository,
  ) {}

  async getCart(userId: string): Promise<CartResponseEntity> {
    const cart = await this.cartRepository.findOrCreateByCustomerId(userId);
    return CartService.toResponse(cart);
  }

  async addItem(userId: string, dto: AddCartItemDto): Promise<CartResponseEntity> {
    await this.assertProductIsPurchasable(dto.productId);

    const cart = await this.cartRepository.findOrCreateByCustomerId(userId);
    await this.cartRepository.addOrIncrementItem(cart.id, dto.productId, dto.quantity);

    const updated = await this.cartRepository.findOrCreateByCustomerId(userId);
    return CartService.toResponse(updated);
  }

  async updateItemQuantity(
    userId: string,
    itemId: string,
    dto: UpdateCartItemDto,
  ): Promise<CartResponseEntity> {
    const cart = await this.cartRepository.findOrCreateByCustomerId(userId);
    const item = await this.cartRepository.findItemById(cart.id, itemId);
    if (!item) {
      throw new NotFoundException('Cart item not found');
    }

    await this.assertProductIsPurchasable(item.productId);
    await this.cartRepository.updateItemQuantity(itemId, dto.quantity);

    const updated = await this.cartRepository.findOrCreateByCustomerId(userId);
    return CartService.toResponse(updated);
  }

  async removeItem(userId: string, itemId: string): Promise<CartResponseEntity> {
    const cart = await this.cartRepository.findOrCreateByCustomerId(userId);
    const item = await this.cartRepository.findItemById(cart.id, itemId);
    if (!item) {
      throw new NotFoundException('Cart item not found');
    }

    await this.cartRepository.removeItem(itemId);

    const updated = await this.cartRepository.findOrCreateByCustomerId(userId);
    return CartService.toResponse(updated);
  }

  private async assertProductIsPurchasable(productId: string): Promise<void> {
    const product = await this.productsRepository.findById(productId);
    if (!product || !product.isActive) {
      throw new BadRequestException('Product is not available');
    }
    if (product.lot && product.lot.foodSafetyStatus !== 'SAFE') {
      throw new BadRequestException(
        'This product is currently on hold pending a food-safety review and cannot be purchased',
      );
    }

    const vendor = await this.vendorsRepository.findById(product.vendorId);
    if (!vendor || vendor.status !== 'APPROVED') {
      throw new ForbiddenException('This product is not currently sold by an approved vendor');
    }
  }

  private static toResponse(cart: CartWithItems): CartResponseEntity {
    const items = cart.items.map((item) => {
      const subtotal = item.product.price.times(item.quantity);
      return {
        id: item.id,
        productId: item.productId,
        productName: item.product.name,
        vendorId: item.product.vendorId,
        unitPrice: item.product.price.toString(),
        unit: item.product.unit,
        quantity: item.quantity,
        subtotal: subtotal.toString(),
      };
    });

    const total = items.reduce(
      (sum, item) => sum.plus(new Prisma.Decimal(item.subtotal)),
      new Prisma.Decimal(0),
    );

    return { id: cart.id, items, total: total.toString() };
  }
}
