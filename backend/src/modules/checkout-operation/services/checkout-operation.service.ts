import { Injectable } from '@nestjs/common';
import { CheckoutOperation, CheckoutPath } from '@prisma/client';
import { createHash } from 'crypto';
import { isUUID } from 'class-validator';
import { CheckoutOperationRepository } from '../repositories/checkout-operation.repository';
import { CartRepository } from '../../cart/repositories/cart.repository';
import { PriceLockRepository } from '../../price-lock/repositories/price-lock.repository';
import { PriceLockService } from '../../price-lock/services/price-lock.service';
import { ValidatedCartPriceLockItem } from '../../price-lock/types/price-lock.types';

type FailureCode =
  | 'INVALID_INPUT'
  | 'OWNERSHIP_MISMATCH'
  | 'CART_CONFLICT'
  | 'NOT_FOUND'
  | 'PATH_CONFLICT'
  | 'RECONFIRM_REQUIRED';
export type OperationResult =
  { ok: true; operation: CheckoutOperation } | { ok: false; code: FailureCode };

// Fixed-position arrays, UTF-8 JSON, exact identifiers/currency, canonical
// decimal strings from PriceLockService, ISO millisecond timestamps. No locale.
export function priceLockFingerprint(
  cartId: string,
  currency: string,
  items: (ValidatedCartPriceLockItem & { mutationVersion: number })[],
): string {
  const lines = [...items]
    .sort((a, b) => (a.cartItemId < b.cartItemId ? -1 : a.cartItemId > b.cartItemId ? 1 : 0))
    .map((item) => [
      item.cartItemId,
      item.productId,
      item.quantity,
      item.mutationVersion,
      item.lockedUnitPrice,
      item.lockedCurrency,
      item.priceLockedAt.toISOString(),
    ]);
  return createHash('sha256')
    .update(JSON.stringify(['checkout-price-lock-v1', cartId, currency, lines]), 'utf8')
    .digest('hex');
}

@Injectable()
export class CheckoutOperationService {
  constructor(
    private readonly repository: CheckoutOperationRepository,
    private readonly carts: CartRepository,
    private readonly locks: PriceLockRepository,
    private readonly prices: PriceLockService,
  ) {}

  issue(input: { customerId: string; cartId: string; retryKey: string }): Promise<OperationResult> {
    if (
      !input ||
      Object.keys(input).some((key) => !['customerId', 'cartId', 'retryKey'].includes(key)) ||
      !isUUID(input.customerId) ||
      !isUUID(input.cartId) ||
      typeof input.retryKey !== 'string' ||
      !/^[\x21-\x7e]{1,128}$/.test(input.retryKey)
    )
      return Promise.resolve({ ok: false, code: 'INVALID_INPUT' });
    const retryKeyHash = createHash('sha256')
      .update('checkout-retry-v1\0')
      .update(input.retryKey, 'utf8')
      .digest('hex');
    return this.repository.transaction(async (tx) => {
      const cart = await this.carts.findById(input.cartId, tx);
      if (!cart || cart.customerId !== input.customerId)
        return { ok: false, code: 'OWNERSHIP_MISMATCH' };
      const operation = await this.repository.resolve(
        input.customerId,
        retryKeyHash,
        input.cartId,
        tx,
      );
      return operation.cartId === input.cartId
        ? { ok: true, operation }
        : { ok: false, code: 'CART_CONFLICT' };
    });
  }

  // Trusted server-only future admission boundary. Never bind HTTP request data
  // directly to this method; issuance accepts neither path nor operation key.
  assignPath(
    customerId: string,
    operationId: string,
    path: CheckoutPath,
  ): Promise<OperationResult> {
    if (!isUUID(customerId) || !isUUID(operationId) || !['LEGACY', 'CART_SCOPED'].includes(path))
      return Promise.resolve({ ok: false, code: 'INVALID_INPUT' });
    return this.repository.transaction(async (tx) => {
      const found = await this.repository.findOwned(operationId, customerId, tx);
      if (!found) return { ok: false, code: 'NOT_FOUND' };
      if (found.selectedPath !== null)
        return found.selectedPath === path
          ? { ok: true, operation: found }
          : { ok: false, code: 'PATH_CONFLICT' };
      await this.repository.assignPath(operationId, customerId, path, tx);
      const operation = (await this.repository.findOwned(operationId, customerId, tx))!;
      return operation.selectedPath === path
        ? { ok: true, operation }
        : { ok: false, code: 'PATH_CONFLICT' };
    });
  }

  prepare(customerId: string, operationId: string, now: Date): Promise<OperationResult> {
    if (
      !isUUID(customerId) ||
      !isUUID(operationId) ||
      !(now instanceof Date) ||
      !Number.isFinite(now.getTime())
    )
      return Promise.resolve({ ok: false, code: 'INVALID_INPUT' });
    return this.repository.transaction(async (tx) => {
      const operation = await this.repository.findOwned(operationId, customerId, tx);
      if (!operation) return { ok: false, code: 'NOT_FOUND' };
      const cart = await this.carts.findById(operation.cartId, tx);
      if (!cart || cart.customerId !== customerId) return { ok: false, code: 'OWNERSHIP_MISMATCH' };
      if (operation.priceLockFingerprint === null) {
        const items = await this.locks.findCartWideLockState(cart.id, tx);
        for (const item of items) {
          const created = await this.prices.createPriceLock(
            { customerId, cartId: cart.id, cartItemId: item.id, now },
            tx,
          );
          if (!created.ok) return { ok: false, code: 'RECONFIRM_REQUIRED' };
        }
      }
      const validated = await this.prices.validateCartPriceLocks(cart.id, customerId, now, tx);
      if (!validated.ok) return { ok: false, code: 'RECONFIRM_REQUIRED' };
      const lines: (ValidatedCartPriceLockItem & { mutationVersion: number })[] = [];
      for (const item of validated.items) {
        const current = await this.carts.findItemById(cart.id, item.cartItemId, tx);
        if (!current) return { ok: false, code: 'RECONFIRM_REQUIRED' };
        lines.push({ ...item, mutationVersion: current.mutationVersion });
      }
      const fingerprint = priceLockFingerprint(cart.id, validated.cartCurrency, lines);
      if (operation.priceLockFingerprint !== null)
        return operation.priceLockFingerprint === fingerprint
          ? { ok: true, operation }
          : { ok: false, code: 'RECONFIRM_REQUIRED' };
      await this.repository.bindFingerprint(operationId, customerId, fingerprint, tx);
      const bound = (await this.repository.findOwned(operationId, customerId, tx))!;
      return bound.priceLockFingerprint === fingerprint
        ? { ok: true, operation: bound }
        : { ok: false, code: 'RECONFIRM_REQUIRED' };
    });
  }
}
