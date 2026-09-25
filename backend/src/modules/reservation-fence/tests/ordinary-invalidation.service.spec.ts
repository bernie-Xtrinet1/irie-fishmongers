import { randomUUID } from 'crypto';
import { barrierAcknowledgement, canonicalInvalidationJson, InvalidationRequest, invalidationDigest,
  validateInvalidationRequest } from '../types/ordinary-invalidation.types';

describe('inactive invalidation request and evidence identity', () => {
  const id = () => randomUUID();
  function request(): InvalidationRequest {
    return { version: 1, intentId: id(), operationId: id(), kind: 'CART', incarnation: id(), epoch: 1,
      scopes: [{ kind: 'MARKER', markerId: id(), customerId: id(), cartId: id(), productId: id(), revision: 2,
        before: { generation: 0, mutationVersion: 0, quantity: 2 }, after: { generation: 1, mutationVersion: 1, quantity: 3 },
        cartBefore: null, cartAfter: null, ownersBefore: [], ownersAfter: [] }] };
  }
  it('binds complete sorted scope acknowledgement to exact immutable request', () => {
    const r = request();
    expect(() => validateInvalidationRequest(r)).not.toThrow();
    expect(barrierAcknowledgement(r)).toEqual({ version: 1, intentId: r.intentId, digest: invalidationDigest(r),
      incarnation: r.incarnation, epoch: 1, scopes: [{ scope: `MARKER:${r.scopes[0]!.kind === 'MARKER' ? r.scopes[0]!.markerId : ''}`,
        previousRevision: 2, revision: 3 }] });
    const changed = structuredClone(r); changed.operationId = id();
    expect(invalidationDigest(changed)).not.toBe(invalidationDigest(r));
  });
  it.each([NaN, Infinity, -1, 0.5, 2147483648])('rejects epoch %s', epoch => {
    expect(() => validateInvalidationRequest({ ...request(), epoch })).toThrow();
  });
  it.each(['', 'x', `${randomUUID()}\n`])('rejects malformed identity %j', intentId => {
    expect(() => validateInvalidationRequest({ ...request(), intentId })).toThrow();
  });
  it('rejects duplicate, incomplete and unknown scope shapes', () => {
    const r = request();
    expect(() => validateInvalidationRequest({ ...r, scopes: [r.scopes[0], r.scopes[0]] })).toThrow();
    expect(() => validateInvalidationRequest({ ...r, scopes: [] })).toThrow();
    expect(() => validateInvalidationRequest({ ...r, authority: true })).toThrow();
    expect(() => validateInvalidationRequest({ ...r, scopes: [{ ...r.scopes[0], authority: true }] })).toThrow();
  });
  it('canonicalizes property order without accepting undefined/non-integer values', () => {
    expect(canonicalInvalidationJson({ b: 2, a: 1 })).toBe(canonicalInvalidationJson({ a: 1, b: 2 }));
    for (const value of [undefined, NaN, Infinity, 1.5, new Date()]) expect(() => canonicalInvalidationJson(value)).toThrow();
  });
});
