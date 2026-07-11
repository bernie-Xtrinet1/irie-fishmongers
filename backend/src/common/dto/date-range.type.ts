// Shared by every analytics repository method and by AnalyticsService -
// `to` is inclusive; both bounds are UTC instants (createdAt is a Postgres
// timestamptz). A plain date like "2026-01-01" is interpreted as
// 2026-01-01T00:00:00.000Z, matching Date's own ISO-string parsing.
export interface DateRange {
  from?: Date;
  to?: Date;
}
