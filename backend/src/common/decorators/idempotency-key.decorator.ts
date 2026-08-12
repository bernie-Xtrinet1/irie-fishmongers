import { BadRequestException, createParamDecorator, ExecutionContext } from '@nestjs/common';
import { Request } from 'express';
import { isUUID } from 'class-validator';

export const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';

// Phase 16A.0-DA, Unit DA.2 (see the DA.2 design review). Mandatory
// transport/request-identity metadata, deliberately kept out of the
// request body - the body remains the actual operation intent (product,
// quantity), while this header identifies the logical request across
// retries. Reusable by any future mutation (updateItemQuantity,
// removeItem, checkout) that adopts the same idempotency-key contract -
// not cart-specific by design.
//
// Split into a plain function so the validation itself is directly unit
// testable, matching getReservationKeySegmentValidationError's own
// precedent - createParamDecorator's factory cannot be invoked directly
// outside a real Nest request pipeline.
export function extractIdempotencyKey(headers: Request['headers']): string {
  // Express lowercases incoming header names, so a lowercase lookup
  // matches any client casing.
  const value = headers[IDEMPOTENCY_KEY_HEADER];

  if (typeof value !== 'string' || value.length === 0) {
    throw new BadRequestException(`The "${IDEMPOTENCY_KEY_HEADER}" header is required`);
  }
  if (!isUUID(value)) {
    throw new BadRequestException(`The "${IDEMPOTENCY_KEY_HEADER}" header must be a valid UUID`);
  }
  return value;
}

export const IdempotencyKey = createParamDecorator((_data: unknown, ctx: ExecutionContext): string => {
  const request = ctx.switchToHttp().getRequest<Request>();
  return extractIdempotencyKey(request.headers);
});
