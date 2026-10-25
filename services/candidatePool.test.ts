// services/candidatePool.test.ts
import { describe, expect, it } from 'vitest';
import {
  FLOOR_PERCENTILE, MIN_FLOOR_SAMPLES, POOL_SIZE,
  buildPools, cosine, floorKey, floorOf, marginOf, pairFloors, pairKey, poolsFromSignatures,
} from './candidatePool';
import { Signature } from './imageSignature';

/** Unit vector helpers for readable geometry. */
const v = (...xs: number[]) => Float32Array.from(xs);

describe('cosine / pairKey', () => {
  it('computes cosine on direction, ignoring magnitude', () => {
    expect(cosine(v(2, 0), v(5, 0))).toBeCloseTo(1);
    expect(cosine(v(1, 0), v(0, 1))).toBeCloseTo(0);
  });
  it('orders pairKey smaller-first', () => {
    expect(pairKey(17, 3)).toBe('3,17');
  });
});

describe('THE HEEL-TAB REGRESSION (spec section 6)', () => {
  // Geometry engineered so that:
  //   cosine(A-FRONT, B-FRONT) = ~0.95   different products, same angle
  //   cosine(A-FRONT, A-LEFT)  = ~0.62   same product, different angle
  //   plus a crowd of BACK views scoring between the two.
  const aFront = v(1, 0, 0);
  const bFront = v(0.95, Math.sqrt(1 - 0.95 ** 2), 0);          // 0.95 to aFront
  const aLeft  = v(0.62, 0, Math.sqrt(1 - 0.62 ** 2));          // 0.62 to aFront
  const crowd = Array.from({ length: 8 }, (_, i) => {
    const c = 0.8 - i * 0.01;                                    // 0.80 .. 0.73
    return v(c, Math.sqrt(1 - c * c) * 0.1, Math.sqrt(1 - c * c) * 0.99);
  });
  const vectors = [aFront, bFront, aLeft, ...crowd];
  const angles  = ['FRONT', 'FRONT', 'LEFT', ...crowd.map(() => 'BACK')];

  it('(1) the same-angle distractor NEVER enters the pool, however similar', () => {
    const pools = buildPools(vectors, angles, new Set());
    const pool = pools.find((p) => p.anchor === 0)!;
    expect(pool.candidates).not.toContain(1); // B-FRONT: 0.95 cosine, excluded
  });

  it('(2) stratification holds the true cross-angle match against the crowd', () => {
    const pools = buildPools(vectors, angles, new Set());
    const pool = pools.find((p) => p.anchor === 0)!;
    // Global top-6 by cosine would be six BACKs (0.80..0.75) — A-LEFT at 0.62
    // would be crowded out. The reserved LEFT slot must keep it.
    expect(pool.candidates).toContain(2);
  });
});

describe('buildPools mechanics', () => {
  it('excludes recorded NOT-SAME pairs', () => {
    const vectors = [v(1, 0), v(0.9, 0.1), v(0.8, 0.2)];
    const angles = ['FRONT', 'BACK', 'LEFT'];
    const pools = buildPools(vectors, angles, new Set([pairKey(0, 1)]));
    expect(pools.find((p) => p.anchor === 0)!.candidates).not.toContain(1);
  });
  it('marks truncation only when eligible neighbours were cut off', () => {
    const many = Array.from({ length: 10 }, (_, i) => v(1, i * 0.01));
    const angles = ['FRONT', ...Array.from({ length: 9 }, () => 'BACK')];
    const pools = buildPools(many, angles, new Set());
    const pool = pools.find((p) => p.anchor === 0)!;
    expect(pool.candidates.length).toBe(POOL_SIZE);
    expect(pool.truncated).toBe(true);
  });
  it('a photograph without a vector gets an empty, untruncated pool', () => {
    const pools = buildPools([null, v(1, 0)], ['FRONT', 'BACK'], new Set());
    expect(pools.find((p) => p.anchor === 0)!).toEqual({
      anchor: 0, candidates: [], truncated: false,
    });
  });
  it('is deterministic: equal cosines break on folder order', () => {
    const vectors = [v(1, 0), v(0.9, 0.435889894354), v(0.9, 0.435889894354)];
    const angles = ['FRONT', 'BACK', 'BACK'];
    const a = buildPools(vectors, angles, new Set());
    const b = buildPools(vectors, angles, new Set());
    expect(a).toEqual(b);
    expect(a.find((p) => p.anchor === 0)!.candidates).toEqual([1, 2]);
  });
});

describe('poolsFromSignatures (R1: signature-distance sibling of buildPools)', () => {
  const flatHist = (bin: number): Float32Array => {
    const h = new Float32Array(64);
    h[bin] = 1;
    return h;
  };
  const sig = (bin: number): Signature => ({ bits: new Uint8Array(8), hist: flatHist(bin) });

  it('excludes same-angle photographs, ranked by visualDistance ascending', () => {
    // anchor (bin 0) is IDENTICAL in histogram to photo 2 (bin 0, distance 0)
    // and different from photo 1 (bin 1, distance > 0). Photo 1 is also FRONT,
    // same angle as the anchor, so it must never appear regardless of distance.
    const signatures = [sig(0), sig(1), sig(0)];
    const angles = ['FRONT', 'FRONT', 'LEFT'];
    const pools = poolsFromSignatures(signatures, angles, new Set());
    const pool = pools.find((p) => p.anchor === 0)!;
    expect(pool.candidates).not.toContain(1);
    expect(pool.candidates).toContain(2);
  });
});

describe('angle-pair floors', () => {
  it('computes per-pair floors only where the sample is big enough', () => {
    // 8 FRONTs and 8 BACKs -> 64 FRONT|BACK samples (>= MIN_FLOOR_SAMPLES).
    // 2 TOPs -> FRONT|TOP has 16 samples (< 30): no floor.
    const fronts = Array.from({ length: 8 }, (_, i) => v(1, i * 0.05, 0));
    const backs  = Array.from({ length: 8 }, (_, i) => v(0.3, 1, i * 0.05));
    const tops   = Array.from({ length: 2 }, (_, i) => v(0, i * 0.05, 1));
    const vectors = [...fronts, ...backs, ...tops];
    const angles = [
      ...fronts.map(() => 'FRONT'), ...backs.map(() => 'BACK'), ...tops.map(() => 'TOP'),
    ];
    const floors = pairFloors(vectors, angles);
    expect(floors.has(floorKey('FRONT', 'BACK'))).toBe(true);
    expect(floors.has(floorKey('FRONT', 'TOP'))).toBe(false);
  });
  it('floorOf returns null for unlabelled photographs and unsampled pairs', () => {
    const floors = new Map([[floorKey('FRONT', 'BACK'), 0.5]]);
    expect(floorOf(floors, 'FRONT', 'BACK')).toBe(0.5);
    expect(floorOf(floors, 'FRONT', undefined)).toBeNull();
    expect(floorOf(floors, 'FRONT', 'SOLE')).toBeNull();
  });
  it('marginOf falls back to raw cosine without a floor', () => {
    expect(marginOf(0.62, 0.5)).toBeCloseTo(0.12);
    expect(marginOf(0.62, null)).toBeCloseTo(0.62);
  });
  it('THE FLOOR NEVER PRUNES: a pool keeps candidates below every floor', () => {
    // One FRONT anchor, one LEFT candidate at low cosine; floors made
    // artificially high must not remove it (floors are not even an input
    // to buildPools - this test documents that fact).
    const pools = buildPools([v(1, 0), v(0.1, 1)], ['FRONT', 'LEFT'], new Set());
    expect(pools.find((p) => p.anchor === 0)!.candidates).toContain(1);
  });
});
