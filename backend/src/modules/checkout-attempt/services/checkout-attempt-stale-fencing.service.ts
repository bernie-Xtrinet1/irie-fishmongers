import { Injectable } from '@nestjs/common';
import { CheckoutPath } from '@prisma/client';
import { CheckoutAttemptRepository } from '../repositories/checkout-attempt.repository';
import {
  FenceStaleCheckoutAttemptInput,
  FenceStaleCheckoutAttemptResult,
} from '../types/checkout-attempt.types';

// Inactive G.PR0 primitive, not a scheduler or reservation recovery executor.
@Injectable()
export class CheckoutAttemptStaleFencingService {
  constructor(private readonly repository: CheckoutAttemptRepository) {}

  async fence(input: FenceStaleCheckoutAttemptInput): Promise<FenceStaleCheckoutAttemptResult> {
    const validDate = (date: Date): boolean =>
      date instanceof Date && Number.isFinite(date.getTime());
    if (
      !input.attemptId ||
      !input.customerId ||
      !Object.values(CheckoutPath).includes(input.selectedPath) ||
      !validDate(input.observedHeartbeatAt) ||
      !validDate(input.staleBefore) ||
      !validDate(input.now) ||
      input.observedHeartbeatAt >= input.staleBefore ||
      input.staleBefore > input.now
    ) {
      return {
        ok: false,
        code: 'INVALID_INPUT',
        field: 'observation',
        reason: 'Server ownership and ordered valid stale-observation timestamps are required',
      };
    }
    const { count } = await this.repository.fenceStaleProcessing(input);
    if (count === 1) return { ok: true, outcome: 'FENCED' };
    // Diagnostic re-read only. Never retry the mutation using refreshed state.
    const attempt = await this.repository.findById(input.attemptId);
    if (!attempt) return { ok: false, code: 'NOT_FOUND' };
    if (attempt.customerId !== input.customerId) return { ok: false, code: 'OWNERSHIP_MISMATCH' };
    if (attempt.selectedPath === null) return { ok: false, code: 'UNKNOWN_PATH' };
    if (attempt.selectedPath !== input.selectedPath) return { ok: false, code: 'PATH_MISMATCH' };
    if (attempt.status === 'COMMITTED') return { ok: false, code: 'ALREADY_COMMITTED' };
    if (attempt.status === 'FAILED') return { ok: false, code: 'ALREADY_FAILED' };
    return { ok: false, code: 'STALE_OBSERVATION' };
  }
}
