import { toCsv } from './csv.util';

describe('toCsv', () => {
  it('returns an empty string for no rows', () => {
    expect(toCsv([])).toBe('');
  });

  it('writes a header row followed by one row per record', () => {
    const csv = toCsv([
      { id: '1', name: 'Snapper' },
      { id: '2', name: 'King Fish' },
    ]);

    expect(csv).toBe('id,name\n1,Snapper\n2,King Fish');
  });

  it('quotes and escapes cells containing commas, quotes, or newlines', () => {
    const csv = toCsv([{ notes: 'Rejected, "spoiled"\nsee photo' }]);

    expect(csv).toBe('notes\n"Rejected, ""spoiled""\nsee photo"');
  });

  it('fills missing keys with an empty cell', () => {
    const csv = toCsv([{ a: '1', b: '2' }, { a: '3' }]);

    expect(csv).toBe('a,b\n1,2\n3,');
  });
});
