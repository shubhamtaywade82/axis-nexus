import { resolveSandboxOptionLeg, roundToTick } from '../services/sandboxInstruments';

function mockClient(instrument: any) {
  return {
    instruments: {
      findBySecurityId: jest.fn().mockResolvedValue(instrument),
    },
  } as any;
}

describe('sandboxInstruments', () => {
  it('resolves lot size and tick size from exchangeSegment + securityId', async () => {
    const leg = await resolveSandboxOptionLeg(
      mockClient({ securityId: '46026', lotSize: 65, tickSize: 5, displayName: 'NIFTY 13 JAN 23600 CALL' }),
      { securityId: '46026', exchangeSegment: 'NSE_FNO' },
    );
    expect(leg?.securityId).toBe('46026');
    expect(leg?.quantity).toBe(65);
    expect(leg?.tickSize).toBe(0.05); // scrip master reports paise
  });

  it('returns null when instrument not found', async () => {
    const leg = await resolveSandboxOptionLeg(
      mockClient(undefined),
      { securityId: '99999', exchangeSegment: 'BSE_FNO' },
    );
    expect(leg).toBeNull();
  });

  it('rounds limit price to the contract tick size', () => {
    expect(roundToTick(123.2, 5)).toBe(125);
    expect(roundToTick(122.4, 5)).toBe(120);
    expect(roundToTick(123.23, 0.05)).toBe(123.25);
    expect(roundToTick(123.45, 0.05)).toBe(123.45);
  });
});
