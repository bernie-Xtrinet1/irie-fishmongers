import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';

import { CartItemAddRejectionCode } from '../types/cart-item-add-attempt.types';

// Phase 16A.0-DA, Unit DA.2 (see the DA.2 design review). Maps
// CartService.assertProductIsPurchasable/assertQuantityAvailable's own
// thrown exceptions to a typed rejection code for durable idempotency
// recording, and reconstructs the same exception type/message on replay.
// Only these specific, known business-rule exceptions are ever classified
// as a rejection - any other error (infrastructure failure) returns null
// and must be left non-terminal (see CartItemAddAttempt's model-level
// comment: infra failures stay PROCESSING, recoverable only via stale
// reclaim, never REJECTED).
const PRODUCT_NOT_AVAILABLE_MESSAGE = 'Product is not available';
const PRODUCT_ON_HOLD_MESSAGE =
  'This product is currently on hold pending a food-safety review and cannot be purchased';

export function classifyCartItemAddRejection(error: unknown): CartItemAddRejectionCode | null {
  if (error instanceof BadRequestException) {
    if (error.message === PRODUCT_NOT_AVAILABLE_MESSAGE) {
      return 'PRODUCT_NOT_PURCHASABLE';
    }
    if (error.message === PRODUCT_ON_HOLD_MESSAGE) {
      return 'PRODUCT_ON_HOLD';
    }
    return null;
  }
  if (error instanceof ForbiddenException) {
    return 'VENDOR_NOT_APPROVED';
  }
  if (error instanceof ConflictException) {
    return 'QUANTITY_NOT_AVAILABLE';
  }
  return null;
}

export function reconstructCartItemAddRejection(
  code: CartItemAddRejectionCode,
  message: string,
): BadRequestException | ForbiddenException | ConflictException {
  if (code === 'VENDOR_NOT_APPROVED') {
    return new ForbiddenException(message);
  }
  if (code === 'QUANTITY_NOT_AVAILABLE') {
    return new ConflictException(message);
  }
  return new BadRequestException(message);
}
