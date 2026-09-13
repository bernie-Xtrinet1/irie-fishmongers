import crypto from 'crypto';
import { execFileSync } from 'child_process';
import { join } from 'path';
import type { CheckoutReservationResource } from '@prisma/client';
import type { MutationPermit, ResourceAuthority } from './types/reservation-mutation.types';
import { UUID_PATTERN } from './types/reservation-fence.types';
import { ordinaryHoldInstanceId } from './ordinary-hold-instance-id';

const markerId = '123e4567-e89b-12d3-a456-426614174000';
const expectedZero = '47cfb9c9-18fa-5393-b970-968535e03499';

describe('canonical ordinary reservation identity foundation', () => {
  it('matches a fixed UUIDv5 vector and supports generation zero', () => {
    expect(ordinaryHoldInstanceId(markerId, 0)).toBe(expectedZero);
    expect(ordinaryHoldInstanceId(markerId, 0)).toMatch(UUID_PATTERN);
    expect(expectedZero).toMatch(/^[a-f0-9-]{14}5[a-f0-9]{3}-[89ab]/);
  });
  it('is stable across repeated calls and distinct across marker/generation inputs', () => {
    expect(ordinaryHoldInstanceId(markerId, 1)).toBe(ordinaryHoldInstanceId(markerId, 1));
    expect(ordinaryHoldInstanceId(markerId, 1)).not.toBe(expectedZero);
    expect(ordinaryHoldInstanceId('123e4567-e89b-12d3-a456-426614174001', 0)).not.toBe(expectedZero);
    expect(ordinaryHoldInstanceId(markerId, 2147483647)).toMatch(UUID_PATTERN);
  });
  it('returns the same identity in a fresh process', () => {
    const source = join(__dirname, 'ordinary-hold-instance-id.ts');
    const output = execFileSync(process.execPath, ['-r', require.resolve('ts-node/register/transpile-only'),
      '-e', 'process.stdout.write(require(process.argv[1]).ordinaryHoldInstanceId(process.argv[2], 0))', source, markerId],
    { encoding: 'utf8', timeout: 20000 });
    expect(output).toBe(expectedZero);
  });
  it.each([-1, 0.5, NaN, Infinity, -Infinity, 2147483648, '0', null, undefined])(
    'rejects invalid generation %s', generation => {
      expect(() => ordinaryHoldInstanceId(markerId, generation as number)).toThrow('INVALID_RESERVATION_GENERATION');
    });
  it.each(['', 'not-a-uuid', markerId.toUpperCase(), `${markerId}\n`, `${markerId} `, null, undefined, 42])(
    'rejects invalid marker %s using the existing identifier rule', id => {
      expect(() => ordinaryHoldInstanceId(id as string, 0)).toThrow('INVALID_RESERVATION_MARKER_ID');
    });
  it('excludes quantity and CartItem mutationVersion from lifetime identity', () => {
    const first = { id: markerId, generation: 0, expectedQuantity: 2, expectedMutationVersion: 0 };
    const changed = { ...first, expectedQuantity: 8, expectedMutationVersion: 99 };
    expect(ordinaryHoldInstanceId(first.id, first.generation)).toBe(ordinaryHoldInstanceId(changed.id, changed.generation));
  });
  it('uses no randomness or clock', () => {
    const uuid = jest.spyOn(crypto, 'randomUUID').mockImplementation(() => { throw new Error('Randomness forbidden'); });
    const random = jest.spyOn(Math, 'random').mockImplementation(() => { throw new Error('Randomness forbidden'); });
    const clock = jest.spyOn(Date, 'now').mockImplementation(() => { throw new Error('Clock forbidden'); });
    try { expect(ordinaryHoldInstanceId(markerId, 0)).toBe(expectedZero); }
    finally { uuid.mockRestore(); random.mockRestore(); clock.mockRestore(); }
  });
  it('fits unchanged permit resources, guard serialization and settlement resource UUID fields', () => {
    const resource: ResourceAuthority = { markerId, generation: 0, holdInstanceId: ordinaryHoldInstanceId(markerId, 0),
      cartId: markerId, customerId: markerId, productId: markerId };
    const resources: MutationPermit['resources'] = [resource];
    const guard = { incarnation: markerId, epoch: 1, resource: resources[0]! };
    const settlement: Pick<CheckoutReservationResource, 'markerId' | 'generation' | 'holdInstanceId'> = resource;
    expect(JSON.parse(JSON.stringify(guard))).toEqual(guard);
    expect(settlement.holdInstanceId).toBe(expectedZero);
  });
});
