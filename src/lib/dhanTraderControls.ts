import type { DhanClient, TraderControls } from '@nemesis-oss/dhanhq-sdk';

/**
 * Typed access to the SDK's TraderControls — replaces the
 * `(this.client as any).traderControls?.setKillSwitch?.(...)` pattern
 * this codebase was bitten by once.
 *
 * Background: a previous version called `traderControls.killSwitch()`
 * and `.pnlExit()`, neither of which exists on the SDK. Because both
 * were guarded by optional chaining on an `any`-cast, the wrong method
 * names resolved to `undefined` and **silently no-oped** — the broker's
 * own kill switch never engaged in live mode while the code path
 * proceeded to record `brokerKillSwitch: 'ACTIVATE'` as if it had.
 *
 * This helper makes the SDK surface explicit: if the SDK ever renames
 * `setKillSwitch` again, TypeScript will fail at compile time instead
 * of silently swallowing it.
 *
 * Returns `null` when the client doesn't expose `traderControls` (e.g.
 * a stub test client) rather than `undefined`, so callers can branch
 * on `=== null` cleanly without optional chaining hiding a wrong-shape
 * object.
 */
export function getTraderControls(client: DhanClient): TraderControls | null {
  // Runtime shape check on top of the type: a stub/mock test client may
  // pass the type check while lacking the actual method. We pay this
  // check once per kill-switch arm/disarm, not per request.
  const tc = (client as unknown as { traderControls?: unknown }).traderControls;
  if (!tc || typeof (tc as { setKillSwitch?: unknown }).setKillSwitch !== 'function') {
    return null;
  }
  return tc as TraderControls;
}
