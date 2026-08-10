import { BadRequestException, ForbiddenException } from '@nestjs/common';

import { PrepareCheckoutFailure } from '../types/checkout-preparation.types';

// Phase 16A.0-D, Unit D.1. Reconstructs the exact exception legacy
// OrdersService.checkout has always thrown for each OrdersService.prepareCheckout
// failure - same class, same message - so checkout()'s externally observable
// behavior is unchanged by the prepareCheckout extraction. The future
// CheckoutCoordinatorService does not use this mapper - it consumes the
// typed PrepareCheckoutResult directly.
export function mapPrepareFailureToHttpException(failure: PrepareCheckoutFailure): Error {
  switch (failure.code) {
    case 'CART_EMPTY':
      return new BadRequestException('Cart is empty');
    case 'PRODUCT_NOT_AVAILABLE':
      return new BadRequestException(`"${failure.productName}" is no longer available`);
    case 'PRODUCT_FOOD_SAFETY_HOLD':
      return new BadRequestException(
        `"${failure.productName}" is currently on hold pending a food-safety review`,
      );
    case 'VENDOR_NOT_APPROVED':
      return new BadRequestException(
        `"${failure.productName}" is not currently sold by an approved vendor`,
      );
    case 'VENDOR_SALES_LIMIT_EXCEEDED':
      return new ForbiddenException(failure.message);
  }
}
