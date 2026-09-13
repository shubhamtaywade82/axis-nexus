import { getTraderControls } from '../lib/dhanTraderControls';

describe('getTraderControls (typed SDK surface)', () => {
  it('returns null for a stub client missing traderControls', () => {
    const stub = {} as any;
    expect(getTraderControls(stub)).toBeNull();
  });

  it('returns null when traderControls exists but lacks setKillSwitch', () => {
    // The exact regression this guards against: an SDK rename of
    // `setKillSwitch` to anything else must surface as `null`, not as
    // a silently-undefined optional-chained no-op.
    const stub = { traderControls: { otherMethod: () => {} } } as any;
    expect(getTraderControls(stub)).toBeNull();
  });

  it('returns the TraderControls instance when setKillSwitch is a function', () => {
    const tc = { setKillSwitch: async () => ({ status: 'ACTIVATED' }) };
    const stub = { traderControls: tc } as any;
    expect(getTraderControls(stub)).toBe(tc);
  });
});
