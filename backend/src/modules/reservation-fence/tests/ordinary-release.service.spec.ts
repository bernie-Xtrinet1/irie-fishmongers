import { OrdinaryReleaseService } from '../services/ordinary-release.service';
import { OrdinaryInvalidationPublicationService } from '../services/ordinary-invalidation-publication.service';
import { OrdinaryReservationCommandRepository } from '../repositories/ordinary-reservation-command.repository';
import { OrdinaryCommandDispatchClaimRepository } from '../repositories/ordinary-command-dispatch-claim.repository';
import { OrdinaryCommandPhysicalService } from '../services/ordinary-command-physical.service';
import { PrismaService } from '../../../database/prisma.service';
import { RedisService } from '../../../common/redis/redis.service';
import { randomUUID } from 'crypto';

describe('inactive RELEASE capability boundaries', () => {
  afterEach(() => jest.restoreAllMocks());
  it.each([null, undefined, {}, { commandId: randomUUID() }])('cannot reconstruct admission from %p', value => {
    const issuer = new OrdinaryReleaseService(new PrismaService());
    expect(issuer.consumeAdmission(value)).toBeNull();
  });
  it('failed/ambiguous publication creates no admission even after callback insertion', async () => {
    const issuer = new OrdinaryReleaseService(new PrismaService());
    jest.spyOn(OrdinaryInvalidationPublicationService.prototype, 'publishNew').mockRejectedValue(new Error('commit response lost'));
    expect(await issuer.publish(randomUUID(), { ownerId: randomUUID(), reason: 'CART_REMOVAL' }, () => Promise.resolve({})))
      .toEqual({ status: 'UNRESOLVED' });
    expect(jest.spyOn(OrdinaryReservationCommandRepository.prototype, 'insertPublicationRelease')).not.toHaveBeenCalled();
  });
  it('forged admission cannot reach a claim transaction', async () => {
    const db = new PrismaService(), issuer = new OrdinaryReleaseService(db);
    const transaction = jest.spyOn(db, '$transaction');
    expect(await new OrdinaryCommandDispatchClaimRepository(db).claimRelease({}, issuer)).toEqual({ status: 'NOT_AUTHORIZED' });
    expect(transaction).not.toHaveBeenCalled();
  });
  it('forged claim cannot reach Redis', async () => {
    const db = new PrismaService(), redis = Object.create(RedisService.prototype) as RedisService;
    const evaluate = jest.spyOn(redis, 'eval');
    const claims = new OrdinaryCommandDispatchClaimRepository(db);
    // Runtime forgery intentionally tested without manufacturing a branded cast.
    const service = new OrdinaryCommandPhysicalService(db, redis);
    const result: unknown = await Reflect.apply(service.executeRelease.bind(service), service, [{}, claims]);
    expect(result).toEqual({ code: 'REJECTED' });
    expect(evaluate).not.toHaveBeenCalled();
  });
});
