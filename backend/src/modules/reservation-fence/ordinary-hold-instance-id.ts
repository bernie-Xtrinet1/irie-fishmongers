import { createHash } from 'crypto';
import { UUID_PATTERN } from './types/reservation-fence.types';

// UUIDv5 DNS namespace, in network byte order. The versioned name prefix is
// part of the persisted identity contract: never change it for existing holds.
const NAMESPACE = Buffer.from('6ba7b8109dad11d180b400c04fd430c8', 'hex');
const NAME_PREFIX = 'iriefishmongers:ordinary-reservation:v1:';

// Identity only, not authorization. Callers must separately prove durable
// ownership, current generation and fence/capability authority. Foundation only:
// existing writers and checkout acquisition do not yet call this function.
export function ordinaryHoldInstanceId(markerId: string, generation: number): string {
  if (typeof markerId !== 'string' || markerId.length !== 36 || !UUID_PATTERN.test(markerId))
    throw new Error('INVALID_RESERVATION_MARKER_ID');
  // Matches PostgreSQL Int generation semantics, including the initial zero.
  if (!Number.isInteger(generation) || generation < 0 || generation > 2147483647)
    throw new Error('INVALID_RESERVATION_GENERATION');

  const bytes = createHash('sha1').update(NAMESPACE)
    .update(`${NAME_PREFIX}${markerId}:${generation}`, 'utf8').digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
