import { createHash } from 'crypto';
import { OrdinaryOwnerState } from '@prisma/client';
import { FenceTuple, isFenceTuple, MAX_FENCE_COUNTER, UUID_PATTERN } from './reservation-fence.types';

// Inactive protocol. Rejection revisions are not reservation generations.
export type InvalidationStatus = 'PREPARED' | 'BARRIER_CONFIRMED' | 'PUBLISHED' | 'SUPERSEDED';
export interface MarkerPublicationState {
  generation: number;
  mutationVersion: number;
  quantity: number | null;
}
export interface CartPublicationState { id: string; mutationVersion: number; quantity: number }
export interface OwnerPublicationState { id: string; state: OrdinaryOwnerState }
export interface MarkerInvalidationScope {
  kind: 'MARKER';
  markerId: string;
  customerId: string;
  cartId: string;
  productId: string;
  revision: number;
  before: MarkerPublicationState;
  after: MarkerPublicationState;
  cartBefore: CartPublicationState | null;
  cartAfter: CartPublicationState | null;
  ownersBefore: OwnerPublicationState[];
  ownersAfter: OwnerPublicationState[];
}
export interface GlobalInvalidationScope {
  kind: 'GLOBAL';
  revision: number;
  before: FenceTuple;
  after: FenceTuple;
  modeBefore: { mode: 'LEGACY' | 'MIRROR' | 'CART_SCOPED' | 'DRAINING'; revision: number | null };
  // This gate authorizes restriction only, never activation, retirement or reopening.
  modeAfter: 'DRAINING' | null;
}
export type InvalidationScope = MarkerInvalidationScope | GlobalInvalidationScope;
export interface InvalidationRequest {
  version: 1;
  intentId: string;
  operationId: string;
  kind: 'CART' | 'OWNER' | 'FENCE' | 'MODE';
  incarnation: string;
  epoch: number;
  scopes: InvalidationScope[];
}
export interface OrdinaryBarrierBinding {
  version: 1;
  commandId: string;
  replayId: string;
  markerId: string;
  globalRevision: number;
  markerRevision: number;
  incarnation: string;
  epoch: number;
}
export interface BarrierScope {
  scope: string;
  previousRevision: number;
  revision: number;
}
export interface BarrierAcknowledgement {
  version: 1;
  intentId: string;
  digest: string;
  incarnation: string;
  epoch: number;
  scopes: BarrierScope[];
}
export const invalidationScopeKey = (scope: InvalidationScope): string => scope.kind === 'GLOBAL' ? 'GLOBAL' : `MARKER:${scope.markerId}`;
export const invalidationRedisKey = (scope: string): string => `reservation:fence:ordinary-invalidation:${scope}`;

export function canonicalInvalidationJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isSafeInteger(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalInvalidationJson).join(',')}]`;
  if (typeof value === 'object' && value && (Object.getPrototypeOf(value) === null
    || Object.getPrototypeOf(Object.getPrototypeOf(value)) === null)) {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonicalInvalidationJson(object[key])}`).join(',')}}`;
  }
  throw new Error('INVALID_INVALIDATION_VALUE');
}
export const invalidationDigest = (value: unknown): string => createHash('sha256').update(canonicalInvalidationJson(value)).digest('hex');

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const exact = (value: unknown, keys: string): value is Record<string, unknown> =>
  record(value) && Object.keys(value).sort().join(',') === keys.split(',').sort().join(',');
const uuid = (value: unknown): value is string => typeof value === 'string' && value.length === 36 && UUID_PATTERN.test(value);
const counter = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX_FENCE_COUNTER;
function markerState(value: unknown): boolean {
  return exact(value, 'generation,mutationVersion,quantity') && counter(value.generation) && counter(value.mutationVersion)
    && (value.quantity === null || (counter(value.quantity) && value.quantity > 0));
}
function cartState(value: unknown): boolean {
  return value === null || (exact(value, 'id,mutationVersion,quantity') && uuid(value.id)
    && counter(value.mutationVersion) && counter(value.quantity) && value.quantity > 0);
}
function owners(value: unknown): boolean {
  if (!Array.isArray(value) || value.length > 100) return false;
  const values: unknown[] = value;
  let previous: string | null = null;
  for (const owner of values) {
    if (!exact(owner, 'id,state') || !uuid(owner.id) || typeof owner.state !== 'string'
      || !Object.values(OrdinaryOwnerState).some(state => state === owner.state)
      || (previous !== null && previous >= owner.id)) return false;
    previous = owner.id;
  }
  return true;
}
export function validateInvalidationRequest(value: unknown): asserts value is InvalidationRequest {
  if (!exact(value, 'version,intentId,operationId,kind,incarnation,epoch,scopes') || value.version !== 1
    || !uuid(value.intentId) || !uuid(value.operationId) || !uuid(value.incarnation)
    || !counter(value.epoch) || value.epoch < 1 || !['CART', 'OWNER', 'FENCE', 'MODE'].includes(String(value.kind))
    || !Array.isArray(value.scopes) || value.scopes.length < 1 || value.scopes.length > 100)
    throw new Error('INVALID_INVALIDATION_REQUEST');
  const keys: string[] = [];
  const scopes: unknown[] = value.scopes;
  for (const scope of scopes) {
    if (!record(scope)
      || !counter(scope.revision) || scope.revision === MAX_FENCE_COUNTER) throw new Error('INVALID_SCOPE_REVISION');
    if (scope.kind === 'MARKER') {
      if (!exact(scope, 'kind,markerId,customerId,cartId,productId,revision,before,after,cartBefore,cartAfter,ownersBefore,ownersAfter')
        || ![scope.markerId, scope.customerId, scope.cartId, scope.productId].every(uuid)
        || !markerState(scope.before) || !markerState(scope.after) || !cartState(scope.cartBefore) || !cartState(scope.cartAfter)
        || !owners(scope.ownersBefore) || !owners(scope.ownersAfter)) throw new Error('INVALID_MARKER_SCOPE');
      keys.push(`MARKER:${String(scope.markerId)}`);
    } else if (scope.kind === 'GLOBAL') {
      if (!exact(scope, 'kind,revision,before,after,modeBefore,modeAfter') || !isFenceTuple(scope.before) || !isFenceTuple(scope.after)
        || !exact(scope.modeBefore, 'mode,revision') || !['LEGACY', 'MIRROR', 'CART_SCOPED', 'DRAINING'].includes(String(scope.modeBefore.mode))
        || !(scope.modeBefore.revision === null || counter(scope.modeBefore.revision))
        || !(scope.modeAfter === null || scope.modeAfter === 'DRAINING')) throw new Error('INVALID_GLOBAL_SCOPE');
      keys.push('GLOBAL');
    } else throw new Error('INVALID_SCOPE');
  }
  if (new Set(keys).size !== keys.length || keys.some((key, index) => index > 0 && keys[index - 1]! >= key))
    throw new Error('UNSORTED_OR_DUPLICATE_SCOPES');
  canonicalInvalidationJson(value);
}

export function barrierAcknowledgement(request: InvalidationRequest): BarrierAcknowledgement {
  validateInvalidationRequest(request);
  return { version: 1, intentId: request.intentId, digest: invalidationDigest(request), incarnation: request.incarnation,
    epoch: request.epoch, scopes: request.scopes.map(scope => ({ scope: invalidationScopeKey(scope),
      previousRevision: scope.revision, revision: scope.revision + 1 })) };
}
