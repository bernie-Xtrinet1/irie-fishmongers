/**
 * Phase C — Distributed Ordinary Recovery Lock Types & Contracts.
 *
 * Defines the contract for PostgreSQL session-level advisory locking (CHKT, 2),
 * cooperative execution permits, cancellation signals, and lock outcomes.
 */

export const ORDINARY_RECOVERY_LOCK_NAMESPACE = 1128811348; // ASCII 'CHKT'
export const ORDINARY_RECOVERY_LOCK_ID = 2; // Dedicated Ordinary Recovery Lock ID

/**
 * Thrown when PostgreSQL advisory lock ownership is lost during execution.
 */
export class OrdinaryRecoveryOwnershipLost extends Error {
  constructor(message = 'Ordinary recovery distributed lock ownership lost') {
    super(message);
    this.name = 'OrdinaryRecoveryOwnershipLost';
  }
}

/**
 * Thrown when lock release or connection disposal fails after execution.
 */
export class OrdinaryRecoveryLockCleanupError extends Error {
  constructor(
    message: string,
    public readonly causeError?: unknown,
  ) {
    super(message);
    this.name = 'OrdinaryRecoveryLockCleanupError';
  }
}

/**
 * Cooperative execution permit granted to recovery coordinator and child workers.
 */
export interface OrdinaryRecoveryExecutionPermit {
  readonly signal: AbortSignal;
  readonly ownerPid: number;
  readonly acquisitionId: string;

  /**
   * Asserts that the dedicated PostgreSQL session still holds the granted advisory lock.
   * Throws OrdinaryRecoveryOwnershipLost if the session died, PID changed, or lock was lost.
   */
  assertHeld(): Promise<void>;
}

export type OrdinaryRecoveryLockOutcome<T> =
  | {
      readonly status: 'EXECUTED';
      readonly value: T;
    }
  | {
      readonly status: 'LOCK_BUSY';
    };

export interface IOrdinaryRecoveryLockService {
  withExclusiveLock<T>(
    operation: (permit: OrdinaryRecoveryExecutionPermit) => Promise<T>,
  ): Promise<OrdinaryRecoveryLockOutcome<T>>;
}
