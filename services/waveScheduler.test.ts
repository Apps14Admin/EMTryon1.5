import { describe, expect, it } from 'vitest';
import { LinkGraph } from './linkGraph';
import { WAVE_WIDTH, buildWave, byPriority, livePools } from './waveScheduler';
import { Pool } from './candidatePool';

const pool = (anchor: number, candidates: number[]): Pool =>
  ({ anchor, candidates, truncated: false });
const idOf = (i: number) => `p${i}`;
const flatMargin = () => 0.5;

describe('livePools', () => {
  it('drops candidates already resolved by transitivity', () => {
    const g = new LinkGraph(['p0', 'p1', 'p2'], () => undefined);
    // A merge needs two independently-anchored sure-SAME votes: p0's vote
    // alone only parks pending; p1's reciprocal vote (different anchor)
    // actually merges them.
    g.add({ a: 'p0', b: 'p1', same: true, sure: true, anchor: 'p0', requestId: 'r' });
    g.add({ a: 'p1', b: 'p0', same: true, sure: true, anchor: 'p1', requestId: 'r' });
    const live = livePools([pool(0, [1, 2])], idOf, g, flatMargin);
    expect(live[0].live).toEqual([2]);
  });
  it('drops candidates barred by NOT-SAME or angle', () => {
    const angles: Record<string, string> = { p0: 'FRONT', p2: 'FRONT' };
    const g = new LinkGraph(['p0', 'p1', 'p2'], (id) => angles[id]);
    g.add({ a: 'p0', b: 'p1', same: false, sure: true, anchor: 'p0', requestId: 'r' });
    // p2 shares FRONT with p0 via clusters-of-one: cannotJoin is true
    const live = livePools([pool(0, [1, 2])], idOf, g, flatMargin);
    expect(live.length).toBe(0);   // both resolved -> anchor skipped entirely, free
  });
  it('keeps unresolved anchors with their live candidates', () => {
    const g = new LinkGraph(['p0', 'p1'], () => undefined);
    const live = livePools([pool(0, [1])], idOf, g, flatMargin);
    expect(live).toEqual([{ anchor: 0, live: [1], bestMargin: 0.5 }]);
  });
});

describe('byPriority', () => {
  it('orders by live count, then margin, then folder order', () => {
    const a = { anchor: 5, live: [1, 2, 3], bestMargin: 0.1 };
    const b = { anchor: 2, live: [1, 2], bestMargin: 0.9 };
    const c = { anchor: 1, live: [1, 2], bestMargin: 0.9 };
    expect([a, b, c].sort(byPriority).map((x) => x.anchor)).toEqual([5, 1, 2]);
  });
});

describe('buildWave', () => {
  it('takes only pairwise-disjoint pools', () => {
    const queue = [
      { anchor: 0, live: [1, 2], bestMargin: 0.9 },
      { anchor: 3, live: [2, 4], bestMargin: 0.8 },   // shares 2 with the first
      { anchor: 5, live: [6], bestMargin: 0.7 },
    ].sort(byPriority);
    const wave = buildWave(queue, 10);
    expect(wave.map((w) => w.anchor)).toEqual([0, 5]);
  });
  it('a candidate that is another wave-member anchor is an overlap', () => {
    const queue = [
      { anchor: 0, live: [3], bestMargin: 0.9 },
      { anchor: 3, live: [7], bestMargin: 0.8 },       // 3 is already in wave as a candidate
    ].sort(byPriority);
    expect(buildWave(queue, 10).map((w) => w.anchor)).toEqual([0]);
  });
  it('respects the width limit', () => {
    const queue = Array.from({ length: 20 }, (_, i) => ({
      anchor: i * 10, live: [i * 10 + 1], bestMargin: 0.5,
    }));
    expect(buildWave(queue, WAVE_WIDTH).length).toBe(WAVE_WIDTH);
  });
  it('is deterministic for a given queue', () => {
    const queue = [
      { anchor: 2, live: [5], bestMargin: 0.5 },
      { anchor: 1, live: [6], bestMargin: 0.5 },
    ].sort(byPriority);
    expect(buildWave(queue, 10)).toEqual(buildWave(queue, 10));
    expect(buildWave(queue, 10).map((w) => w.anchor)).toEqual([1, 2]);
  });
});
