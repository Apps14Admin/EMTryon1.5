import { describe, expect, it } from 'vitest';
import { BUDGET_USD, CostMeter, RATES, usageOf } from './costMeter';

const RATED = 'test-model';
(RATES as any)[RATED] = { inPerMTok: 0.1, outPerMTok: 0.4 };

describe('usageOf', () => {
  it('reads Gemini usageMetadata', () => {
    const res = { usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 50 } };
    expect(usageOf('m', res)).toEqual({ model: 'm', inputTokens: 1000, outputTokens: 50 });
  });
  it('returns null when the response carries no usage', () => {
    expect(usageOf('m', { candidates: [] })).toBeNull();
  });
});

describe('CostMeter', () => {
  it('accumulates money from recorded usage', () => {
    const meter = new CostMeter();
    meter.charge();
    meter.record({ model: RATED, inputTokens: 2_000_000, outputTokens: 1_000_000 });
    expect(meter.spentUsd()).toBeCloseTo(0.1 * 2 + 0.4 * 1, 10);
  });
  it('blocks at the budget ceiling, before the request', () => {
    const meter = new CostMeter(0.5, 1000);
    meter.charge();
    meter.record({ model: RATED, inputTokens: 6_000_000, outputTokens: 0 }); // $0.60
    expect(meter.canSpend()).toBe(false);
    expect(meter.blockedBy()).toBe('budget');
  });
  it('falls back to the request fuse when a model has no rate', () => {
    const meter = new CostMeter(BUDGET_USD, 3);
    meter.charge();
    meter.record({ model: 'gemini-3.1-flash-lite-image', inputTokens: 9e9, outputTokens: 9e9 });
    expect(meter.spentUsd()).toBeNull();       // rate unconfigured
    expect(meter.canSpend()).toBe(true);        // money gate cannot fire...
    meter.charge();
    meter.charge();
    expect(meter.canSpend()).toBe(false);       // ...but the fuse does
    expect(meter.blockedBy()).toBe('fuse');
  });
  it('counts a request even when its response never arrives', () => {
    const meter = new CostMeter(BUDGET_USD, 2);
    meter.charge();
    meter.charge();
    expect(meter.requests()).toBe(2);
    expect(meter.canSpend()).toBe(false);
  });
});
