import { readFileSync } from 'fs';
import { resolve } from 'path';
import { PrismaService } from '../../../database/prisma.service';
import { OrdinaryCommandClosureService } from '../services/ordinary-command-closure.service';
import { OrdinaryCommandPhysicalService } from '../services/ordinary-command-physical.service';

describe('inactive closure service boundary', () => {
  const db = new PrismaService();
  const observe = jest.fn<ReturnType<OrdinaryCommandPhysicalService['observe']>, [string]>();
  const service = new OrdinaryCommandClosureService(db, { observe });
  afterEach(() => { jest.restoreAllMocks(); observe.mockReset(); });
  afterAll(() => db.$disconnect());

  it.each(['', 'invalid', '00000000-0000-0000-0000-000000000000\n'])('rejects invalid ID %j before observation', async id => {
    expect(await service.close(id)).toEqual({ status: 'UNRESOLVED' });
    expect(observe).not.toHaveBeenCalled();
  });
  it.each(['not json', '{}', '[]', 'null'])('rejects malformed receipt %j without a durable transaction', async receipt => {
    observe.mockResolvedValue({ code: 'COMPLETED', historical: true, identity: '{}', receipt, completionReceiptHash: 'a'.repeat(64) });
    const transaction = jest.spyOn(db, '$transaction');
    expect(await service.close('00000000-0000-0000-0000-000000000000')).toEqual({ status: 'UNRESOLVED' });
    expect(transaction).not.toHaveBeenCalled();
  });
  it('has no physical execution, genesis, issuance, or production registration', () => {
    const source = readFileSync(resolve(__dirname, '../services/ordinary-command-closure.service.ts'), 'utf8');
    expect(source).not.toMatch(/@Injectable|\.execute\(|\.initialize\(|\.issue\(|\.promote\(|\.recordDispatch\(/);
    for (const file of ['../reservation-fence.module.ts', '../../inventory/inventory.module.ts', '../../../app.module.ts'])
      expect(readFileSync(resolve(__dirname, file), 'utf8')).not.toContain('OrdinaryCommandClosureService');
  });
});
