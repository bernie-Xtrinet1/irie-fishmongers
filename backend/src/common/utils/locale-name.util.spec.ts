import { compareByLocaleName } from './locale-name.util';

describe('compareByLocaleName', () => {
  it('orders names case-insensitively by locale', () => {
    const names = ['Shellfish', 'Crustaceans', 'fish', 'Mollusks'];
    expect([...names].sort(compareByLocaleName)).toEqual(['Crustaceans', 'fish', 'Mollusks', 'Shellfish']);
  });

  it('orders the collation-divergent pair deterministically ("Shellfish" before "SLA...")', () => {
    // Postgres' C collation would place "SLA..." before "Shellfish"; the explicit
    // locale keeps the JS-defined order regardless of the database's collation.
    expect(compareByLocaleName('Shellfish', 'SLA Breaches Category x')).toBeLessThan(0);
  });

  it('returns 0 for names equal under base sensitivity', () => {
    expect(compareByLocaleName('Fish', 'fish')).toBe(0);
  });
});
