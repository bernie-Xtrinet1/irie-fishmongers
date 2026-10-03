import { openOrdinarySchema, staleFixture } from './checkout-stale-settlement-test-helpers';

describe('Atomic stale settlement persistence (PostgreSQL only)', () => {
  jest.setTimeout(120000);
  let schema: Awaited<ReturnType<typeof openOrdinarySchema>>;
  beforeAll(async () => { schema = await openOrdinarySchema(); });
  afterAll(async () => { if (schema) await schema.close(); });
  afterEach(() => jest.restoreAllMocks());

  it('commits FAILED and action-bound REVERT_PENDING together; restart discovers the exact reference', async () => {
    const f = await staleFixture(schema.db);
    expect(await f.repository.authorizeStaleRecoverySettlement(f.candidate)).toEqual({ code: 'AUTHORIZED', manifestId: f.manifest.id });
    const m = await f.manifests.find(f.manifest.id);
    expect(m).toMatchObject({ state: 'REVERT_PENDING', effect: 'CHECKOUT_REVERT_DELETE_ONLY', completionReceiptHash: null,
      attempt: { status: 'FAILED', failureCode: 'STALE_RECOVERY_FENCED', failureMessage: null, orderId: null } });
    expect(m!.settlementReplayId).not.toBeNull(); expect(m!.settlementReplayId).not.toBe(m!.acquisitionReplayId);
    expect(m!.resources).toEqual(f.manifest.resources);
    expect(await f.repository.findPendingStaleSettlementsPage({ afterManifestId: null, limit: 100 })).toContainEqual({ id: m!.id });
    expect(f.redis.eval).not.toHaveBeenCalled();
  });
  it('rolls back FAILED if manifest CAS fails', async () => {
    const f = await staleFixture(schema.db);
    jest.spyOn(f.manifests, 'markRevertPending').mockResolvedValue({ count: 0 });
    expect(await f.repository.authorizeStaleRecoverySettlement(f.candidate)).toEqual({ code: 'UNRESOLVED' });
    expect(await f.manifests.find(f.manifest.id)).toMatchObject({ state: 'ACQUIRED', effect: null, settlementReplayId: null,
      attempt: { status: 'PROCESSING', failureCode: null } });
  });
  it('rejects a refreshed H0 even when the refreshed heartbeat is still older than the cutoff', async () => {
    const f = await staleFixture(schema.db);
    await schema.db.checkoutAttempt.update({ where: { id: f.attempt.id }, data: { lastHeartbeatAt: new Date(f.candidate.observedHeartbeatAt.getTime() + 1) } });
    expect(await f.repository.authorizeStaleRecoverySettlement(f.candidate)).toEqual({ code: 'DEFERRED' });
    expect(await f.manifests.find(f.manifest.id)).toMatchObject({ state: 'ACQUIRED', attempt: { status: 'PROCESSING' } });
  });
  it('FAILED alone with ACQUIRED is neither authority nor restart work', async () => {
    const f = await staleFixture(schema.db);
    await schema.db.checkoutAttempt.update({ where: { id: f.attempt.id }, data: { status: 'FAILED', failureCode: 'STALE_RECOVERY_FENCED' } });
    expect(await f.repository.authorizeStaleRecoverySettlement(f.candidate)).toEqual({ code: 'DEFERRED' });
    expect(await f.repository.loadObligation(f.manifest.id)).toBeNull();
    expect(await f.repository.findPendingStaleSettlementsPage({ afterManifestId: null, limit: 100 })).not.toContainEqual({ id: f.manifest.id });
  });
  it.each([false, true])('PREPARED requires positive read evidence: %s', async positive => {
    const f = await staleFixture(schema.db, false);
    f.redis.eval.mockResolvedValue(JSON.stringify({ code: 'ACCEPTED', value: { acquired: positive } }));
    expect((await f.repository.authorizeStaleRecoverySettlement(f.candidate)).code).toBe(positive ? 'AUTHORIZED' : 'DEFERRED');
    expect(f.redis.eval).toHaveBeenCalledTimes(1);
  });
  it('never recaptures resources after current cart intent changes', async () => {
    const f = await staleFixture(schema.db);
    await schema.db.cartReservationSyncState.update({ where: { id: f.marker.id }, data: { generation: 1, expectedQuantity: 9 } });
    const prepare = jest.spyOn(f.manifests, 'prepare');
    expect((await f.repository.authorizeStaleRecoverySettlement(f.candidate)).code).toBe('AUTHORIZED');
    expect((await f.manifests.find(f.manifest.id))!.resources).toEqual(f.manifest.resources);
    expect(prepare).not.toHaveBeenCalled();
  });
  it.each([0, 101, 1.5])('rejects an unbounded page %s', async limit => {
    const f = await staleFixture(schema.db);
    await expect(f.repository.findPendingStaleSettlementsPage({ afterManifestId: null, limit })).rejects.toThrow('INVALID_STALE_SETTLEMENT_PAGE');
  });
});
