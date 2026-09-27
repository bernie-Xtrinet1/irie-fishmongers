import { openOrdinarySchema, ordinaryReleaseFixture } from './ordinary-provenance-test-helpers';
import { OrdinaryReleaseService } from '../services/ordinary-release.service';
import { OrdinaryCommandDispatchClaimRepository } from '../repositories/ordinary-command-dispatch-claim.repository';
import { OrdinaryW1IssuanceService } from '../services/ordinary-w1-issuance.service';

describe('RELEASE publication serialization', () => {
  jest.setTimeout(120000);
  it('duplicate publication and dispatcher yield exactly one admission and claim; W1 cannot cross PREPARED', async () => {
    const schema = await openOrdinarySchema();
    try {
      const f = await ordinaryReleaseFixture(schema.db); await f.prepare();
      const blocked = await new OrdinaryW1IssuanceService(f.db).issue({ markerId: f.marker.id, generation: 0, mutationVersion: 0,
        cartId: f.cartId, productId: f.productId, customerId: f.customerId, quantity: 2 });
      expect(blocked.status).toBe('DENIED');
      const issuer = new OrdinaryReleaseService(f.db);
      const outcomes = await Promise.all([
        issuer.publish(f.request.intentId, { ownerId: f.owner.id, reason: 'CART_REMOVAL' }, f.domain),
        issuer.publish(f.request.intentId, { ownerId: f.owner.id, reason: 'CART_REMOVAL' }, f.domain),
      ]);
      expect(outcomes.filter(r => r.status === 'PUBLISHED')).toHaveLength(1);
      const winner = outcomes.find(r => r.status === 'PUBLISHED');
      if (!winner || winner.status !== 'PUBLISHED') throw new Error('Missing publication winner');
      const claims = new OrdinaryCommandDispatchClaimRepository(f.db);
      const dispatched = await Promise.all([claims.claimRelease(winner.admission, issuer), claims.claimRelease(winner.admission, issuer)]);
      expect(dispatched.filter(r => r.status === 'FIRST_PHYSICAL_DISPATCH_AUTHORIZED')).toHaveLength(1);
      const w1 = await new OrdinaryW1IssuanceService(f.db).issue({ markerId: f.marker.id, generation: 1, mutationVersion: 1,
        cartId: f.cartId, productId: f.productId, customerId: f.customerId, quantity: 2 });
      expect(w1.status).toBe('DENIED');
    } finally { await schema.close(); }
  });
});
