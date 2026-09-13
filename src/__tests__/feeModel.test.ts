import { calculateOrderFees, calculateRoundTripFees, estimateRoundTripFees, minProfitableCapture } from '../services/feeModel';

describe('feeModel — NSE/BSE options fee calculator', () => {
  describe('calculateOrderFees (single side)', () => {
    it('calculates BUY-side fees (no STT, has stamp duty)', () => {
      const fees = calculateOrderFees(100, 75, 'BUY', 'NSE_FNO');
      expect(fees.brokerage).toBe(20);
      expect(fees.stt).toBe(0); // STT is sell-side only
      expect(fees.stampDuty).toBeGreaterThan(0); // stamp duty is buy-side
      expect(fees.exchangeTransaction).toBeGreaterThan(0);
      expect(fees.gst).toBeGreaterThan(0);
      expect(fees.total).toBeGreaterThan(20); // brokerage + other charges
    });

    it('calculates SELL-side fees (has STT, no stamp duty)', () => {
      const fees = calculateOrderFees(100, 75, 'SELL', 'NSE_FNO');
      expect(fees.brokerage).toBe(20);
      expect(fees.stt).toBeGreaterThan(0); // STT on sell side
      expect(fees.stampDuty).toBe(0); // no stamp duty on sell
      expect(fees.total).toBeGreaterThan(20);
    });

    it('STT is 0.05% of premium × qty on sell side', () => {
      const fees = calculateOrderFees(100, 75, 'SELL', 'NSE_FNO');
      // 0.05% of (100 × 75) = 0.05% of 7500 = 3.75
      expect(fees.stt).toBeCloseTo(3.75, 2);
    });

    it('uses lower exchange txn rate for BSE_FNO', () => {
      const nse = calculateOrderFees(100, 75, 'BUY', 'NSE_FNO');
      const bse = calculateOrderFees(100, 75, 'BUY', 'BSE_FNO');
      expect(bse.exchangeTransaction).toBeLessThan(nse.exchangeTransaction);
    });
  });

  describe('calculateRoundTripFees (buy + sell)', () => {
    it('sums buy + sell fees', () => {
      const rt = calculateRoundTripFees(100, 105, 75, 'NSE_FNO');
      expect(rt.buy.total).toBeGreaterThan(0);
      expect(rt.sell.total).toBeGreaterThan(0);
      expect(rt.total).toBe(rt.buy.total + rt.sell.total);
      expect(rt.perLot).toBe(rt.total / 75);
    });

    it('breakeven per unit is perLot cost', () => {
      const rt = calculateRoundTripFees(100, 100, 75, 'NSE_FNO');
      expect(rt.breakevenPerUnit).toBe(rt.perLot);
    });

    it('breakeven % is relative to entry premium', () => {
      const rt = calculateRoundTripFees(100, 100, 75, 'NSE_FNO');
      const expectedPct = (rt.perLot / 100) * 100;
      expect(rt.breakevenPct).toBeCloseTo(expectedPct, 2);
    });

    it('realistic NIFTY ATM scalp: ₹100 premium, 75 qty → ~₹56 round-trip', () => {
      const rt = calculateRoundTripFees(100, 100, 75, 'NSE_FNO');
      // Known approximate: ~₹55-60 for a ₹100 premium NIFTY option
      expect(rt.total).toBeGreaterThan(50);
      expect(rt.total).toBeLessThan(70);
    });

    it('realistic BANKNIFTY scalp: ₹300 premium, 30 qty → ~₹55 round-trip', () => {
      const rt = calculateRoundTripFees(300, 300, 30, 'NSE_FNO');
      expect(rt.total).toBeGreaterThan(40);
      expect(rt.total).toBeLessThan(70);
    });
  });

  describe('minProfitableCapture', () => {
    it('includes fees + spread + safety margin', () => {
      const min = minProfitableCapture(100, 75, 0.5, 'NSE_FNO', 0.5);
      const fees = estimateRoundTripFees(100, 75, 'NSE_FNO');
      const spreadCost = 0.5 * 75 * 2; // spread × qty × 2 (entry+exit)
      const safety = fees.total * 0.5;
      expect(min).toBeGreaterThan(fees.total);
      expect(min).toBeCloseTo(fees.total + spreadCost + safety, 0);
    });

    it('is higher for wider spreads', () => {
      const tight = minProfitableCapture(100, 75, 0.25, 'NSE_FNO');
      const wide = minProfitableCapture(100, 75, 1.0, 'NSE_FNO');
      expect(wide).toBeGreaterThan(tight);
    });
  });

  describe('stamp duty cap', () => {
    it('caps stamp duty at ₹600 for large orders', () => {
      // Very large turnover: ₹500 premium × 5000 qty = ₹25,00,000
      // 0.003% = ₹75 — under cap
      const under = calculateOrderFees(500, 5000, 'BUY', 'NSE_FNO');
      expect(under.stampDuty).toBeLessThanOrEqual(600);

      // Extremely large: ₹1000 × 50000 = ₹5,00,00,000 → 0.003% = ₹15000, capped at 600
      const capped = calculateOrderFees(1000, 50000, 'BUY', 'NSE_FNO');
      expect(capped.stampDuty).toBe(600);
    });
  });
});
