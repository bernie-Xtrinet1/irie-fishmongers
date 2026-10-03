export interface StaleSettlementCandidate {
  attemptId: string;
  customerId: string;
  observedHeartbeatAt: Date;
  staleBefore: Date;
  observedAt: Date;
}

export type StaleSettlementAuthorization =
  | { code: 'AUTHORIZED'; manifestId: string }
  | { code: 'DEFERRED' | 'FINALIZATION_REQUIRED' | 'UNRESOLVED' };

export type StaleSettlementResult = {
  code: 'SETTLED' | 'REJECTED' | 'UNRESOLVED';
};
