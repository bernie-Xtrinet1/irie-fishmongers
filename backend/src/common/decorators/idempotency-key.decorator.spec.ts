import { BadRequestException } from '@nestjs/common';
import { Request } from 'express';

import { extractIdempotencyKey, IDEMPOTENCY_KEY_HEADER } from './idempotency-key.decorator';

// Phase 16A.0-DA, Unit DA.2 (see the DA.2 design review).
describe('extractIdempotencyKey', () => {
  function headers(overrides: Record<string, string | undefined> = {}): Request['headers'] {
    return overrides;
  }

  it('returns a valid UUID header value unchanged', () => {
    const key = 'a3f5b2c1-1111-4a2b-9c3d-000000000001';
    expect(extractIdempotencyKey(headers({ [IDEMPOTENCY_KEY_HEADER]: key }))).toBe(key);
  });

  it('throws BadRequestException when the header is missing', () => {
    expect(() => extractIdempotencyKey(headers({}))).toThrow(BadRequestException);
  });

  it('throws BadRequestException when the header is an empty string', () => {
    expect(() => extractIdempotencyKey(headers({ [IDEMPOTENCY_KEY_HEADER]: '' }))).toThrow(BadRequestException);
  });

  it('throws BadRequestException when the header is not a valid UUID', () => {
    expect(() => extractIdempotencyKey(headers({ [IDEMPOTENCY_KEY_HEADER]: 'not-a-uuid' }))).toThrow(
      BadRequestException,
    );
  });

  it('throws BadRequestException when the header is repeated (array value)', () => {
    const value = ['a3f5b2c1-1111-4a2b-9c3d-000000000001', 'b3f5b2c1-1111-4a2b-9c3d-000000000002'];
    expect(() => extractIdempotencyKey({ [IDEMPOTENCY_KEY_HEADER]: value })).toThrow(BadRequestException);
  });
});
