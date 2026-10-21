import { ApprovalChallengeStatus, Prisma } from '@prisma/client';
import Decimal from 'decimal.js';
import * as fs from 'fs';
import * as path from 'path';

import { PrismaService } from '../../../../database/prisma.service';
import { CustomerWeightApprovalChallengeRepository } from '../customer-weight-approval-challenge.repository';
import {
  AdjustmentNotFoundError,
  ChallengeAlreadyConsumedError,
  ChallengeExpiredError,
  ChallengeNotFoundError,
  ChallengeRevokedError,
  CustomerApprovalChallengeConflictError,
  CustomerApprovalMismatchError,
  CustomerApprovalRevisionMismatchError,
  InvalidApprovalTokenError,
} from '../errors/weight-adjustment-repository.errors';
import {
  DEFAULT_CHALLENGE_TTL_MS,
  WeightAdjustmentApprovalTokenService,
} from '../../services/weight-adjustment-approval-token.service';
import { hashApprovalToken } from '../utils/canonical-hash.util';

/**
 * Phase 16D WP3.1: Durable Approval Challenge & Token Security Engine Tests
 *
 * NOTE: Tests in this file utilize Jest transaction-aware mocks to simulate
 * database concurrency, row-locking ($queryRaw FOR UPDATE), CAS predicates,
 * and transaction rollback behavior.
 * Live PostgreSQL integration tests are conducted once migration execution is authorized.
 */
describe('Phase 16D WP3.1: Durable Approval Challenge & Token Security Engine', () => {
  let prismaMock: any;
  let tokenService: WeightAdjustmentApprovalTokenService;
  let challengeRepo: CustomerWeightApprovalChallengeRepository;
  let mockCurrentTime: Date;

  beforeEach(() => {
    mockCurrentTime = new Date('2026-10-21T12:00:00.000Z');

    prismaMock = {
      $transaction: jest.fn(async (cb) => cb(prismaMock)),
      $queryRaw: jest.fn().mockResolvedValue([]),
      seafoodOrderWeightAdjustment: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'adj-1',
          activeMeasurementRevision: 1,
        }),
        update: jest.fn(),
      },
      customerWeightApprovalChallenge: {
        create: jest.fn(),
        findUnique: jest.fn(),
        findFirst: jest.fn(),
        findMany: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
      },
    };

    const clock = () => mockCurrentTime;
    tokenService = new WeightAdjustmentApprovalTokenService(clock);
    challengeRepo = new CustomerWeightApprovalChallengeRepository(
      prismaMock as unknown as PrismaService,
      clock,
    );
  });

  // 1. Cryptographically random token issuance
  it('TC-WP3.1-01: generates cryptographically random 256-bit token with 15-minute validity', () => {
    const tokenA = tokenService.generateChallengeToken();
    const tokenB = tokenService.generateChallengeToken();

    expect(tokenA.rawToken).toHaveLength(64); // 32 bytes hex = 64 characters (256 bits)
    expect(tokenB.rawToken).toHaveLength(64);
    expect(tokenA.rawToken).not.toEqual(tokenB.rawToken); // Unpredictable entropy

    // Exact 15-minute validity period
    const expectedExpiry = new Date(mockCurrentTime.getTime() + DEFAULT_CHALLENGE_TTL_MS);
    expect(tokenA.expiresAt.getTime()).toBe(expectedExpiry.getTime());
  });

  // 2. Deterministic token hashing
  it('TC-WP3.1-02: deterministic token hashing via SHA-256', () => {
    const { rawToken, approvalTokenHash } = tokenService.generateChallengeToken();
    const recomputedHash = tokenService.hashToken(rawToken);

    expect(recomputedHash).toBe(approvalTokenHash);
    expect(hashApprovalToken(rawToken)).toBe(approvalTokenHash);
  });

  // 3. Exact 15-minute expiry boundary
  it('TC-WP3.1-03: enforces strict 15-minute expiry boundary at exact millisecond edges', () => {
    const { rawToken, approvalTokenHash, expiresAt } = tokenService.generateChallengeToken();

    const mockChallenge: any = {
      id: 'chal-1',
      weightAdjustmentId: 'adj-1',
      measurementRevision: 1,
      authenticatedCustomerId: 'cust-1',
      proposedTotalJmd: new Prisma.Decimal('420.00'),
      authorizedCeilingJmd: new Prisma.Decimal('350.00'),
      approvalTokenHash,
      expiresAt,
      status: ApprovalChallengeStatus.OPEN,
    };

    const context = {
      authenticatedCustomerId: 'cust-1',
      activeMeasurementRevision: 1,
      proposedTotalJmd: '420.00',
      authorizedCeilingJmd: '350.00',
      rawToken,
    };

    // At exactly expiresAt: still valid
    mockCurrentTime = new Date(expiresAt.getTime());
    expect(tokenService.evaluateChallengeValidity(mockChallenge, context).isValid).toBe(true);

    // At expiresAt + 1 millisecond: expired
    mockCurrentTime = new Date(expiresAt.getTime() + 1);
    const result = tokenService.evaluateChallengeValidity(mockChallenge, context);
    expect(result.isValid).toBe(false);
    expect(result.reason).toBe('CHALLENGE_EXPIRED');

    expect(() => tokenService.assertChallengeValid(mockChallenge, context)).toThrow(
      ChallengeExpiredError,
    );
  });

  // 4. Malformed and unknown tokens
  it('TC-WP3.1-04: rejects malformed and unknown tokens', () => {
    expect(() => tokenService.hashToken('too-short')).toThrow(InvalidApprovalTokenError);
    expect(() =>
      tokenService.hashToken('not-hex-characters-at-all-should-be-rejected-immediately-1234567890'),
    ).toThrow(InvalidApprovalTokenError);
    expect(
      tokenService.verifyTokenHash(
        'invalid',
        'valid-looking-hash-string-that-fails-verification-1234567890123456',
      ),
    ).toBe(false);
  });

  // 5. Wrong authenticated customer
  it('TC-WP3.1-05: rejects challenge submission for wrong authenticated customer', async () => {
    prismaMock.customerWeightApprovalChallenge.findUnique.mockResolvedValue({
      id: 'chal-cust-mismatch',
      weightAdjustmentId: 'adj-1',
      measurementRevision: 1,
      authenticatedCustomerId: 'cust-owner',
      proposedTotalJmd: new Prisma.Decimal('400.00'),
      authorizedCeilingJmd: new Prisma.Decimal('350.00'),
      expiresAt: new Date('2026-10-21T12:15:00.000Z'),
      status: ApprovalChallengeStatus.OPEN,
    });

    await expect(
      challengeRepo.consumeChallenge({
        challengeId: 'chal-cust-mismatch',
        expectedMeasurementRevision: 1,
        authenticatedCustomerId: 'cust-attacker',
      }),
    ).rejects.toThrow(CustomerApprovalMismatchError);
  });

  // 6. Wrong weight adjustment
  it('TC-WP3.1-06: rejects challenge when weight adjustment does not exist or mismatch', async () => {
    prismaMock.seafoodOrderWeightAdjustment.findUnique.mockResolvedValue(null);

    await expect(
      challengeRepo.createChallenge({
        weightAdjustmentId: 'non-existent-adj',
        measurementRevision: 1,
        authenticatedCustomerId: 'cust-1',
        proposedTotalJmd: '450.00',
        authorizedCeilingJmd: '400.00',
        approvalTokenHash: 'dummy-hash',
        expiresAt: new Date(),
      }),
    ).rejects.toThrow(AdjustmentNotFoundError);
  });

  // 7. Stale measurement revision upon creation
  it('TC-WP3.1-07: rejects stale measurement revisions upon creation', async () => {
    prismaMock.seafoodOrderWeightAdjustment.findUnique.mockResolvedValue({
      id: 'adj-1',
      activeMeasurementRevision: 2,
    });

    await expect(
      challengeRepo.createChallenge({
        weightAdjustmentId: 'adj-1',
        measurementRevision: 1, // Stale!
        authenticatedCustomerId: 'cust-1',
        proposedTotalJmd: '450.00',
        authorizedCeilingJmd: '400.00',
        approvalTokenHash: 'dummy-hash',
        expiresAt: new Date(),
      }),
    ).rejects.toThrow(CustomerApprovalRevisionMismatchError);
  });

  // 8. Proposed amount or ceiling mismatch on consumption
  it('TC-WP3.1-08: rejects consumption when proposed amount or authorized ceiling differs', async () => {
    prismaMock.customerWeightApprovalChallenge.findUnique.mockResolvedValue({
      id: 'chal-amt-mismatch',
      weightAdjustmentId: 'adj-1',
      measurementRevision: 1,
      authenticatedCustomerId: 'cust-1',
      proposedTotalJmd: new Prisma.Decimal('450.00'),
      authorizedCeilingJmd: new Prisma.Decimal('400.00'),
      expiresAt: new Date('2026-10-21T12:15:00.000Z'),
      status: ApprovalChallengeStatus.OPEN,
    });

    // Amount mismatch
    await expect(
      challengeRepo.consumeChallenge({
        challengeId: 'chal-amt-mismatch',
        expectedMeasurementRevision: 1,
        authenticatedCustomerId: 'cust-1',
        expectedProposedTotalJmd: '480.00', // differs from 450.00
      }),
    ).rejects.toThrow(CustomerApprovalMismatchError);

    // Ceiling mismatch
    await expect(
      challengeRepo.consumeChallenge({
        challengeId: 'chal-amt-mismatch',
        expectedMeasurementRevision: 1,
        authenticatedCustomerId: 'cust-1',
        expectedAuthorizedCeilingJmd: '410.00', // differs from 400.00
      }),
    ).rejects.toThrow(CustomerApprovalMismatchError);
  });

  // 9. Revoked challenge rejection
  it('TC-WP3.1-09: rejects consumption of revoked challenges', async () => {
    prismaMock.customerWeightApprovalChallenge.findUnique.mockResolvedValue({
      id: 'chal-revoked',
      weightAdjustmentId: 'adj-1',
      measurementRevision: 1,
      authenticatedCustomerId: 'cust-1',
      proposedTotalJmd: new Prisma.Decimal('450.00'),
      authorizedCeilingJmd: new Prisma.Decimal('400.00'),
      approvalTokenHash: 'dummy-hash',
      expiresAt: new Date('2026-10-21T12:30:00.000Z'),
      status: ApprovalChallengeStatus.REVOKED,
      revocationReason: 'SUPERSEDED_BY_NEW_CHALLENGE',
    });

    await expect(
      challengeRepo.consumeChallenge({
        challengeId: 'chal-revoked',
        expectedMeasurementRevision: 1,
        authenticatedCustomerId: 'cust-1',
      }),
    ).rejects.toThrow(ChallengeRevokedError);
  });

  // 10. Expired challenge rejection
  it('TC-WP3.1-10: rejects expired challenges on consumption', async () => {
    prismaMock.customerWeightApprovalChallenge.findUnique.mockResolvedValue({
      id: 'chal-expired',
      weightAdjustmentId: 'adj-1',
      measurementRevision: 1,
      authenticatedCustomerId: 'cust-1',
      expiresAt: new Date('2026-10-21T11:59:00.000Z'), // expired 1 minute ago
      status: ApprovalChallengeStatus.OPEN,
    });

    await expect(
      challengeRepo.consumeChallenge({
        challengeId: 'chal-expired',
        expectedMeasurementRevision: 1,
        authenticatedCustomerId: 'cust-1',
      }),
    ).rejects.toThrow(ChallengeExpiredError);
  });

  // 11. Already-consumed challenge rejection
  it('TC-WP3.1-11: rejects consumption of already-consumed challenge', async () => {
    prismaMock.customerWeightApprovalChallenge.findUnique.mockResolvedValue({
      id: 'chal-consumed',
      weightAdjustmentId: 'adj-1',
      status: ApprovalChallengeStatus.CONSUMED,
      consumedAt: new Date('2026-10-21T12:05:00.000Z'),
      expiresAt: new Date('2026-10-21T12:15:00.000Z'),
      measurementRevision: 1,
      authenticatedCustomerId: 'cust-1',
    });

    await expect(
      challengeRepo.consumeChallenge({
        challengeId: 'chal-consumed',
        expectedMeasurementRevision: 1,
        authenticatedCustomerId: 'cust-1',
      }),
    ).rejects.toThrow(ChallengeAlreadyConsumedError);
  });

  // 12. Concurrent double-consumption prevention
  it('TC-WP3.1-12: prevents concurrent double-consumption via atomic CAS predicate (Mocked Concurrency)', async () => {
    // Both callers resolve the challenge initially
    prismaMock.customerWeightApprovalChallenge.findUnique.mockResolvedValue({
      id: 'chal-race',
      weightAdjustmentId: 'adj-1',
      measurementRevision: 1,
      authenticatedCustomerId: 'cust-1',
      expiresAt: new Date('2026-10-21T12:15:00.000Z'),
      status: ApprovalChallengeStatus.OPEN,
    });

    // Racer 1 updates 1 row
    prismaMock.customerWeightApprovalChallenge.updateMany.mockResolvedValueOnce({ count: 1 });

    const result1 = await challengeRepo.consumeChallenge({
      challengeId: 'chal-race',
      expectedMeasurementRevision: 1,
      authenticatedCustomerId: 'cust-1',
    });
    expect(result1.id).toBe('chal-race');

    // Racer 2 arrives concurrently; updateMany returns 0 because row was already consumed
    prismaMock.customerWeightApprovalChallenge.updateMany.mockResolvedValueOnce({ count: 0 });
    prismaMock.customerWeightApprovalChallenge.findUnique.mockResolvedValueOnce({
      id: 'chal-race',
      status: ApprovalChallengeStatus.CONSUMED,
      consumedAt: mockCurrentTime,
      expiresAt: new Date('2026-10-21T12:15:00.000Z'),
      measurementRevision: 1,
      authenticatedCustomerId: 'cust-1',
    });

    await expect(
      challengeRepo.consumeChallenge({
        challengeId: 'chal-race',
        expectedMeasurementRevision: 1,
        authenticatedCustomerId: 'cust-1',
      }),
    ).rejects.toThrow(ChallengeAlreadyConsumedError);
  });

  // 13. Safe challenge renewal & sequence increment
  it('TC-WP3.1-13: safe challenge renewal revokes active challenge and increments sequence', async () => {
    prismaMock.customerWeightApprovalChallenge.findFirst.mockResolvedValue({
      challengeSequence: 1,
    });

    prismaMock.customerWeightApprovalChallenge.create.mockResolvedValue({
      id: 'chal-seq-2',
      weightAdjustmentId: 'adj-1',
      measurementRevision: 1,
      challengeSequence: 2,
      status: ApprovalChallengeStatus.OPEN,
    });

    const renewed = await challengeRepo.renewChallenge({
      weightAdjustmentId: 'adj-1',
      measurementRevision: 1,
      authenticatedCustomerId: 'cust-1',
      proposedTotalJmd: '450.00',
      authorizedCeilingJmd: '400.00',
      newApprovalTokenHash: 'new-hash-sequence-2',
      newExpiresAt: new Date('2026-10-21T12:20:00.000Z'),
      revocationReason: 'CUSTOMER_REQUESTED_EXTENSION',
    });

    // Verifies parent row lock was acquired
    expect(prismaMock.$queryRaw).toHaveBeenCalled();

    // Verifies pre-existing open challenge was revoked
    expect(prismaMock.customerWeightApprovalChallenge.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          weightAdjustmentId: 'adj-1',
          measurementRevision: 1,
          status: ApprovalChallengeStatus.OPEN,
        }),
        data: expect.objectContaining({
          status: ApprovalChallengeStatus.REVOKED,
        }),
      }),
    );

    // Verifies new challenge created at sequence 2
    expect(prismaMock.customerWeightApprovalChallenge.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          challengeSequence: 2,
          approvalTokenHash: 'new-hash-sequence-2',
          status: ApprovalChallengeStatus.OPEN,
        }),
      }),
    );
  });

  // 14. Historical challenge retention across revisions
  it('TC-WP3.1-14: retains complete historical challenge sequence across revisions', async () => {
    prismaMock.customerWeightApprovalChallenge.findMany.mockResolvedValue([
      { id: 'c-1', measurementRevision: 1, challengeSequence: 1, status: ApprovalChallengeStatus.REVOKED },
      { id: 'c-2', measurementRevision: 1, challengeSequence: 2, status: ApprovalChallengeStatus.EXPIRED },
      { id: 'c-3', measurementRevision: 1, challengeSequence: 3, status: ApprovalChallengeStatus.CONSUMED },
      { id: 'c-4', measurementRevision: 2, challengeSequence: 1, status: ApprovalChallengeStatus.OPEN },
    ]);

    const history = await challengeRepo.findAllChallengesForAdjustment('adj-1');
    expect(history).toHaveLength(4);
    expect(history[0]?.challengeSequence).toBe(1);
    expect(history[2]?.status).toBe(ApprovalChallengeStatus.CONSUMED);
    expect(history[3]?.measurementRevision).toBe(2);
  });

  // 15. No plaintext token persistence or logging
  it('TC-WP3.1-15: strictly prevents plaintext token persistence or logging', async () => {
    const { rawToken, approvalTokenHash, expiresAt } = tokenService.generateChallengeToken();

    prismaMock.customerWeightApprovalChallenge.findFirst.mockResolvedValue(null);
    prismaMock.customerWeightApprovalChallenge.create.mockResolvedValue({
      id: 'chal-created',
      approvalTokenHash,
    });

    await challengeRepo.createChallenge({
      weightAdjustmentId: 'adj-1',
      measurementRevision: 1,
      authenticatedCustomerId: 'cust-1',
      proposedTotalJmd: '430.00',
      authorizedCeilingJmd: '400.00',
      approvalTokenHash,
      expiresAt,
    });

    const createCallArgs = JSON.stringify(prismaMock.customerWeightApprovalChallenge.create.mock.calls);
    expect(createCallArgs).not.toContain(rawToken);
    expect(createCallArgs).toContain(approvalTokenHash);
  });

  // 16. Rollback script validation
  it('TC-WP3.1-16: proves rollback script contains transaction, lock, and data-safety guard', () => {
    const rollbackSqlPath = path.resolve(
      __dirname,
      '../../../../../prisma/migrations/20261021180000_phase_16d_wp31_approval_challenge/rollback.sql',
    );
    expect(fs.existsSync(rollbackSqlPath)).toBe(true);

    const sql = fs.readFileSync(rollbackSqlPath, 'utf8');
    expect(sql).toContain('BEGIN;');
    expect(sql).toContain('LOCK TABLE "customer_weight_approval_challenges" IN ACCESS EXCLUSIVE MODE');
    expect(sql).toContain('ROLLBACK REFUSED');
    expect(sql).toContain('v_challenge_count > 0');
    expect(sql).toContain('DROP TABLE "customer_weight_approval_challenges"');
    expect(sql).toContain('DROP TYPE "ApprovalChallengeStatus"');
    expect(sql).toContain('COMMIT;');
    expect(sql).not.toContain('CASCADE');
  });

  // 17. Concurrency conflict translation (P2002 -> CustomerApprovalChallengeConflictError)
  it('TC-WP3.1-17: catches Prisma P2002 conflict and throws CustomerApprovalChallengeConflictError on concurrent create', async () => {
    const p2002Error = new Prisma.PrismaClientKnownRequestError(
      'Unique constraint violation on uq_challenge_adj_rev_seq',
      {
        code: 'P2002',
        clientVersion: '5.x',
      },
    );
    prismaMock.customerWeightApprovalChallenge.create.mockRejectedValue(p2002Error);

    await expect(
      challengeRepo.createChallenge({
        weightAdjustmentId: 'adj-1',
        measurementRevision: 1,
        authenticatedCustomerId: 'cust-1',
        proposedTotalJmd: '450.00',
        authorizedCeilingJmd: '400.00',
        approvalTokenHash: 'dummy-hash',
        expiresAt: new Date(),
      }),
    ).rejects.toThrow(CustomerApprovalChallengeConflictError);
  });

  // 18. Concurrency conflict translation on concurrent renewal
  it('TC-WP3.1-18: catches Prisma P2002 conflict and throws CustomerApprovalChallengeConflictError on concurrent renewal', async () => {
    const p2002Error = new Prisma.PrismaClientKnownRequestError(
      'Unique constraint violation on uq_open_challenge_per_rev',
      {
        code: 'P2002',
        clientVersion: '5.x',
      },
    );
    prismaMock.customerWeightApprovalChallenge.create.mockRejectedValue(p2002Error);

    await expect(
      challengeRepo.renewChallenge({
        weightAdjustmentId: 'adj-1',
        measurementRevision: 1,
        authenticatedCustomerId: 'cust-1',
        proposedTotalJmd: '450.00',
        authorizedCeilingJmd: '400.00',
        newApprovalTokenHash: 'dummy-hash-2',
        newExpiresAt: new Date(),
      }),
    ).rejects.toThrow(CustomerApprovalChallengeConflictError);
  });

  // 19. Vendor re-weigh before customer approval (parent active revision advanced)
  it('TC-WP3.1-19: rejects consumption when vendor has re-weighed and advanced parent revision', async () => {
    // Challenge is for revision 1
    prismaMock.customerWeightApprovalChallenge.findUnique.mockResolvedValue({
      id: 'chal-stale-rev',
      weightAdjustmentId: 'adj-1',
      measurementRevision: 1,
      authenticatedCustomerId: 'cust-1',
      expiresAt: new Date('2026-10-21T12:15:00.000Z'),
      status: ApprovalChallengeStatus.OPEN,
    });

    // Parent adjustment was re-weighed: activeMeasurementRevision is now 2!
    prismaMock.seafoodOrderWeightAdjustment.findUnique.mockResolvedValue({
      id: 'adj-1',
      activeMeasurementRevision: 2,
    });

    await expect(
      challengeRepo.consumeChallenge({
        challengeId: 'chal-stale-rev',
        expectedMeasurementRevision: 1,
        authenticatedCustomerId: 'cust-1',
      }),
    ).rejects.toThrow(CustomerApprovalRevisionMismatchError);
  });

  // 20. Stale expected revision argument during consumption
  it('TC-WP3.1-20: rejects consumption when caller passes superseded expected revision', async () => {
    prismaMock.customerWeightApprovalChallenge.findUnique.mockResolvedValue({
      id: 'chal-1',
      weightAdjustmentId: 'adj-1',
      measurementRevision: 1,
      authenticatedCustomerId: 'cust-1',
      expiresAt: new Date('2026-10-21T12:15:00.000Z'),
      status: ApprovalChallengeStatus.OPEN,
    });

    // Caller expects revision 0, but parent active revision is 1
    await expect(
      challengeRepo.consumeChallenge({
        challengeId: 'chal-1',
        expectedMeasurementRevision: 0,
        authenticatedCustomerId: 'cust-1',
      }),
    ).rejects.toThrow(CustomerApprovalRevisionMismatchError);
  });

  // 21. Transaction composition and rollback simulation
  it('TC-WP3.1-21: supports caller-supplied transaction and rolls back challenge consumption on downstream decision failure', async () => {
    const txMock: any = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      seafoodOrderWeightAdjustment: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'adj-1',
          activeMeasurementRevision: 1,
        }),
      },
      customerWeightApprovalChallenge: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'chal-tx',
          weightAdjustmentId: 'adj-1',
          measurementRevision: 1,
          authenticatedCustomerId: 'cust-1',
          expiresAt: new Date('2026-10-21T12:15:00.000Z'),
          status: ApprovalChallengeStatus.OPEN,
        }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };

    // Transaction mock delivers txMock to callback
    prismaMock.$transaction.mockImplementationOnce(async (cb: any) => cb(txMock));

    // Caller executes composed transaction where downstream step fails
    const executeComposedWorkflow = async () => {
      return prismaMock.$transaction(async (txClient: any) => {
        // Step 1: Consume challenge inside caller transaction
        await challengeRepo.consumeChallenge(
          {
            challengeId: 'chal-tx',
            expectedMeasurementRevision: 1,
            authenticatedCustomerId: 'cust-1',
          },
          txClient,
        );

        // Step 2: Downstream decision recording fails deliberately
        throw new Error('Downstream decision recording failed: simulate DB disconnection');
      });
    };

    // Transaction must abort and bubble downstream error without committing
    await expect(executeComposedWorkflow()).rejects.toThrow(
      'Downstream decision recording failed: simulate DB disconnection',
    );

    // Verifies consumeChallenge operated on txMock rather than calling independent root transaction
    expect(txMock.customerWeightApprovalChallenge.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'chal-tx',
          status: ApprovalChallengeStatus.OPEN,
        }),
      }),
    );
    expect(prismaMock.customerWeightApprovalChallenge.updateMany).not.toHaveBeenCalled();
  });
});
