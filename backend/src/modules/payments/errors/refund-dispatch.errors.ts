import { BadRequestException, ConflictException } from '@nestjs/common';

export class MissingRefundIdempotencyKeyException extends BadRequestException {
  constructor(message = 'Valid Idempotency-Key is required for manual refunds') {
    super(message);
  }
}

export class ActiveRefundAttemptInFlightException extends ConflictException {
  constructor(refundId: string, attemptId: string) {
    super(
      `Refund "${refundId}" already has non-terminal provider attempt "${attemptId}" in flight`,
    );
  }
}

export class AmbiguousRefundAttemptQuarantinedException extends ConflictException {
  constructor(refundId: string, attemptId: string) {
    super(
      `Refund "${refundId}" has quarantined ambiguous attempt "${attemptId}" requiring verified reconciliation before any retry`,
    );
  }
}
