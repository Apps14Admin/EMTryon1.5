import { describe, expect, it } from 'vitest';
import { LinkGraph, Link } from './linkGraph';

const link = (a: string, b: string, same: boolean, sure = true, because?: string): Link =>
  ({ a, b, same, sure, because, anchor: a, requestId: 'r' });

// A sure-SAME vote with an EXPLICIT anchor, for the two-vote merge dance
// (Change A): a pair merges only once two votes anchored from DIFFERENT
// members have both said SAME.
const vote = (a: string, b: string, anchor: string, because?: string): Link =>
  ({ a, b, same: true, sure: true, because, anchor, requestId: 'r' });

const graph = (ids: string[], angles: Record<string, string | undefined>) =>
  new LinkGraph(ids, (id) => angles[id]);

describe('the invariant (spec rule 1)', () => {
  it('refuses a direct same-angle merge at ANY confidence', () => {
    const g = graph(['a', 'b'], { a: 'FRONT', b: 'FRONT' });
    expect(g.add(link('a', 'b', true))).toBe('refused-angle');
    expect(g.sameCluster('a', 'b')).toBe(false);
  });
  it('refuses a TRANSITIVE merge that would collide angles', () => {
    const g = graph(['a', 'b', 'c', 'd'],
      { a: 'FRONT', b: 'LEFT', c: 'FRONT', d: 'BACK' });
    g.add(vote('a', 'b', 'a'));
    g.add(vote('a', 'b', 'b'));         // cluster {a,b}
    g.add(vote('c', 'd', 'c'));
    g.add(vote('c', 'd', 'd'));         // cluster {c,d}
    // joining b-d would put two FRONTs (a and c) in one cluster
    expect(g.add(link('b', 'd', true))).toBe('refused-angle');
  });
  it('CLOSEUP photographs carry no cannot-link', () => {
    const g = graph(['a', 'b'], { a: 'CLOSEUP', b: 'CLOSEUP' });
    expect(g.add(vote('a', 'b', 'a'))).toBe('pending');
    expect(g.add(vote('a', 'b', 'b'))).toBe('merged');
  });

  it('PROPERTY: no cluster ever holds two same-bucket photos, under fuzz', () => {
    let seed = 42;
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 0x100000000;
    };
    const buckets = ['FRONT', 'BACK', 'LEFT', 'RIGHT', 'TOP', 'SOLE', undefined];
    for (let round = 0; round < 50; round += 1) {
      const ids = Array.from({ length: 30 }, (_, i) => `p${i}`);
      const angles: Record<string, string | undefined> = {};
      ids.forEach((id) => { angles[id] = buckets[Math.floor(rand() * buckets.length)]; });
      const g = graph(ids, angles);
      for (let n = 0; n < 200; n += 1) {
        const a = ids[Math.floor(rand() * ids.length)];
        const b = ids[Math.floor(rand() * ids.length)];
        if (a === b) continue;
        const same = rand() < 0.7;
        const sure = rand() < 0.8;
        g.add(link(a, b, same, sure));
        // Change A: a merge needs a second vote anchored from the OTHER
        // member. Emit that reciprocal ~60% of the time so merges actually
        // happen under fuzz without making every SAME vote deterministic.
        if (same && sure && rand() < 0.6) {
          g.add(vote(a, b, b));
        }
      }
      g.clusters().forEach((cluster) => {
        const seen = new Set<string>();
        cluster.forEach((id) => {
          const bucket = angles[id];
          if (bucket === undefined) return;
          expect(seen.has(bucket)).toBe(false);
          seen.add(bucket);
        });
      });
    }
  });
});

describe('evidence discipline (spec rules 2-5)', () => {
  it('an unsure answer changes nothing', () => {
    const g = graph(['a', 'b'], { a: 'FRONT', b: 'BACK' });
    expect(g.add(link('a', 'b', true, false))).toBe('ignored-unsure');
    expect(g.add(link('a', 'b', false, false))).toBe('ignored-unsure');
    expect(g.sameCluster('a', 'b')).toBe(false);
    expect(g.isNotSame('a', 'b')).toBe(false);
  });
  it('a sure NOT-SAME bars a later merge and marks the retry contested', () => {
    const g = graph(['a', 'b'], { a: 'FRONT', b: 'BACK' });
    g.add(link('a', 'b', false));
    expect(g.add(link('a', 'b', true))).toBe('refused-different');
    expect(g.contested().size).toBe(1);
  });
  it('a NOT-SAME between clusters bars merging them through other members', () => {
    const g = graph(['a', 'b', 'c'], { a: 'FRONT', b: 'BACK', c: 'LEFT' });
    g.add(vote('a', 'b', 'a'));
    g.add(vote('a', 'b', 'b'));             // cluster {a,b}
    g.add(link('a', 'c', false));           // a and c are different products
    expect(g.add(link('b', 'c', true))).toBe('refused-different');
  });
  it('disagreement after a merge flags, never splits', () => {
    const g = graph(['a', 'b'], { a: 'FRONT', b: 'BACK' });
    g.add(vote('a', 'b', 'a'));
    g.add(vote('a', 'b', 'b'));
    g.add(link('a', 'b', false));
    expect(g.sameCluster('a', 'b')).toBe(true);   // not silently unwound
    expect(g.contested().size).toBe(1);            // but loudly flagged
  });
});

describe('two independent votes required to merge (Change A)', () => {
  it('one sure SAME alone never merges', () => {
    const g = graph(['a', 'b'], { a: 'FRONT', b: 'LEFT' });
    expect(g.add(vote('a', 'b', 'a'))).toBe('pending');
    expect(g.sameCluster('a', 'b')).toBe(false);
  });

  it('a second vote from the SAME anchor never merges', () => {
    const g = graph(['a', 'b'], { a: 'FRONT', b: 'LEFT' });
    expect(g.add(vote('a', 'b', 'a'))).toBe('pending');
    expect(g.add(vote('a', 'b', 'a'))).toBe('pending');   // repeat framing
    expect(g.sameCluster('a', 'b')).toBe(false);
  });

  it('a second vote from the other framing merges', () => {
    const g = graph(['a', 'b'], { a: 'FRONT', b: 'LEFT' });
    expect(g.add(vote('a', 'b', 'a'))).toBe('pending');
    expect(g.add(vote('a', 'b', 'b'))).toBe('merged');
    expect(g.sameCluster('a', 'b')).toBe(true);
  });

  it('a pending SAME overturned by a sure NOT-SAME never merges, and stops being pending', () => {
    const g = graph(['a', 'b'], { a: 'FRONT', b: 'LEFT' });
    expect(g.add(vote('a', 'b', 'a'))).toBe('pending');
    expect(g.pendingPairs()).toEqual([{ a: 'a', b: 'b', anchor: 'a' }]);
    expect(g.add(link('a', 'b', false))).toBe('recorded-different');
    expect(g.sameCluster('a', 'b')).toBe(false);
    expect(g.contested().size).toBe(1);
    expect(g.pendingPairs()).toEqual([]);
  });

  it('pendingPairs lists exactly the single-vote pairs', () => {
    const g = graph(['a', 'b', 'c', 'd'],
      { a: 'FRONT', b: 'LEFT', c: 'FRONT', d: 'BACK' });
    g.add(vote('a', 'b', 'a'));                 // pending: a-b
    g.add(vote('c', 'd', 'c'));                 // pending: c-d
    expect(g.pendingPairs()).toEqual([
      { a: 'a', b: 'b', anchor: 'a' },
      { a: 'c', b: 'd', anchor: 'c' },
    ]);
    g.add(vote('c', 'd', 'd'));                 // confirms c-d: merged
    expect(g.pendingPairs()).toEqual([{ a: 'a', b: 'b', anchor: 'a' }]);
  });
});

describe('provenance (spec section 9)', () => {
  it('separates direct joins from transitive ones, with hops', () => {
    const g = graph(['a', 'b', 'c'], { a: 'FRONT', b: 'BACK', c: 'LEFT' });
    g.add(vote('a', 'b', 'a', 'same heel logo'));
    g.add(vote('a', 'b', 'b'));
    g.add(vote('b', 'c', 'b', 'same tread'));
    g.add(vote('b', 'c', 'c'));
    const prov = g.provenanceOf('a');
    expect(prov.get('b')).toEqual({ to: 'a', kind: 'direct', because: 'same heel logo' });
    expect(prov.get('c')).toEqual({ to: 'b', kind: 'direct', because: 'same tread', hops: 2 });
    // a<->c were never directly compared:
    expect(g.directLinks('a').some((l) =>
      (l.a === 'a' && l.b === 'c') || (l.a === 'c' && l.b === 'a'))).toBe(false);
  });
  it('clusters come out in deterministic folder order', () => {
    const g = graph(['a', 'b', 'c'], {});
    g.add(vote('c', 'b', 'c'));
    g.add(vote('c', 'b', 'b'));
    expect(g.clusters()).toEqual([['a'], ['b', 'c']]);
  });
});
