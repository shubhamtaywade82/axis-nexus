import { evaluateScalpExit, type ScalpState } from '../services/scalpExitPolicy';
import { DEFAULT_SCALP_CONFIG } from '../services/scalpConfig';

function makeState(overrides: Partial<ScalpState> = {}): ScalpState {
  return {
    positionId: 'test_1',
    tradingSymbol: 'NIFTY241031C24000',
    securityId: '99999',
    underlying: 'NIFTY',
    side: 'LONG',
    entryPrice: 100,
    currentPrice: 100,
    peakPrice: 100,
    lotSize: 75,
    quantity: 75,
    underlyingSpot: 24000,
    underlyingPeak: 24000,
    underlyingAtr: 20,
    delta: 0.5,
    initialRisk: 8, // 8% of entry = ₹8
    initialSL: 92,
    currentSL: 92,
    currentFloor: 100,
    currentTP: 118,
    entryTime: Date.now() - 60_000, // 1 min ago
    holdMs: 60_000,
    rMultiple: 0,
    activeTier: 0,
    givebackUsed: 0,
    feesPerLot: 0.75, // ~₹56 / 75
    breakevenPrice: 100.75,
    profitSoFar: -56,
    peakProfit: -56,
    momentumReversed: false,
    momentumStrength: 0,
    ...overrides,
  };
}

describe('scalpExitPolicy — both-side ratchet', () => {
  const config = DEFAULT_SCALP_CONFIG;
  const now = Date.now();

  describe('HOLD decisions', () => {
    it('holds when price is between SL and TP with no reversal', () => {
      const state = makeState({ currentPrice: 102, peakPrice: 103 });
      const decision = evaluateScalpExit(state, config, now);
      expect(decision.action).toBe('HOLD');
      expect(decision.stateSnapshot.rMultiple).toBeGreaterThan(0);
    });

    it('updates trailing SL based on peak price', () => {
      const state = makeState({ currentPrice: 110, peakPrice: 112 });
      const decision = evaluateScalpExit(state, config, now);
      // At ~1.7R (peak profit ₹12 / risk ₹8 = 1.5R), tier 3 (1.5R) applies
      // SL = peak - 4% of peak = 112 - 4.48 = 107.52
      expect(decision.stateSnapshot.currentSL).toBeLessThan(state.peakPrice);
      expect(decision.stateSnapshot.currentSL).toBeGreaterThan(state.entryPrice);
    });

    it('updates floor based on ratchet tier', () => {
      const state = makeState({ currentPrice: 110, peakPrice: 112 });
      const decision = evaluateScalpExit(state, config, now);
      // Floor should be above entry when in profit
      expect(decision.stateSnapshot.currentFloor).toBeGreaterThan(state.entryPrice);
    });
  });

  describe('EXIT_SL — trailing stop-loss', () => {
    it('exits when price drops below trailing SL', () => {
      const state = makeState({
        currentPrice: 91,
        peakPrice: 105, // SL trails below peak at 8% = 105 - 8.4 = 96.6
      });
      const decision = evaluateScalpExit(state, config, now);
      expect(decision.action).toBe('EXIT_SL');
      expect(decision.exitPrice).toBe(91);
    });

    it('SL ratchets tighter as profit grows', () => {
      // At 0R: SL = peak - 8% = 100 - 8 = 92
      const earlyState = makeState({ currentPrice: 100, peakPrice: 100 });
      const earlyDecision = evaluateScalpExit(earlyState, config, now);
      const earlySL = earlyDecision.stateSnapshot.currentSL;

      // At 2R (peak profit = 16): SL = 116 - 3% = 116 - 3.48 = 112.52
      const lateState = makeState({ currentPrice: 115, peakPrice: 116 });
      const lateDecision = evaluateScalpExit(lateState, config, now);
      const lateSL = lateDecision.stateSnapshot.currentSL;

      // Late SL should be tighter (% distance from peak) than early SL
      const earlyPct = (earlyState.peakPrice - earlySL) / earlyState.peakPrice;
      const latePct = (lateState.peakPrice - lateSL) / lateState.peakPrice;
      expect(latePct).toBeLessThan(earlyPct);
    });
  });

  describe('EXIT_FLOOR — profit floor / giveback limit', () => {
    it('exits when price drops below the profit floor', () => {
      // Peak at 112 → 1.5R. SL = 112 - 4% = 107.52
      // Floor: profitFloor = 100 + 0.7×8 = 105.6
      // Giveback = 30% of ₹12 = 3.6 → givebackLimit = 112 - 3.6 = 108.4
      // Effective floor = max(105.6, 108.4) = 108.4
      // Set currentPrice to 108 (below floor 108.4, above SL 107.52)
      const state = makeState({
        currentPrice: 108, // below floor, above SL
        peakPrice: 112,
      });
      const decision = evaluateScalpExit(state, config, now);
      expect(decision.action).toBe('EXIT_FLOOR');
      expect(decision.stateSnapshot.currentFloor).toBeGreaterThan(state.entryPrice);
    });
  });

  describe('EXIT_TP — dynamic take-profit', () => {
    it('exits when price hits the dynamic TP', () => {
      const state = makeState({
        currentPrice: 120,
        peakPrice: 120,
      });
      const decision = evaluateScalpExit(state, config, now);
      // At 2.5R, targetMultiplier ≈ 3.0, TP = 100 + (130 × 3.0) / 75 ≈ 105.2
      // Wait — that's too low. Let me recalculate.
      // minCapturePerLot = 130, targetMultiplier max = 3.0
      // targetProfit = 130 × 3.0 = 390
      // targetPrice = 100 + 390/75 = 100 + 5.2 = 105.2
      // currentPrice 120 > 105.2 → EXIT_TP
      expect(decision.action).toBe('EXIT_TP');
    });
  });

  describe('EXIT_MOMENTUM — momentum reversal', () => {
    it('exits when momentum reverses and profit exceeds minCapture', () => {
      // Use currentPrice=103, peakPrice=104 → profit₹3×75=₹225 > ₹130
      // rMultiple = 4/8 = 0.5, tier 1: SL = 104-7%=96.72
      // TP at 0.5R: multiplier=1.875, TP=100+(130×1.875)/75=103.25
      // currentPrice 103 < TP 103.25 → TP not hit
      // floor: profitFloor=102, giveback=4×0.75=3, givebackLimit=101
      // effectiveFloor=102, currentPrice 103 > 102 → floor not hit
      const state = makeState({
        currentPrice: 103,
        peakPrice: 104,
        momentumReversed: true,
      });
      const decision = evaluateScalpExit(state, config, now);
      expect(decision.action).toBe('EXIT_MOMENTUM');
    });

    it('holds when momentum reverses but profit < minCapture', () => {
      const state = makeState({
        currentPrice: 100.5, // profit = 0.5 × 75 = 37.5 < 130
        peakPrice: 101,
        momentumReversed: true,
      });
      const decision = evaluateScalpExit(state, config, now);
      expect(decision.action).not.toBe('EXIT_MOMENTUM');
    });
  });

  describe('EXIT_FLAT — fee-aware bailout', () => {
    it('exits when held too long without movement', () => {
      const state = makeState({
        currentPrice: 100.5, // profit = 37.5 < minMoveToHold (130)
        peakPrice: 101,
        entryTime: now - 6 * 60 * 1000, // 6 min ago > maxFlatHoldMs (5 min)
        holdMs: 6 * 60 * 1000,
      });
      const decision = evaluateScalpExit(state, config, now);
      expect(decision.action).toBe('EXIT_FLAT');
    });

    it('holds when movement exceeds minMoveToHold even if held long', () => {
      const state = makeState({
        currentPrice: 103, // profit = 3 × 75 = 225 > 130
        peakPrice: 104,
        entryTime: now - 6 * 60 * 1000,
        holdMs: 6 * 60 * 1000,
      });
      const decision = evaluateScalpExit(state, config, now);
      expect(decision.action).not.toBe('EXIT_FLAT');
    });
  });

  describe('SHORT positions', () => {
    it('handles SHORT side correctly (inverted direction)', () => {
      const state = makeState({
        side: 'SHORT',
        entryPrice: 100,
        currentPrice: 92, // profit for SHORT
        peakPrice: 92, // peak (lowest) for SHORT
        initialSL: 108,
        initialRisk: 8,
      });
      const decision = evaluateScalpExit(state, config, now);
      // Profit = 8 × 75 = 600, peakProfit = 8, rMultiple = 1.0
      // Should hold or exit TP depending on tier
      expect(['HOLD', 'EXIT_TP', 'EXIT_FLOOR']).toContain(decision.action);
    });
  });

  describe('ratchet tier progression', () => {
    it('activates higher tiers as R-multiple grows', () => {
      const tiers = [
        { peakPrice: 100, expectedTier: 0 }, // 0R
        { peakPrice: 104, expectedTier: 1 }, // 0.5R
        { peakPrice: 108, expectedTier: 2 }, // 1.0R
        { peakPrice: 112, expectedTier: 3 }, // 1.5R
        { peakPrice: 116, expectedTier: 4 }, // 2.0R
      ];

      for (const { peakPrice, expectedTier } of tiers) {
        const state = makeState({
          currentPrice: peakPrice,
          peakPrice,
        });
        const decision = evaluateScalpExit(state, config, now);
        expect(decision.stateSnapshot.activeTier).toBe(expectedTier);
      }
    });
  });
});
