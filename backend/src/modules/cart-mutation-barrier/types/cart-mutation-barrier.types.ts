// CART_SCOPED activation-boundary gate (see the gate design review). The
// complete "is ordinary cart-mutation admission currently frozen" identity
// - both fields together, mirroring ReservationEngineModeSnapshot's own
// rationale: `revision` alone is the actual comparable identity (unique by
// construction), `active` is the value every mutation-transaction call
// site branches on. The implicit default - no CartMutationBarrierConfig
// row exists yet - is a real, comparable identity of its own:
// { active: false, revision: null }, exactly matching this codebase's
// existing "no config row means the safe/inactive default" precedent
// (ReservationEngineModeService.getCurrentMode's implicit LEGACY).
export interface CartMutationBarrierSnapshot {
  active: boolean;
  revision: number | null;
}
