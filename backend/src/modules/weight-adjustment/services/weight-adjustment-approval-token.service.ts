import { Injectable } from '@nestjs/common';
import { ApprovalChallengeStatus, CustomerWeightApprovalChallenge } from '@prisma/client';
import { randomBytes, timingSafeEqual } from 'crypto';
import Decimal from 'decimal.js';

import {
  ChallengeAlreadyConsumedError,
  ChallengeExpiredError,
  ChallengeRevokedError,
  CustomerApprovalMismatchError,
  CustomerApprovalRevisionMismatchError,
  InvalidApprovalTokenError,
} from '../repositories/errors/weight-adjustment-repository.errors';
import {
  ChallengeValidationResult,
  ValidateChallengeContext,
} from '../repositories/types/weight-adjustment-repository.types';
import { hashApprovalToken } from '../repositories/utils/canonical-hash.util';

export type ClockFn = () => Date;

export const DEFAULT_CHALLENGE_TTL_MS = 15 * 60 * 1000; // 15 minutes

@Injectable()
export class WeightAdjustmentApprovalTokenService {
  private readonly clock: ClockFn;

  constructor(clock?: ClockFn) {
    this.clock = clock ?? (() => new Date());
  }

  /**
   * Generates a cryptographically random, high-entropy challenge token (256 bits).
   * Returns:
   * - rawToken: The single-use plaintext secret (to be transmitted strictly to the customer).
   * - approvalTokenHash: Deterministic SHA-256 hash for database storage.
   * - expiresAt: Exact timestamp 15 minutes in the future according to the controlled clock.
   *
   * Invariant: Plaintext rawToken is NEVER logged or stored internally.
   */
  generateChallengeToken(customTtlMs?: number): {
    rawToken: string;
    approvalTokenHash: string;
    expiresAt: Date;
  } {
    // 32 bytes = 256 bits of cryptographic entropy
    const rawToken = randomBytes(32).toString('hex');
    const approvalTokenHash = this.hashToken(rawToken);
    const ttl = customTtlMs ?? DEFAULT_CHALLENGE_TTL_MS;
    const expiresAt = new Date(this.clock().getTime() + ttl);

    return {
      rawToken,
      approvalTokenHash,
      expiresAt,
    };
  }

  /**
   * Hashes a raw token using deterministic SHA-256.
   */
  hashToken(rawToken: string): string {
    if (!this.isValidRawTokenFormat(rawToken)) {
      throw new InvalidApprovalTokenError('Token must be a 64-character hexadecimal string.');
    }
    return hashApprovalToken(rawToken);
  }

  /**
   * Validates raw token format (must be 64 hex characters representing 256 bits).
   */
  isValidRawTokenFormat(rawToken: unknown): rawToken is string {
    if (typeof rawToken !== 'string') return false;
    return /^[a-fA-F0-9]{64}$/.test(rawToken);
  }

  /**
   * Performs constant-time comparison of two hex hashes to prevent timing attacks.
   */
  verifyTokenHash(rawToken: string, expectedHash: string): boolean {
    if (!this.isValidRawTokenFormat(rawToken) || !/^[a-fA-F0-9]{64}$/.test(expectedHash)) {
      return false;
    }

    const computedHash = hashApprovalToken(rawToken);
    const bufA = Buffer.from(computedHash, 'hex');
    const bufB = Buffer.from(expectedHash, 'hex');

    if (bufA.length !== bufB.length) return false;
    return timingSafeEqual(bufA, bufB);
  }

  /**
   * Validates whether an approval challenge satisfies all authoritative security invariants:
   * 1. Status is OPEN (not CONSUMED, REVOKED, or EXPIRED).
   * 2. Expiry timestamp has not elapsed.
   * 3. Revision strictly matches active measurement revision.
   * 4. Authenticated customer matches.
   * 5. Proposed amount and authorized ceiling match.
   * 6. Token hash matches via constant-time comparison (if rawToken provided).
   */
  evaluateChallengeValidity(
    challenge: CustomerWeightApprovalChallenge,
    context: ValidateChallengeContext,
  ): ChallengeValidationResult {
    const now = this.clock();

    // 1. Check lifecycle status
    if (challenge.status === ApprovalChallengeStatus.CONSUMED) {
      return {
        isValid: false,
        reason: 'CHALLENGE_ALREADY_CONSUMED',
        message: `Challenge "${challenge.id}" has already been consumed.`,
      };
    }

    if (challenge.status === ApprovalChallengeStatus.REVOKED) {
      return {
        isValid: false,
        reason: 'CHALLENGE_REVOKED',
        message: `Challenge "${challenge.id}" has been revoked: ${challenge.revocationReason ?? 'superseded'}.`,
      };
    }

    if (challenge.status === ApprovalChallengeStatus.EXPIRED || now.getTime() > challenge.expiresAt.getTime()) {
      return {
        isValid: false,
        reason: 'CHALLENGE_EXPIRED',
        message: `Challenge "${challenge.id}" expired at ${challenge.expiresAt.toISOString()}.`,
      };
    }

    // 2. Check measurement revision binding
    if (challenge.measurementRevision !== context.activeMeasurementRevision) {
      return {
        isValid: false,
        reason: 'STALE_MEASUREMENT_REVISION',
        message: `Challenge revision ${challenge.measurementRevision} does not match active measurement revision ${context.activeMeasurementRevision}.`,
      };
    }

    // 3. Check customer ownership
    if (challenge.authenticatedCustomerId !== context.authenticatedCustomerId) {
      return {
        isValid: false,
        reason: 'CUSTOMER_MISMATCH',
        message: 'Challenge customer does not match authenticated customer.',
      };
    }

    // 4. Check proposed total amount
    const challengeTotal = new Decimal(challenge.proposedTotalJmd.toString());
    const contextTotal = new Decimal(context.proposedTotalJmd.toString());
    if (!challengeTotal.equals(contextTotal)) {
      return {
        isValid: false,
        reason: 'AMOUNT_MISMATCH',
        message: `Challenge proposed total JMD ${challengeTotal.toFixed(2)} does not match expected total JMD ${contextTotal.toFixed(2)}.`,
      };
    }

    // 5. Check authorized ceiling amount
    const challengeCeiling = new Decimal(challenge.authorizedCeilingJmd.toString());
    const contextCeiling = new Decimal(context.authorizedCeilingJmd.toString());
    if (!challengeCeiling.equals(contextCeiling)) {
      return {
        isValid: false,
        reason: 'CEILING_MISMATCH',
        message: `Challenge authorized ceiling JMD ${challengeCeiling.toFixed(2)} does not match expected ceiling JMD ${contextCeiling.toFixed(2)}.`,
      };
    }

    // 6. Check token hash (if provided)
    if (context.rawToken !== undefined) {
      if (!this.verifyTokenHash(context.rawToken, challenge.approvalTokenHash)) {
        return {
          isValid: false,
          reason: 'INVALID_TOKEN',
          message: 'Provided token hash does not match challenge token hash.',
        };
      }
    }

    return { isValid: true, reason: 'VALID' };
  }

  /**
   * Asserts validity, throwing explicit typed domain errors if validation fails.
   */
  assertChallengeValid(
    challenge: CustomerWeightApprovalChallenge,
    context: ValidateChallengeContext,
  ): void {
    const result = this.evaluateChallengeValidity(challenge, context);
    if (result.isValid) return;

    switch (result.reason) {
      case 'CHALLENGE_ALREADY_CONSUMED':
        throw new ChallengeAlreadyConsumedError(challenge.id, challenge.consumedAt);
      case 'CHALLENGE_REVOKED':
        throw new ChallengeRevokedError(challenge.id, challenge.revocationReason ?? undefined);
      case 'CHALLENGE_EXPIRED':
        throw new ChallengeExpiredError(challenge.id, challenge.expiresAt);
      case 'STALE_MEASUREMENT_REVISION':
        throw new CustomerApprovalRevisionMismatchError(
          challenge.weightAdjustmentId,
          challenge.measurementRevision,
          context.activeMeasurementRevision,
        );
      case 'CUSTOMER_MISMATCH':
      case 'AMOUNT_MISMATCH':
      case 'CEILING_MISMATCH':
        throw new CustomerApprovalMismatchError(result.message ?? 'Challenge parameters do not match.');
      case 'INVALID_TOKEN':
      default:
        throw new InvalidApprovalTokenError(result.message);
    }
  }

  /**
   * Helper to retrieve current time from the configured clock abstraction.
   */
  now(): Date {
    return this.clock();
  }
}
