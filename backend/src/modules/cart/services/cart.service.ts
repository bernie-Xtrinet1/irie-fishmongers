import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { CartItem, Prisma } from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';
import { CartReservationSyncStateRepository } from '../../cart-reservation-sync/repositories/cart-reservation-sync-state.repository';
import { SeafoodLotsService } from '../../food-safety/services/seafood-lots.service';
import { InventoryReservationsService } from '../../inventory/services/inventory-reservations.service';
import { ProductsRepository, ProductWithLot } from '../../products/repositories/products.repository';
import { VendorsRepository } from '../../vendors/repositories/vendors.repository';
import { AddCartItemDto } from '../dto/add-cart-item.dto';
import { UpdateCartItemDto } from '../dto/update-cart-item.dto';
import { CartResponseEntity } from '../entities/cart-response.entity';
import { CartRepository, CartWithItems } from '../repositories/cart.repository';
import { ClassifyCartItemAddAttemptResult } from '../types/cart-item-add-attempt.types';
import { classifyCartItemAddRejection, reconstructCartItemAddRejection } from '../utils/cart-item-add-rejection.util';
import { CartItemAddIdempotencyService } from './cart-item-add-idempotency.service';
import { CartReservationConvergenceService, CompensationPlan } from './cart-reservation-convergence.service';

// A sentinel used only to unwind the addItem mutation transaction when the
// idempotency-attempt completion fence misses after tentative CartItem/
// marker writes - never surfaced to callers (caught and converted to
// 'SUPERSEDED'). Mirrors StaleCompensationGenerationError's role in
// cart-reservation-convergence.service.ts.
class StaleIdempotencyAttemptError extends Error {}

// A second supersession within one synchronous addItem call would require
// a second full staleness window to have already elapsed - never expected
// in practice. Bounds the reclassify-and-retry loop rather than looping
// unboundedly.
const MAX_ADD_ITEM_CLASSIFICATION_ROUNDS = 2;

// Compensation/Redis-failure-convergence logic lives in
// cart-reservation-convergence.service.ts (Phase 16A.0-DA, Unit DA.1A,
// extracted for file size in Unit DA.2). Compensation/Redis-failure test
// coverage lives in cart-service-compensation.spec.ts - split to stay
// under the 400-line file cap.
@Injectable()
export class CartService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cartRepository: CartRepository,
    private readonly productsRepository: ProductsRepository,
    private readonly vendorsRepository: VendorsRepository,
    private readonly inventoryReservations: InventoryReservationsService,
    private readonly syncState: CartReservationSyncStateRepository,
    private readonly convergence: CartReservationConvergenceService,
    private readonly idempotency: CartItemAddIdempotencyService,
  ) {}

  async getCart(userId: string): Promise<CartResponseEntity> {
    const cart = await this.cartRepository.findOrCreateByCustomerId(userId);
    return CartService.toResponse(cart);
  }

  // Phase 16A.0-DA, Unit DA.2 (see the DA.2 design review). Mandatory
  // Idempotency-Key header, classified against the durable
  // CartItemAddAttempt table before any CartItem mutation is attempted -
  // see CartItemAddIdempotencyService.classify for the full state machine
  // (NEW/CONFLICT/COMPLETED replay/PROCESSING replay-or-reclaim).
  async addItem(userId: string, dto: AddCartItemDto, idempotencyKey: string): Promise<CartResponseEntity> {
    const cart = await this.cartRepository.findOrCreateByCustomerId(userId);
    const now = new Date();

    let classification = await this.classify(userId, idempotencyKey, cart.id, dto, now);
    for (let round = 0; round < MAX_ADD_ITEM_CLASSIFICATION_ROUNDS; round += 1) {
      const outcome = await this.handleClassification(userId, cart.id, dto, classification, now);
      if (outcome !== 'SUPERSEDED') {
        return outcome;
      }
      classification = await this.classify(userId, idempotencyKey, cart.id, dto, now);
    }
    throw new ConflictException('This request could not be completed due to concurrent retries; please try again');
  }

  private classify(
    customerId: string,
    idempotencyKey: string,
    cartId: string,
    dto: AddCartItemDto,
    now: Date,
  ): Promise<ClassifyCartItemAddAttemptResult> {
    return this.idempotency.classify({
      customerId,
      idempotencyKey,
      cartId,
      productId: dto.productId,
      requestedQuantity: dto.quantity,
      now,
    });
  }

  private async handleClassification(
    userId: string,
    cartId: string,
    dto: AddCartItemDto,
    classification: ClassifyCartItemAddAttemptResult,
    now: Date,
  ): Promise<CartResponseEntity | 'SUPERSEDED'> {
    if (classification.outcome === 'IDEMPOTENCY_KEY_CONFLICT') {
      throw new ConflictException('This idempotency key was already used for a different request');
    }
    if (classification.outcome === 'ALREADY_PROCESSING') {
      throw new ConflictException('This request is already being processed');
    }
    if (classification.outcome === 'REJECTED_REPLAY') {
      throw reconstructCartItemAddRejection(classification.rejectionCode, classification.rejectionMessage);
    }
    if (classification.outcome === 'COMPLETED_REPLAY') {
      // Replay guarantees the original mutation happened exactly once -
      // zero CartItem mutation, zero reservation-sync mutation here.
      const updated = await this.cartRepository.findOrCreateByCustomerId(userId);
      return CartService.toResponse(updated);
    }

    return this.executeAddItem(userId, cartId, dto, classification.attemptId, classification.attemptCount, now);
  }

  private async executeAddItem(
    userId: string,
    cartId: string,
    dto: AddCartItemDto,
    attemptId: string,
    attemptCount: number,
    now: Date,
  ): Promise<CartResponseEntity | 'SUPERSEDED'> {
    const existingItem = await this.cartRepository.findItemByCartAndProduct(cartId, dto.productId);
    const existingQuantity = existingItem?.quantity ?? 0;
    const newTotalQuantity = existingQuantity + dto.quantity;

    await this.validateOrReject(dto.productId, cartId, newTotalQuantity, attemptId, attemptCount, now);

    let mutation: { item: CartItem; generation: number } | 'SUPERSEDED';
    try {
      mutation = await this.prisma.$transaction(async (tx) => {
        const item = await this.cartRepository.addOrIncrementItem(cartId, dto.productId, dto.quantity, tx);
        const marker = await this.syncState.upsertDesiredState(cartId, dto.productId, item.mutationVersion, item.quantity, tx);
        const completed = await this.idempotency.complete(
          tx,
          attemptId,
          attemptCount,
          { cartItemId: item.id, quantity: item.quantity, mutationVersion: item.mutationVersion, generation: marker.generation },
          now,
        );
        if (completed.count === 0) {
          throw new StaleIdempotencyAttemptError();
        }
        return { item, generation: marker.generation };
      });
    } catch (error) {
      if (error instanceof StaleIdempotencyAttemptError) {
        return 'SUPERSEDED';
      }
      throw error;
    }

    const compensationPlan: CompensationPlan = existingItem
      ? { kind: 'REVERT_QUANTITY', mutationVersion: mutation.item.mutationVersion, toQuantity: existingQuantity }
      : { kind: 'DELETE_IF_UNCHANGED', mutationVersion: mutation.item.mutationVersion };
    await this.convergence.convergeReservation(cartId, dto.productId, mutation.generation, mutation.item.quantity, compensationPlan);

    const updated = await this.cartRepository.findOrCreateByCustomerId(userId);
    return CartService.toResponse(updated);
  }

  // Wraps the existing read-only business-rule validation to durably
  // record a typed rejection before rethrowing - never wraps anything
  // beyond these two specific calls, so an infrastructure error thrown by
  // a dependency (e.g. Redis) is never misclassified as a finished
  // business decision (see cart-item-add-rejection.util.ts).
  private async validateOrReject(
    productId: string,
    cartId: string,
    requestedTotal: number,
    attemptId: string,
    attemptCount: number,
    now: Date,
  ): Promise<void> {
    try {
      const product = await this.assertProductIsPurchasable(productId);
      await this.assertQuantityAvailable(product, cartId, requestedTotal);
    } catch (error) {
      const rejectionCode = classifyCartItemAddRejection(error);
      if (rejectionCode) {
        await this.idempotency.reject(attemptId, attemptCount, rejectionCode, CartService.errorMessage(error), now);
      }
      throw error;
    }
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

    const product = await this.assertProductIsPurchasable(item.productId);
    await this.assertQuantityAvailable(product, cart.id, dto.quantity);

    const previousQuantity = item.quantity;
    const { item: mutated, generation } = await this.prisma.$transaction(async (tx) => {
      const updatedItem = await this.cartRepository.updateItemQuantity(itemId, dto.quantity, tx);
      const marker = await this.syncState.upsertDesiredState(
        cart.id,
        item.productId,
        updatedItem.mutationVersion,
        updatedItem.quantity,
        tx,
      );
      return { item: updatedItem, generation: marker.generation };
    });

    await this.convergence.convergeReservation(cart.id, item.productId, generation, mutated.quantity, {
      kind: 'REVERT_QUANTITY',
      mutationVersion: mutated.mutationVersion,
      toQuantity: previousQuantity,
    });

    const updated = await this.cartRepository.findOrCreateByCustomerId(userId);
    return CartService.toResponse(updated);
  }

  async removeItem(userId: string, itemId: string): Promise<CartResponseEntity> {
    const cart = await this.cartRepository.findOrCreateByCustomerId(userId);
    const item = await this.cartRepository.findItemById(cart.id, itemId);
    if (!item) {
      throw new NotFoundException('Cart item not found');
    }

    const { item: deleted, generation } = await this.prisma.$transaction(async (tx) => {
      const removed = await this.cartRepository.removeItem(itemId, tx);
      const marker = await this.syncState.upsertDesiredState(cart.id, item.productId, removed.mutationVersion, null, tx);
      return { item: removed, generation: marker.generation };
    });

    await this.convergence.convergeReservation(cart.id, item.productId, generation, null, {
      kind: 'RESTORE',
      toQuantity: deleted.quantity,
    });

    const updated = await this.cartRepository.findOrCreateByCustomerId(userId);
    return CartService.toResponse(updated);
  }

  private async assertProductIsPurchasable(productId: string): Promise<ProductWithLot> {
    const product = await this.productsRepository.findById(productId);
    if (!product || !product.isActive) {
      throw new BadRequestException('Product is not available');
    }
    if (
      product.lot &&
      (product.lot.foodSafetyStatus !== 'SAFE' || !SeafoodLotsService.isGradingSellable(product.lot))
    ) {
      throw new BadRequestException(
        'This product is currently on hold pending a food-safety review and cannot be purchased',
      );
    }

    const vendor = await this.vendorsRepository.findById(product.vendorId);
    if (!vendor || vendor.status !== 'APPROVED') {
      throw new ForbiddenException('This product is not currently sold by an approved vendor');
    }

    return product;
  }

  private async assertQuantityAvailable(
    product: ProductWithLot,
    cartId: string,
    requestedTotal: number,
  ): Promise<void> {
    const availableToPurchase = await this.inventoryReservations.getAvailableToPurchase(
      product.id,
      product.quantityAvailable,
      cartId,
    );
    if (requestedTotal > availableToPurchase) {
      throw new ConflictException(
        `Only ${availableToPurchase} unit(s) of this product are currently available`,
      );
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

  private static errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
