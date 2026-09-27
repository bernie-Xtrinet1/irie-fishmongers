import { withOrdinaryReleaseRedis } from './ordinary-provenance-test-helpers';
import { OrdinaryCommandPhysicalService } from '../services/ordinary-command-physical.service';
import { OrdinaryCommandClosureService } from '../services/ordinary-command-closure.service';
import { OrdinaryCommandDispatchClaimRepository } from '../repositories/ordinary-command-dispatch-claim.repository';

describe('RELEASE restart observes evidence without reconstructing authority', () => {
  jest.setTimeout(120000);
  it.each([false, true])('restart after claim, physical completion=%s', completed => withOrdinaryReleaseRedis(async f => {
    if (completed) expect((await f.physical.executeRelease(f.claim, f.claims)).code).toBe('COMPLETED');
    const physical = new OrdinaryCommandPhysicalService(f.db, f.redis);
    const closure = new OrdinaryCommandClosureService(f.db, physical);
    expect((await physical.executeRelease(f.claim, new OrdinaryCommandDispatchClaimRepository(f.db))).code).toBe('REJECTED');
    const before = await f.snapshot();
    expect((await closure.close(f.release.id)).status).toBe(completed ? 'ACKNOWLEDGED' : 'UNRESOLVED');
    expect((await closure.close(f.release.id)).status).toBe(completed ? 'ACKNOWLEDGED' : 'UNRESOLVED');
    expect(await f.snapshot()).toEqual(before);
  }));
});
