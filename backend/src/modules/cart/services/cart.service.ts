import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { sanitizeErrorMessage } from '../../../common/utils/sanitize-error-message.util';
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

const MAX_LOG_MESSAGE_LENGTH = 500;

// Phase 16A.0-DA, Unit DA.1A (see the DA.1 architecture review). The
// compensation instructions below describe how to undo whichever primary
// mutation shape produced the current durable CartItem state, if the
// corresponding Redis reservation write turns out to be ambiguous (threw,
// with no proof it did or didn't actually apply). `mutationVersion` here
// guards only the CartItem-table-level write (defense in depth) - the
// marker-level generation gate (see applyCompensation) is the actual
// correctness boundary, since CartItem.mutationVersion resets to 0 on a
// fresh insert and cannot by itself distinguish a deleted row from an
// unrelated later row that happens to share the same version.
type CompensationPlan =
  | { kind: 'DELETE_IF_UNCHANGED'; mutationVersion: number }
  | { kind: 'REVERT_QUANTITY'; mutationVersion: number; toQuantity: number }
  | { kind: 'RESTORE'; toQuantity: number };

// A sentinel used only to unwind applyCompensation's transaction when the
// marker-generation gate misses AFTER a tentative CartItem-level write -
// never surfaced to callers (caught and converted to 'MISSED').
class StaleCompensationGenerationError extends Error {}

@Injectable()
export class CartService {
  private readonly logger = new Logger(CartService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cartRepository: CartRepository,
    private readonly productsRepository: ProductsRepository,
    private readonly vendorsRepository: VendorsRepository,
    private readonly inventoryReservations: InventoryReservationsService,
    private readonly syncState: CartReservationSyncStateRepository,
  ) {}

  async getCart(userId: string): Promise<CartResponseEntity> {
    const cart = await this.cartRepository.findOrCreateByCustomerId(userId);
    return CartService.toResponse(cart);
  }

  async addItem(userId: string, dto: AddCartItemDto): Promise<CartResponseEntity> {
    const cart = await this.cartRepository.findOrCreateByCustomerId(userId);
    const product = await this.assertProductIsPurchasable(dto.productId);

    const existingItem = await this.cartRepository.findItemByCartAndProduct(cart.id, dto.productId);
    const existingQuantity = existingItem?.quantity ?? 0;
    const newTotalQuantity = existingQuantity + dto.quantity;

    await this.assertQuantityAvailable(product, cart.id, newTotalQuantity);

    const { item: mutated, generation } = await this.prisma.$transaction(async (tx) => {
      const item = await this.cartRepository.addOrIncrementItem(cart.id, dto.productId, dto.quantity, tx);
      const marker = await this.syncState.upsertDesiredState(cart.id, dto.productId, item.mutationVersion, item.quantity, tx);
      return { item, generation: marker.generation };
    });

    const compensationPlan: CompensationPlan = existingItem
      ? { kind: 'REVERT_QUANTITY', mutationVersion: mutated.mutationVersion, toQuantity: existingQuantity }
      : { kind: 'DELETE_IF_UNCHANGED', mutationVersion: mutated.mutationVersion };
    await this.convergeReservation(cart.id, dto.productId, generation, mutated.quantity, compensationPlan);

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

    await this.convergeReservation(cart.id, item.productId, generation, mutated.quantity, {
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

    await this.convergeReservation(cart.id, item.productId, generation, null, {
      kind: 'RESTORE',
      toQuantity: deleted.quantity,
    });

    const updated = await this.cartRepository.findOrCreateByCustomerId(userId);
    return CartService.toResponse(updated);
  }

  // Phase 16A.0-DA, Unit DA.1A convergence algorithm (see the DA.1
  // architecture review, including the concurrency-proof correction).
  // Deliberately calls the same legacy InventoryReservationsService.
  // reserve/release CartService already calls today - mode-awareness is
  // DA.3's scope, not DA.1A's. This only makes the existing call site's
  // failure handling deterministic.
  //
  // `generation` is CartReservationSyncState's own permanent counter for
  // this pair - never CartItem.mutationVersion, which resets on a fresh
  // insert and cannot alone distinguish a deleted row's stale compensation
  // from an unrelated later row. desiredQuantity null means "desired Redis
  // state is released/absent". reserve/release are absolute-quantity/
  // idempotent but unconditioned, non-CAS primitives (plain HSET/HDEL,
  // confirmed by direct inspection): a slow, stale write can physically
  // complete AFTER a newer one and silently overwrite it - see
  // confirmOrUnresolve for how that is detected and never left claiming
  // false convergence.
  private async convergeReservation(
    cartId: string,
    productId: string,
    generation: number,
    desiredQuantity: number | null,
    compensationPlan: CompensationPlan,
  ): Promise<void> {
    const converged = await this.tryRedisWrite(productId, cartId, desiredQuantity);
    if (converged) {
      await this.confirmOrUnresolve(cartId, productId, generation);
      return;
    }

    const compensationOutcome = await this.applyCompensation(cartId, productId, generation, compensationPlan);
    if (compensationOutcome === 'MISSED') {
      // A newer mutation already advanced the marker past our generation.
      // Never touch Redis with our now-stale intent - and CartItem was
      // never left touched either (see applyCompensation: a late gate
      // miss rolls back the whole transaction, including any tentative
      // CartItem write already made).
      return;
    }

    // Durable state is now confirmed reverted. The failed write's actual
    // Redis effect is still unknown (it may have silently applied) -
    // re-assert the reverted value, which is always a safe, idempotent
    // no-op if it never applied, and corrective if it did.
    const restored = await this.tryRedisWrite(productId, cartId, compensationOutcome.desiredQuantity);
    if (restored) {
      await this.confirmOrUnresolve(cartId, productId, compensationOutcome.generation);
    }
    // If the restore attempt also throws, the marker (already advanced by
    // applyCompensation, resolvedAt already null) is left unresolved -
    // DA.1B's future recovery worker owns converging it from there.
  }

  // A Redis write we just performed succeeded, but reserve/release carry no
  // CAS/version predicate, so it may have landed after a newer mutation's
  // write and silently overwritten it. resolveIfCurrentGeneration only
  // proves OUR generation is still current; a miss means we cannot prove
  // Redis reflects the newer value rather than our stale one. Required
  // invariant: either Redis is known to match the latest durable target
  // and the marker may be resolved, or convergence is unprovable and the
  // marker stays pending for DA.1B - markUnresolved enforces the second
  // branch. Accepted race (no distributed lock introduced): since
  // markUnresolved targets the CURRENT row, not this call's captured
  // generation, it can conservatively flip an already-synchronized newer
  // marker back to PENDING - acceptable, since false PENDING only costs
  // DA.1B an extra re-check, while false RESOLVED would silently lose
  // divergence evidence.
  private async confirmOrUnresolve(cartId: string, productId: string, generation: number): Promise<void> {
    const resolved = await this.syncState.resolveIfCurrentGeneration(cartId, productId, generation);
    if (resolved.count === 0) {
      await this.syncState.markUnresolved(cartId, productId);
    }
  }

  private async tryRedisWrite(
    productId: string,
    cartId: string,
    desiredQuantity: number | null,
  ): Promise<boolean> {
    try {
      if (desiredQuantity === null) {
        await this.inventoryReservations.release(productId, cartId);
      } else {
        await this.inventoryReservations.reserve(productId, cartId, desiredQuantity);
      }
      return true;
    } catch (error) {
      this.logger.error('Reservation write threw - outcome is ambiguous, not assumed unapplied', {
        cartId,
        productId,
        message: sanitizeErrorMessage(CartService.errorMessage(error), MAX_LOG_MESSAGE_LENGTH),
      });
      return false;
    }
  }

  // CartItem-level compensation runs FIRST, the marker-generation gate
  // SECOND, both inside the same transaction - matching the primary-
  // mutation path's own lock order (CartItem row, then marker row), so
  // both paths acquire Postgres row locks in the same order and cannot
  // deadlock against each other (see the DA.1 architecture review's
  // lock-ordering correction). Order doesn't affect final correctness:
  // transactions are atomic, so a late gate miss below throws to roll
  // back the WHOLE transaction, including the CartItem write just made.
  private async applyCompensation(
    cartId: string,
    productId: string,
    expectedGeneration: number,
    plan: CompensationPlan,
  ): Promise<'MISSED' | { generation: number; desiredQuantity: number | null }> {
    const target = CartService.compensationTarget(plan);
    try {
      return await this.prisma.$transaction(async (tx) => {
        const cartItemOk = await this.applyCartItemCompensation(cartId, productId, plan, tx);
        if (!cartItemOk) {
          return 'MISSED';
        }

        const advanced = await this.syncState.advanceIfCurrentGeneration(
          cartId,
          productId,
          expectedGeneration,
          target.newExpectedMutationVersion,
          target.newExpectedQuantity,
          tx,
        );
        if (advanced.count === 0 || advanced.generation === null) {
          // The CartItem-level write above may have tentatively matched
          // (possible even against a stale guard, after a delete/recreate
          // mutationVersion collision - see the DA.1 architecture
          // review's ABA finding), but the marker generation gate proves
          // a newer mutation has already superseded this generation.
          // Throwing rolls back the whole transaction.
          throw new StaleCompensationGenerationError();
        }

        return { generation: advanced.generation, desiredQuantity: target.newExpectedQuantity };
      });
    } catch (error) {
      if (error instanceof StaleCompensationGenerationError) {
        return 'MISSED';
      }
      throw error;
    }
  }

  private async applyCartItemCompensation(
    cartId: string,
    productId: string,
    plan: CompensationPlan,
    tx: Prisma.TransactionClient,
  ): Promise<boolean> {
    if (plan.kind === 'DELETE_IF_UNCHANGED') {
      const result = await this.cartRepository.compensateItemDeleteIfUnchanged(cartId, productId, plan.mutationVersion, tx);
      return result.count > 0;
    }
    if (plan.kind === 'REVERT_QUANTITY') {
      const result = await this.cartRepository.compensateItemQuantity(
        cartId,
        productId,
        plan.mutationVersion,
        plan.toQuantity,
        tx,
      );
      return result.count > 0;
    }
    const outcome = await this.cartRepository.compensateItemRestore(cartId, productId, plan.toQuantity, tx);
    return outcome.restored;
  }

  // The exact post-compensation CartItem state, known in advance because
  // each primitive's own increment/reset behavior is deterministic given
  // the guard value being passed to it (see cart.repository.ts).
  private static compensationTarget(
    plan: CompensationPlan,
  ): { newExpectedMutationVersion: number; newExpectedQuantity: number | null } {
    if (plan.kind === 'DELETE_IF_UNCHANGED') {
      return { newExpectedMutationVersion: plan.mutationVersion, newExpectedQuantity: null };
    }
    if (plan.kind === 'REVERT_QUANTITY') {
      return { newExpectedMutationVersion: plan.mutationVersion + 1, newExpectedQuantity: plan.toQuantity };
    }
    // RESTORE - compensateItemRestore always creates a fresh row, which
    // always starts at mutationVersion 0.
    return { newExpectedMutationVersion: 0, newExpectedQuantity: plan.toQuantity };
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
