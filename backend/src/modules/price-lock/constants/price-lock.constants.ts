// Phase 16A.0-B (see docs/integrations/ADR-007-checkout-cutover-and-operational-integration.md,
// Decision 7). Deliberately independent of RESERVATION_TTL_SECONDS
// (inventory.constants.ts) - reservation and price-lock timers are
// separate concerns that happen to share a value today, not one constant
// aliased into two names.
export const PRICE_LOCK_TTL_SECONDS = 900;
