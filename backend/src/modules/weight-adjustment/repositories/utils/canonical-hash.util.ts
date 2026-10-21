import * as crypto from 'crypto';
import Decimal from 'decimal.js';

/**
 * Produces a deterministic, canonical JSON string representation of an object.
 * - Object keys are sorted alphabetically.
 * - Numbers, Decimals, and Dates are canonicalized to consistent string forms.
 * - Undefined and function values are excluded.
 */
export function canonicalizePayload(val: unknown): unknown {
  if (val === null || val === undefined) {
    return null;
  }
  if (val instanceof Decimal) {
    return val.toString();
  }
  if (val instanceof Date) {
    return val.toISOString();
  }
  if (typeof val === 'number') {
    return Number.isFinite(val) ? val.toString() : null;
  }
  if (Array.isArray(val)) {
    return val.map((item) => canonicalizePayload(item));
  }
  if (typeof val === 'object') {
    const sortedKeys = Object.keys(val as Record<string, unknown>).sort();
    const result: Record<string, unknown> = {};
    for (const key of sortedKeys) {
      const v = (val as Record<string, unknown>)[key];
      if (v !== undefined && typeof v !== 'function') {
        result[key] = canonicalizePayload(v);
      }
    }
    return result;
  }
  return val;
}

/**
 * Computes the SHA-256 hash of a canonically formatted payload.
 */
export function computeCanonicalPayloadHash(payload: unknown): string {
  const canonicalObj = canonicalizePayload(payload);
  const canonicalJson = JSON.stringify(canonicalObj);
  return crypto.createHash('sha256').update(canonicalJson, 'utf8').digest('hex');
}

/**
 * Computes the SHA-256 hash of a single-use random customer approval token.
 * Plaintext approval tokens must NEVER be stored in the database.
 */
export function hashApprovalToken(token: string): string {
  return crypto.createHash('sha256').update(token.trim(), 'utf8').digest('hex');
}
