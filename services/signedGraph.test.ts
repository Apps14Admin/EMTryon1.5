import { describe, expect, it } from 'vitest';
import { cluster, foldJudgements, pairKey, Judgement } from './signedGraph';

const same = (a: string, b: string, confidence = 1, reason?: string): Judgement =>
  ({ a, b, same: true, confidence, reason });
const different = (a: string, b: string, confidence = 1, reason?: string): Judgement =>
  ({ a, b, same: false, confidence, reason });

/** Cluster contents, order-independent, so a test asserts membership not layout. */
const shape = (clusters: string[][]) =>
  clusters.map((ids) => [...ids].sort()).sort((x, y) => x[0].localeCompare(y[0]));

describe('pairKey', () => {
  it('is the same whichever way round the pair is given', () => {
    expect(pairKey('b', 'a')).toBe(pairKey('a', 'b'));
  });
});

describe('foldJudgements', () => {
  it('keeps one judgement per pair', () => {
    expect(foldJudgements([same('a', 'b'), same('b', 'a')])).toHaveLength(1);
  });

  it('lets one DIFFERENT beat one SAME of equal weight', () => {
    // The asymmetry, at the only place it belongs: evenly balanced evidence
    // about a pair means two items, because a wrong merge cannot be undone
    // from the renders it produces and a wrong split is one click.
    const folded = foldJudgements([same('a', 'b', 0.9), different('a', 'b', 0.9)]);

    expect(folded).toHaveLength(1);
    expect(folded[0].same).toBe(false);
  });

  it('does NOT let one hedged DIFFERENT overrule two confident SAMEs', () => {
    // This was the original rule and it was wrong. Under it, one mistaken
    // DIFFERENT permanently split a real product, and asking more sheets made
    // the folder worse rather than better.
    const folded = foldJudgements([
      same('a', 'b', 0.9),
      same('a', 'b', 0.9),
      different('a', 'b', 0.35),
    ]);

    expect(folded[0].same).toBe(true);
  });

  it('reports a contested pair as weak even when one side wins', () => {
    // Two against one is a win, not a certainty. The margin is what reaches the
    // review screen, so a pair the model judged both ways surfaces as a product
    // to look at rather than a settled one.
    const contested = foldJudgements([
      same('a', 'b', 0.9),
      same('a', 'b', 0.9),
      different('a', 'b', 0.9),
    ])[0];

    const unanimous = foldJudgements([same('c', 'd', 0.9), same('c', 'd', 0.9)])[0];

    expect(contested.same).toBe(true);
    expect(contested.confidence!).toBeLessThan(unanimous.confidence!);
    expect(unanimous.confidence).toBeCloseTo(0.9);
  });

  it('lets two confident DIFFERENTs beat one confident SAME', () => {
    const folded = foldJudgements([
      same('a', 'b', 0.9),
      different('a', 'b', 0.9),
      different('a', 'b', 0.9),
    ]);

    expect(folded[0].same).toBe(false);
  });

  it('keeps the surest reason among judgements that agree', () => {
    const folded = foldJudgements([
      same('a', 'b', 0.6, 'both look black'),
      same('a', 'b', 0.95, 'same hexagonal tread'),
    ]);

    expect(folded[0].reason).toBe('same hexagonal tread');
  });

  it('drops a judgement comparing a photograph with itself', () => {
    expect(foldJudgements([same('a', 'a')])).toEqual([]);
  });
});

describe('cluster', () => {
  it('makes every photograph its own product when nothing was judged', () => {
    const { clusters } = cluster(['a', 'b', 'c'], []);
    expect(shape(clusters)).toEqual([['a'], ['b'], ['c']]);
  });

  it('keeps a photograph nothing was asked about', () => {
    const { clusters } = cluster(['a', 'b', 'orphan'], [same('a', 'b')]);
    expect(shape(clusters)).toEqual([['a', 'b'], ['orphan']]);
  });

  it('joins a chain of same-item judgements into one product', () => {
    // The case the whole rewrite exists for: five angles of one shoe, where
    // no single pair of them was judged directly against every other.
    const { clusters } = cluster(
      ['front', 'back', 'left', 'right', 'sole'],
      [
        same('front', 'left'),
        same('left', 'back'),
        same('back', 'right'),
        same('right', 'sole'),
      ]
    );

    expect(shape(clusters)).toEqual([['back', 'front', 'left', 'right', 'sole']]);
  });

  it('does not let two different products merge through a shared lookalike', () => {
    const { clusters, contradictions } = cluster(
      ['a', 'b', 'c'],
      [same('a', 'b'), same('b', 'c'), different('a', 'c')]
    );

    expect(clusters).toHaveLength(2);
    expect(contradictions).toHaveLength(1);
    expect(contradictions[0].blockedBy.same).toBe(false);
  });

  it('reports which pair refused a join', () => {
    const { contradictions } = cluster(
      ['a', 'b', 'c'],
      [
        same('a', 'b', 0.9),
        same('b', 'c', 0.5),
        different('a', 'c', 1, 'gum sole, not white'),
      ]
    );

    expect(contradictions[0].blockedBy.reason).toBe('gum sole, not white');
    expect(contradictions[0].wanted.a).toBe('b');
  });

  it('honours the surest join first, so a weak edge cannot decide the split', () => {
    // a~b is near-certain and b~c is a guess. With a≠c on record only one of
    // the two can stand, and it has to be the certain one.
    const { clusters } = cluster(
      ['a', 'b', 'c'],
      [same('b', 'c', 0.3), same('a', 'b', 0.99), different('a', 'c')]
    );

    expect(shape(clusters)).toEqual([['a', 'b'], ['c']]);
  });

  it('carries a conflict through a merge, so it still refuses afterwards', () => {
    // The bug a plain union-find has here. `a` is different from `b`. Then `b`
    // absorbs `d`, so the root that carried the conflict stops being a root.
    // If the conflict is not re-pointed at the winner, a~d merges everything.
    const { clusters } = cluster(
      ['a', 'b', 'd'],
      [different('a', 'b'), same('b', 'd', 0.9), same('a', 'd', 0.8)]
    );

    expect(clusters).toHaveLength(2);
    expect(shape(clusters)).toEqual([['a'], ['b', 'd']]);
  });

  it('carries a conflict through a merge on the OTHER side too', () => {
    // Same fact, mirrored: the conflict is recorded against `a`, and it is `a`
    // that later loses a union rather than `b`.
    const { clusters } = cluster(
      ['a', 'b', 'x', 'y', 'z'],
      [
        different('a', 'b'),
        same('a', 'x', 0.95),
        same('x', 'y', 0.95),
        same('y', 'z', 0.95),
        same('b', 'z', 0.9),
      ]
    );

    // a-x-y-z is one product and b is refused entry to it, because b is a
    // different item from a and a is in there.
    expect(shape(clusters)).toEqual([['a', 'x', 'y', 'z'], ['b']]);
  });

  it('separates two full products that were never compared to each other', () => {
    const { clusters } = cluster(
      ['s1', 's2', 's3', 't1', 't2', 't3'],
      [same('s1', 's2'), same('s2', 's3'), same('t1', 't2'), same('t2', 't3')]
    );

    expect(shape(clusters)).toEqual([
      ['s1', 's2', 's3'],
      ['t1', 't2', 't3'],
    ]);
  });

  it('keeps two near-identical products apart on one confirmed difference', () => {
    // The failure the old attribute arithmetic could not survive: two
    // colourways of one model, five photographs each, every written
    // description near-identical. One DIFFERENT anywhere across the two sets
    // is enough, because it propagates through both products' conflict sets.
    const white = ['w1', 'w2', 'w3', 'w4', 'w5'];
    const black = ['b1', 'b2', 'b3', 'b4', 'b5'];

    const judgements: Judgement[] = [];
    for (let i = 1; i < white.length; i += 1) judgements.push(same(white[0], white[i], 0.95));
    for (let i = 1; i < black.length; i += 1) judgements.push(same(black[0], black[i], 0.95));
    judgements.push(different('w1', 'b1', 1, 'white lining vs black lining'));
    // And a lookalike pair the judge got wrong, across the two products.
    judgements.push(same('w3', 'b4', 0.55));

    const { clusters, contradictions } = cluster([...white, ...black], judgements);

    expect(shape(clusters)).toEqual([
      ['b1', 'b2', 'b3', 'b4', 'b5'],
      ['w1', 'w2', 'w3', 'w4', 'w5'],
    ]);
    expect(contradictions).toHaveLength(1);
  });

  it('gives the same products whatever order the judgements arrive in', () => {
    const judgements = [
      same('a', 'b', 0.9),
      same('c', 'd', 0.8),
      different('a', 'c'),
      same('b', 'e', 0.7),
    ];

    const forwards = shape(cluster(['a', 'b', 'c', 'd', 'e'], judgements).clusters);
    const backwards = shape(cluster(['a', 'b', 'c', 'd', 'e'], [...judgements].reverse()).clusters);

    expect(forwards).toEqual(backwards);
  });

  it('accounts for every photograph exactly once', () => {
    const ids = Array.from({ length: 40 }, (_, i) => `p${i}`);
    const judgements: Judgement[] = [];
    for (let i = 0; i < 39; i += 2) judgements.push(same(ids[i], ids[i + 1], 0.8));
    for (let i = 0; i < 20; i += 3) judgements.push(different(ids[i], ids[i + 5]));

    const { clusters } = cluster(ids, judgements);
    const seen = clusters.flat();

    expect(seen).toHaveLength(ids.length);
    expect(new Set(seen).size).toBe(ids.length);
  });
});

describe('one photograph per angle', () => {
  const angles: Record<string, string> = {};
  const angleOf = (id: string) => angles[id];

  it('refuses a join that would give one product two BACK views', () => {
    // The failure from the real folder: two grey trainers, both photographed
    // from the heel, judged the same item. Two heel-on shots of two grey
    // trainers resemble each other far more than either resembles its own
    // item's underside, so this is exactly where the judge is weakest.
    angles.a = 'BACK';
    angles.b = 'BACK';

    const { clusters } = cluster(['a', 'b'], [same('a', 'b', 0.9)], { angleOf });

    expect(clusters).toHaveLength(2);
  });

  it('allows a join between two different angles', () => {
    angles.a = 'BACK';
    angles.b = 'SOLE';

    const { clusters } = cluster(['a', 'b'], [same('a', 'b', 0.9)], { angleOf });

    expect(clusters).toHaveLength(1);
  });

  it('never caps CLOSEUP or OTHER — a shoot takes as many detail shots as it likes', () => {
    angles.a = 'CLOSEUP';
    angles.b = 'CLOSEUP';
    angles.c = 'OTHER';
    angles.d = 'OTHER';

    const { clusters } = cluster(
      ['a', 'b', 'c', 'd'],
      [same('a', 'b', 0.9), same('b', 'c', 0.9), same('c', 'd', 0.9)],
      { angleOf }
    );

    expect(clusters).toHaveLength(1);
  });

  it('carries the constraint through an earlier merge', () => {
    // `a` and `b` join on different angles. `c` is another BACK, and must be
    // refused entry to the product `b` has already put a BACK into.
    angles.a = 'LEFT';
    angles.b = 'BACK';
    angles.c = 'BACK';

    const { clusters } = cluster(
      ['a', 'b', 'c'],
      [same('a', 'b', 0.95), same('a', 'c', 0.9)],
      { angleOf }
    );

    expect(clusters).toHaveLength(2);
    expect(clusters.find((g) => g.includes('a'))).toHaveLength(2);
  });

  it('applies no angle constraint at all when none is supplied', () => {
    angles.a = 'BACK';
    angles.b = 'BACK';

    const { clusters } = cluster(['a', 'b'], [same('a', 'b', 0.9)]);

    expect(clusters).toHaveLength(1);
  });

  it('ignores a photograph whose angle was never read', () => {
    angles.a = 'BACK';
    delete angles.b;

    const { clusters } = cluster(['a', 'b'], [same('a', 'b', 0.9)], { angleOf });

    expect(clusters).toHaveLength(1);
  });

  it('still accounts for every photograph exactly once', () => {
    ['a', 'b', 'c', 'd'].forEach((id) => {
      angles[id] = 'BACK';
    });

    const { clusters } = cluster(
      ['a', 'b', 'c', 'd'],
      [same('a', 'b', 0.9), same('b', 'c', 0.9), same('c', 'd', 0.9)],
      { angleOf }
    );

    const seen = clusters.flat();
    expect(seen).toHaveLength(4);
    expect(new Set(seen).size).toBe(4);
  });
});
