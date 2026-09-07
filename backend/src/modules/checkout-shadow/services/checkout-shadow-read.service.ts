import { Inject, Injectable } from '@nestjs/common';

import { RedisService } from '../../../common/redis/redis.service';
import { CartRepository } from '../../cart/repositories/cart.repository';
import { PriceLockRepository } from '../../price-lock/repositories/price-lock.repository';
import { ProductsRepository } from '../../products/repositories/products.repository';
import { ReservationEngineModeConfigRepository } from '../../reservation-engine-mode/repositories/reservation-engine-mode-config.repository';
import {
  productSuspectKey,
  productTotalKey,
  reservationHashKey,
  reservationKey,
} from '../../inventory/constants/inventory.constants';

// Narrow capabilities, backed exclusively by inspected SELECT/GET/HGETALL methods.
// Never use findOrCreateByCustomerId, getActiveReservation, or availability with
// own-cart exclusion: those nominal reads can create, release, or flag state.
@Injectable()
export class CheckoutShadowReadService {
  constructor(
    @Inject(CartRepository) private readonly carts: Pick<CartRepository, 'findById'>,
    @Inject(PriceLockRepository)
    private readonly locks: Pick<PriceLockRepository, 'findCartWideLockState'>,
    @Inject(ProductsRepository) private readonly products: Pick<ProductsRepository, 'findById'>,
    @Inject(ReservationEngineModeConfigRepository)
    private readonly modes: Pick<ReservationEngineModeConfigRepository, 'findCurrent'>,
    @Inject(RedisService) private readonly redis: Pick<RedisService, 'get' | 'hgetall'>,
  ) {}

  cart(id: string) {
    return this.carts.findById(id);
  }
  lines(cartId: string) {
    return this.locks.findCartWideLockState(cartId);
  }
  product(id: string) {
    return this.products.findById(id);
  }
  mode() {
    return this.modes.findCurrent();
  }

  async reservations(cartId: string, productId: string) {
    const [legacy, own, total, suspect] = await Promise.all([
      this.redis.hgetall(reservationHashKey(productId)),
      this.redis.get(reservationKey(cartId, productId)),
      this.redis.get(productTotalKey(productId)),
      this.redis.get(productSuspectKey(productId)),
    ]);
    return { legacy, own, total, suspect };
  }
}
