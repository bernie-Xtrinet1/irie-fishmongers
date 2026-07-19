// Deterministic, environment-independent name ordering.
//
// PostgreSQL's `ORDER BY name` uses the database's collation, which is not the
// same as JavaScript's default string comparison and can differ between
// deployments (e.g. libc vs ICU, C vs en_US). That makes DB-defined ordering an
// unreliable contract for small customer-facing lists like product categories:
// "SLA Breaches" vs "Shellfish" sort differently under Postgres' C collation
// than under JS localeCompare. Sorting in the application with an explicit
// locale keeps these lists ordered identically everywhere, and lets tests
// assert against the exact same rule the production code uses.
export function compareByLocaleName(a: string, b: string): number {
  return a.localeCompare(b, 'en', { sensitivity: 'base' });
}
