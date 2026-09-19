import { OrdinaryW1IssuanceService } from '../services/ordinary-w1-issuance.service';
import { ReservationFenceRepository } from '../repositories/reservation-fence.repository';
import { acknowledgement, openOrdinarySchema, ordinaryFixture } from './ordinary-provenance-test-helpers';

describe('controlled issuance admission: real isolated PostgreSQL, no Redis', () => {
  jest.setTimeout(120000);
  let schema: Awaited<ReturnType<typeof openOrdinarySchema>>;
  beforeAll(async () => { schema = await openOrdinarySchema(); });
  afterAll(async () => { if (schema) await schema.close(); });
  afterEach(() => jest.restoreAllMocks());

  async function fixture() {
    const f = await ordinaryFixture(schema.db);
    const service = new OrdinaryW1IssuanceService(schema.db);
    const intent = { markerId: f.marker.id, cartId: f.cartId, customerId: f.customerId,
      productId: f.productId, generation: 0, mutationVersion: 0, quantity: 2 };
    const rows = () => schema.db.ordinaryReservationCommand.findMany({ where: { markerId: f.marker.id } });
    return { ...f, service, intent, rows };
  }

  it('new insertion yields exactly bound, service-local single-use admission after commit', async () => {
    const f = await fixture();
    const result = await f.service.issueForControlledDispatch(f.intent);
    expect(result.issuance.status).toBe('PENDING');
    if (!result.admission || result.issuance.status === 'DENIED') throw new Error('Missing admission');
    const persisted = (await f.rows())[0];
    expect(persisted).toEqual(result.issuance.command);
    expect(persisted).toMatchObject({ attemptCount: 0, lastDispatchTransitionId: null, nextAttemptAt: null });
    expect(f.service.consumeAdmission({ ...result.admission })).toBeNull();
    const decoded: unknown = JSON.parse(JSON.stringify(result.admission));
    expect(f.service.consumeAdmission(decoded)).toBeNull();
    expect(f.service.consumeAdmission({ commandId: persisted?.id, replayId: persisted?.replayId })).toBeNull();
    expect(new OrdinaryW1IssuanceService(schema.db).consumeAdmission(result.admission)).toBeNull();
    // Caller mutation cannot substitute the command held by the capability.
    result.issuance.command.replayId = 'tampered';
    const bound = f.service.consumeAdmission(result.admission);
    expect(bound).toEqual(persisted);
    expect(f.service.consumeAdmission(result.admission)).toBeNull();
    expect(await f.rows()).toEqual([persisted]);
  });

  it('historical ordinary issue result is reused without admission despite pristine dispatch metadata', async () => {
    const f = await fixture();
    const original = await f.service.issue(f.intent);
    if (original.status !== 'PENDING') throw new Error('Expected historical PENDING');
    expect(Object.keys(original).sort()).toEqual(['command', 'status']);
    expect(original.command).toMatchObject({ attemptCount: 0, lastDispatchTransitionId: null, nextAttemptAt: null });
    expect(await f.service.issueForControlledDispatch(f.intent)).toEqual({ issuance: original, admission: null });
    expect(await f.service.issue(f.intent)).toEqual(original);
    expect(await f.rows()).toEqual([original.command]);
    // No Redis client/evidence exists in this fixture: absence grants nothing.
  });

  it('controlled reuse does not mint another capability, even before the original is consumed', async () => {
    const f = await fixture();
    const first = await f.service.issueForControlledDispatch(f.intent);
    expect(first.admission).not.toBeNull();
    expect(await f.service.issueForControlledDispatch(f.intent)).toEqual({ issuance: first.issuance, admission: null });
    expect(f.service.consumeAdmission(first.admission)).not.toBeNull();
  });

  it('four concurrent real connections have one inserter and three reuse losers', async () => {
    const f = await fixture();
    const clients = Array.from({ length: 4 }, () => schema.fresh());
    try {
      const services = clients.map(db => new OrdinaryW1IssuanceService(db));
      const results = await Promise.all(services.map(service => service.issueForControlledDispatch(f.intent)));
      expect(results.filter(result => result.admission !== null)).toHaveLength(1);
      expect(results.every(result => result.issuance.status === 'PENDING')).toBe(true);
      expect(await f.rows()).toHaveLength(1);
      for (let index = 0; index < results.length; index++) {
        const result = results[index], service = services[index];
        if (!result || !service) throw new Error('Missing concurrent result');
        expect(result.issuance).toEqual(results[0]?.issuance);
        const binding = service.consumeAdmission(result.admission);
        expect(binding !== null).toBe(result.admission !== null);
        if (result.issuance.status !== 'DENIED' && binding) expect(binding).toEqual(result.issuance.command);
      }
    } finally { await Promise.all(clients.map(db => db.$disconnect())); }
  });

  it.each(['rollback', 'commit-response-loss'] as const)('%s grants no capability and never reconstructs one', async fault => {
    const f = await fixture();
    const original = ReservationFenceRepository.prototype.locked.bind(new ReservationFenceRepository(schema.db));
    jest.spyOn(ReservationFenceRepository.prototype, 'locked').mockImplementationOnce(async work => {
      if (fault === 'rollback') return original(async tx => { await work(tx); throw new Error('rollback after insertion'); });
      await original(work);
      throw new Error('commit response lost');
    });
    expect(await f.service.issueForControlledDispatch(f.intent)).toEqual({
      issuance: { status: 'DENIED', reason: 'AUTHORITY_REJECTED' }, admission: null });
    expect(await f.rows()).toHaveLength(fault === 'rollback' ? 0 : 1);
    const fresh = new OrdinaryW1IssuanceService(schema.db);
    const next = await fresh.issueForControlledDispatch(f.intent);
    expect(next.issuance.status).toBe('PENDING');
    expect(next.admission !== null).toBe(fault === 'rollback');
  });

  it('fresh service and connection cannot recover admission lost after a successful commit', async () => {
    const f = await fixture();
    const first = await f.service.issueForControlledDispatch(f.intent);
    expect(first.admission).not.toBeNull();
    const client = schema.fresh();
    try {
      const restarted = new OrdinaryW1IssuanceService(client);
      expect(restarted.consumeAdmission(first.admission)).toBeNull();
      expect(await restarted.issueForControlledDispatch(f.intent)).toEqual({ issuance: first.issuance, admission: null });
    } finally { await client.$disconnect(); }
  });

  it.each(['UNCERTAIN', 'ACKNOWLEDGED'] as const)('historical %s remains compatible and cannot acquire admission', async state => {
    const f = await fixture();
    const first = await f.service.issue(f.intent);
    if (first.status !== 'PENDING') throw new Error('Missing fixture command');
    if (state === 'UNCERTAIN') await schema.db.ordinaryReservationCommand.update({ where: { id: first.command.id }, data: { state } });
    else await f.commands.acknowledge(f.marker.id, acknowledgement(first.command)); // Structural fixture only.
    const ordinary = await f.service.issue(f.intent);
    expect(ordinary.status).toBe(state);
    expect(await f.service.issueForControlledDispatch(f.intent)).toEqual({ issuance: ordinary, admission: null });
  });

  it('no result/capability is delivered while the real insertion transaction is still open', async () => {
    const f = await fixture();
    const original = ReservationFenceRepository.prototype.locked.bind(new ReservationFenceRepository(schema.db));
    let inserted!: () => void, release!: () => void;
    const ready = new Promise<void>(resolve => { inserted = resolve; });
    const barrier = new Promise<void>(resolve => { release = resolve; });
    jest.spyOn(ReservationFenceRepository.prototype, 'locked').mockImplementationOnce(work => original(async tx => {
      const result = await work(tx);
      inserted();
      await barrier;
      return result;
    }));
    let delivered = false;
    const pending = f.service.issueForControlledDispatch(f.intent).then(result => { delivered = true; return result; });
    try { await ready; expect(delivered).toBe(false); }
    finally { release(); }
    expect((await pending).admission).not.toBeNull();
  });
});
