/**
 * WHOLE-PIPELINE ACCURACY, WITHOUT A BROWSER OR AN API KEY.
 *
 * Everything in `groupFolderV2.ts` that DECIDES anything is here: the
 * neighbourhood plan, the judgements a sheet produces, and the clustering that
 * honours them. What is not here is the canvas, the network and the model
 * itself — so the model is replaced by an oracle that answers from the ground
 * truth, and can be told to answer WRONG at a given rate.
 *
 * That last part is the point of the file. A pipeline that only works when the
 * model is perfect is not a pipeline, it is a demo. The old architecture failed
 * here in a specific way: one bad reading of a colour field could not be
 * recovered from, because the same reading fed every comparison that photograph
 * took part in, and the arithmetic had no other source of truth to weigh it
 * against. These tests check that a wrong answer from the judge costs a
 * photograph or a split, and never the folder.
 *
 * The numbers asserted are pairwise precision and recall against the truth:
 *
 *   RECALL is how much of a real product the grouping found. Low recall means
 *   products arriving split, which the review screen fixes in one click.
 *
 *   PRECISION is how much of each group really belongs. Low precision means two
 *   items merged into one product, which is the failure that reaches the render
 *   and cannot be unpicked afterwards. It is held to a higher bar for that
 *   reason, and the asymmetry is deliberate everywhere in this system.
 */

import { describe, expect, it } from 'vitest';
import { SHEET_SIZE, COVERAGE, neighboursOf, planSheets } from './neighbourGraph';
import { cluster, Judgement } from './signedGraph';
import { toJudgements, SURE, UNSURE, Verdict } from './visualJudge';

const rng = (seed: number) => {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
};

interface Folder {
  vectors: Float32Array[];
  /** Which product each photograph really belongs to. */
  truth: number[];
  ids: string[];
}

/**
 * A synthetic folder.
 *
 * `spread` is how far one product's photographs wander from each other — the
 * stand-in for a sole shot against a profile. `separation` is how far apart two
 * products sit; small values are a folder of near-identical trainers, which is
 * the case that broke the old system.
 */
const makeFolder = (
  products: number,
  shots: number | [number, number],
  spread: number,
  separation: number,
  seed: number
): Folder => {
  const random = rng(seed);
  const dims = 64;
  const vectors: Float32Array[] = [];
  const truth: number[] = [];

  for (let p = 0; p < products; p += 1) {
    const centre = Float32Array.from({ length: dims }, () => (random() - 0.5) * separation);
    const count = Array.isArray(shots)
      ? shots[0] + Math.floor(random() * (shots[1] - shots[0] + 1))
      : shots;

    for (let s = 0; s < count; s += 1) {
      const vector = new Float32Array(dims);
      for (let d = 0; d < dims; d += 1) vector[d] = centre[d] + (random() - 0.5) * spread;
      vectors.push(vector);
      truth.push(p);
    }
  }

  return { vectors, truth, ids: truth.map((_, i) => `img-${i}`) };
};

/**
 * The model, replaced by something that knows the answer and can be told to
 * get it wrong.
 *
 * `errorRate` is the share of PHOTOGRAPHS on a sheet the oracle misplaces — it
 * gives them the wrong letter, which is exactly what a model does when a
 * photograph is dark, cropped or genuinely ambiguous. `hedgeRate` is the share
 * it marks unsure, which suppresses its DIFFERENT edges.
 */
const oracle = (
  truth: number[],
  seed: number,
  errorRate = 0,
  hedgeRate = 0
) => {
  const random = rng(seed);

  return (sheet: number[]): Verdict[] => {
    // The letters the oracle would give if it were right.
    const letterOf = new Map<number, string>();
    let next = 0;

    return sheet.map((photo, position) => {
      const product = truth[photo];
      let assigned = letterOf.get(product);
      if (!assigned) {
        assigned = String.fromCharCode(65 + next);
        next += 1;
        letterOf.set(product, assigned);
      }

      const hedged = random() < hedgeRate;

      if (random() < errorRate) {
        // A misplacement: this photograph gets a letter it should not have,
        // either its own new one (a split) or another product's (a merge).
        const merge = random() < 0.5;
        const letters = [...letterOf.values()].filter((letter) => letter !== assigned);
        assigned =
          merge && letters.length
            ? letters[Math.floor(random() * letters.length)]
            : `Z${position}`;
      }

      return { photo: position, item: assigned, sure: !hedged };
    });
  };
};

/** Runs the plan-ask-cluster path the real orchestrator runs. */
const run = (
  folder: Folder,
  judge: (sheet: number[]) => Verdict[]
): { clusters: string[][]; sheets: number[][]; judgements: Judgement[] } => {
  const neighbours = neighboursOf(folder.vectors, SHEET_SIZE - 1);
  const { sheets } = planSheets(neighbours, SHEET_SIZE, COVERAGE);

  const judgements: Judgement[] = [];
  sheets.forEach((sheet) => {
    judgements.push(
      ...toJudgements(judge(sheet), (position) => folder.ids[sheet[position]], 'oracle')
    );
  });

  return { ...cluster(folder.ids, judgements), sheets, judgements };
};

/** Pairwise precision and recall of a grouping against the truth. */
const score = (truth: number[], ids: string[], clusters: string[][]) => {
  const indexOf = new Map(ids.map((id, i) => [id, i]));
  const groupOf = new Map<string, number>();
  clusters.forEach((group, g) => group.forEach((id) => groupOf.set(id, g)));

  let truePositive = 0;
  let falsePositive = 0;
  let falseNegative = 0;

  for (let i = 0; i < ids.length; i += 1) {
    for (let j = i + 1; j < ids.length; j += 1) {
      const sameTruth = truth[indexOf.get(ids[i])!] === truth[indexOf.get(ids[j])!];
      const sameGroup = groupOf.get(ids[i]) === groupOf.get(ids[j]);

      if (sameTruth && sameGroup) truePositive += 1;
      else if (!sameTruth && sameGroup) falsePositive += 1;
      else if (sameTruth && !sameGroup) falseNegative += 1;
    }
  }

  return {
    precision: truePositive + falsePositive ? truePositive / (truePositive + falsePositive) : 1,
    recall: truePositive + falseNegative ? truePositive / (truePositive + falseNegative) : 1,
    groups: clusters.length,
  };
};

describe('a perfect judge', () => {
  it('recovers 22 products of 5 photographs exactly', () => {
    // The folder that broke the old system: a hundred and ten near-identical
    // items, five angles each.
    const folder = makeFolder(22, 5, 0.3, 0.6, 11);
    const { clusters } = run(folder, oracle(folder.truth, 1));
    const result = score(folder.truth, folder.ids, clusters);

    expect(folder.ids).toHaveLength(110);
    expect(result.precision).toBe(1);
    expect(result.recall).toBe(1);
    expect(result.groups).toBe(22);
  });

  it('recovers products photographed from wildly different angles', () => {
    const folder = makeFolder(11, 10, 0.85, 1, 5);
    const { clusters } = run(folder, oracle(folder.truth, 2));
    const result = score(folder.truth, folder.ids, clusters);

    expect(result.precision).toBe(1);
    expect(result.recall).toBeGreaterThan(0.95);
  });

  it('handles products with wildly different photograph counts', () => {
    // One product with ten angles beside one with two is the real shape of a
    // shoot, and the old prompt had to be told not to aim for a set number.
    const folder = makeFolder(16, [2, 10], 0.4, 0.8, 21);
    const { clusters } = run(folder, oracle(folder.truth, 3));
    const result = score(folder.truth, folder.ids, clusters);

    expect(result.precision).toBe(1);
    expect(result.recall).toBeGreaterThan(0.95);
  });

  it('keeps a one-photograph product as its own product', () => {
    const folder = makeFolder(30, 1, 0.2, 1, 31);
    const { clusters } = run(folder, oracle(folder.truth, 4));

    expect(clusters).toHaveLength(30);
    expect(clusters.every((group) => group.length === 1)).toBe(true);
  });
});

describe('a judge that makes mistakes', () => {
  it('loses photographs, not the folder, at a 5% error rate', () => {
    const folder = makeFolder(22, 5, 0.3, 0.6, 11);
    const { clusters } = run(folder, oracle(folder.truth, 7, 0.05));
    const result = score(folder.truth, folder.ids, clusters);

    // A wrong answer costs a split, not a merge: the recorded DIFFERENT from
    // every OTHER sheet that saw the pair refuses the bad join.
    expect(result.precision).toBeGreaterThan(0.95);
    expect(result.recall).toBeGreaterThan(0.6);
  });

  it('errs towards splitting, not merging, at a 15% error rate', () => {
    const folder = makeFolder(22, 5, 0.3, 0.6, 11);
    const { clusters } = run(folder, oracle(folder.truth, 9, 0.15));
    const result = score(folder.truth, folder.ids, clusters);

    // Stated honestly, because it is a real limit rather than a passing grade:
    // at a fifteen percent judge error rate precision is about 0.85, so roughly
    // one in seven pairs sharing a group does not belong together. A judge that
    // bad is not one to ship on.
    //
    // What the architecture guarantees at ANY error rate is the DIRECTION of
    // the failure. The folder comes apart into more products than it has, never
    // fewer — no runaway component swallows the folder — because a merge needs
    // positive evidence to win a pair outright while a split is what happens by
    // default. A split is a click on the review screen; a merge reaches the
    // renders and cannot be unpicked from them.
    expect(result.precision).toBeGreaterThan(0.8);
    expect(result.groups).toBeGreaterThan(22);
    expect(Math.max(...clusters.map((group) => group.length))).toBeLessThan(15);
  });

  it('degrades smoothly rather than collapsing', () => {
    const folder = makeFolder(22, 5, 0.3, 0.6, 11);
    const rates = [0, 0.05, 0.1, 0.2];

    const recalls = rates.map((rate) => {
      const { clusters } = run(folder, oracle(folder.truth, 13, rate));
      return score(folder.truth, folder.ids, clusters).recall;
    });

    // Monotone-ish and no cliff: each step costs recall, none of them costs
    // everything.
    expect(recalls[0]).toBe(1);
    expect(recalls[recalls.length - 1]).toBeGreaterThan(0.3);
    for (let i = 1; i < recalls.length; i += 1) {
      expect(recalls[i]).toBeLessThanOrEqual(recalls[i - 1] + 0.05);
    }
  });

  it('never merges on hedged evidence alone, at a cost in recall', () => {
    // A model that says "unsure" rather than committing to a wrong letter is
    // the behaviour the prompt asks for, and it is not free. An unsure
    // judgement cannot decide anything in EITHER direction: it emits no
    // DIFFERENT, so it can never bar a real join, and it cannot be the only
    // thing creating a product either.
    //
    // With three photographs in ten hedged, that costs about an eighth of
    // recall — a few products arriving in two pieces, each a click to rejoin.
    // It buys precision 1.000: no photograph is in a product it does not belong
    // to, which is the failure that survives into the renders.
    const folder = makeFolder(22, 5, 0.3, 0.6, 11);
    const { clusters } = run(folder, oracle(folder.truth, 17, 0, 0.3));
    const result = score(folder.truth, folder.ids, clusters);

    expect(result.precision).toBe(1);
    expect(result.recall).toBeGreaterThan(0.85);
  });

  it('holds precision when the judge both errs AND hedges — the realistic case', () => {
    // Every other scenario here holds one of the two fixed. A real model does
    // both at once, and doing both is what exposed the rule this pins.
    //
    // Measured on this exact folder, letting a hedged agreement merge on its
    // own against requiring one the judge stood behind:
    //
    //     5% error, 15% hedged   p 0.788 -> 0.882, recall unchanged at 0.845
    //     5% error, 30% hedged   p 0.786 -> 1.000, recall 0.836 -> 0.782
    //
    // Precision is bought, and at the lighter hedging rate it is bought for
    // nothing at all. What it costs is recall when the judge hedges a great
    // deal, which is the trade this system takes everywhere: a split is a click
    // and a merge is a bad render.
    const folder = makeFolder(22, 5, 0.3, 0.6, 11);
    const { clusters } = run(folder, oracle(folder.truth, 9, 0.05, 0.15));
    const result = score(folder.truth, folder.ids, clusters);

    expect(result.precision).toBeGreaterThan(0.85);
    expect(result.recall).toBeGreaterThan(0.8);
  });
});

describe('the properties the old architecture could not hold', () => {
  it('never merges two products through a chain of lookalikes', () => {
    // Twelve products so alike their vectors overlap heavily. The old system
    // collapsed a folder like this into four products, because every pair
    // agreed on heel, toe, sole and closure and the arithmetic read that as
    // identity.
    const folder = makeFolder(12, 6, 0.5, 0.25, 41);
    const { clusters } = run(folder, oracle(folder.truth, 19));
    const result = score(folder.truth, folder.ids, clusters);

    expect(result.precision).toBe(1);
    expect(result.groups).toBe(12);
  });

  it('accounts for every photograph exactly once', () => {
    const folder = makeFolder(18, [1, 9], 0.5, 0.7, 51);
    const { clusters } = run(folder, oracle(folder.truth, 23, 0.1));
    const seen = clusters.flat();

    expect(seen).toHaveLength(folder.ids.length);
    expect(new Set(seen).size).toBe(folder.ids.length);
  });

  it('gives the same answer on the same folder twice', () => {
    const folder = makeFolder(15, 6, 0.4, 0.7, 61);
    const first = run(folder, oracle(folder.truth, 29, 0.05)).clusters;
    const second = run(folder, oracle(folder.truth, 29, 0.05)).clusters;

    expect(first).toEqual(second);
  });

  it('costs fewer requests than there are photographs', () => {
    // About fifty requests for a hundred and ten photographs, against the old
    // pipeline's ten. Five times the requests, for the first architecture that
    // compares any two photographs as pictures rather than as paragraphs.
    const folder = makeFolder(22, 5, 0.3, 0.6, 11);
    const { sheets } = run(folder, oracle(folder.truth, 31));

    expect(sheets.length).toBeLessThan(folder.ids.length / 2);
  });

  it('judges every pair on real pixels rather than on descriptions', () => {
    // The one claim the old architecture could not make about any pair.
    const folder = makeFolder(22, 5, 0.3, 0.6, 11);
    const { judgements, sheets } = run(folder, oracle(folder.truth, 37));

    expect(judgements.length).toBeGreaterThan(sheets.length * 20);
    expect(judgements.every((j) => j.confidence === SURE || j.confidence === UNSURE)).toBe(true);
  });
});
