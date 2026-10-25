import { describe, expect, it } from 'vitest';
import {
  COVERAGE,
  SHEET_SIZE,
  cosine,
  coveredPairs,
  neighboursOf,
  pairsOn,
  planSheets,
} from './neighbourGraph';

/** Deterministic noise, so a recall number in this file means the same thing twice. */
const rng = (seed: number) => {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
};

/**
 * A synthetic folder: `products` items, `shots` photographs of each.
 *
 * Every product gets a random direction in a 64-dimensional space, and each of
 * its photographs is that direction plus noise. `spread` is how far a
 * photograph wanders from its product — the stand-in for a sole shot looking
 * nothing like a profile — and `separation` scales how far apart two products
 * start, the stand-in for a folder of near-identical trainers.
 */
const folder = (
  products: number,
  shots: number,
  spread: number,
  seed = 1,
  separation = 1
) => {
  const random = rng(seed);
  const dims = 64;
  const vectors: Float32Array[] = [];
  const truth: number[] = [];

  for (let p = 0; p < products; p += 1) {
    const centre = Float32Array.from({ length: dims }, () => (random() - 0.5) * separation);
    for (let s = 0; s < shots; s += 1) {
      const vector = new Float32Array(dims);
      for (let d = 0; d < dims; d += 1) vector[d] = centre[d] + (random() - 0.5) * spread;
      vectors.push(vector);
      truth.push(p);
    }
  }

  return { vectors, truth };
};

/** Share of same-product pairs that land on at least one sheet together. */
const pairRecall = (truth: number[], sheets: number[][]) => {
  const covered = coveredPairs(sheets);
  let total = 0;
  let found = 0;

  for (let i = 0; i < truth.length; i += 1) {
    for (let j = i + 1; j < truth.length; j += 1) {
      if (truth[i] !== truth[j]) continue;
      total += 1;
      if (covered.has(`${i},${j}`)) found += 1;
    }
  }

  return total ? found / total : 1;
};

describe('cosine', () => {
  it('is 1 for a vector against itself', () => {
    const v = new Float32Array([1, 2, 3]);
    expect(cosine(v, v)).toBeCloseTo(1);
  });

  it('ignores magnitude', () => {
    const a = new Float32Array([1, 2, 3]);
    const b = new Float32Array([10, 20, 30]);
    expect(cosine(a, b)).toBeCloseTo(1);
  });

  it('is 0 for perpendicular vectors', () => {
    expect(cosine(new Float32Array([1, 0]), new Float32Array([0, 1]))).toBeCloseTo(0);
  });

  it('is 0 rather than NaN for an all-zero vector', () => {
    expect(cosine(new Float32Array([0, 0]), new Float32Array([1, 1]))).toBe(0);
  });
});

describe('neighboursOf', () => {
  it('never lists a photograph as its own neighbour', () => {
    const { vectors } = folder(4, 3, 0.2);
    neighboursOf(vectors, 5).forEach((list, i) => expect(list).not.toContain(i));
  });

  it('puts a photograph of the same product first', () => {
    const { vectors, truth } = folder(6, 4, 0.15);
    const neighbours = neighboursOf(vectors, 5);
    neighbours.forEach((list, i) => expect(truth[list[0]]).toBe(truth[i]));
  });

  it('gives a photograph with no vector an empty list rather than a wrong one', () => {
    const { vectors } = folder(3, 2, 0.2);
    const withGap: (Float32Array | null)[] = [...vectors];
    withGap[2] = null;
    expect(neighboursOf(withGap, 4)[2]).toEqual([]);
  });
});

describe('planSheets', () => {
  it('returns nothing for an empty folder', () => {
    expect(planSheets([]).sheets).toEqual([]);
  });

  it('puts every photograph on at least one sheet', () => {
    const { vectors } = folder(10, 6, 0.3);
    const { sheets } = planSheets(neighboursOf(vectors, SHEET_SIZE - 1));
    const seen = new Set(sheets.flat());
    expect(seen.size).toBe(vectors.length);
  });

  it('never builds a sheet larger than the size asked for', () => {
    const { vectors } = folder(12, 5, 0.3);
    const { sheets } = planSheets(neighboursOf(vectors, 20), 9);
    sheets.forEach((sheet) => expect(sheet.length).toBeLessThanOrEqual(9));
  });

  it('never repeats a photograph within one sheet', () => {
    const { vectors } = folder(8, 7, 0.3);
    const { sheets } = planSheets(neighboursOf(vectors, SHEET_SIZE - 1));
    sheets.forEach((sheet) => expect(new Set(sheet).size).toBe(sheet.length));
  });

  it('plans the same sheets twice for the same folder', () => {
    const { vectors } = folder(9, 5, 0.3, 7);
    const neighbours = neighboursOf(vectors, SHEET_SIZE - 1);
    expect(planSheets(neighbours).sheets).toEqual(planSheets(neighbours).sheets);
  });

  it('gives a photograph with no neighbours a sheet of its own rather than dropping it', () => {
    const { vectors } = folder(4, 3, 0.2);
    const withGap: (Float32Array | null)[] = [...vectors];
    withGap[5] = null;
    const { sheets } = planSheets(neighboursOf(withGap, SHEET_SIZE - 1));
    expect(sheets.flat()).toContain(5);
  });
});

describe('recall — the property the whole stage exists for', () => {
  it('finds every pair of a product photographed from tight angles', () => {
    const { vectors, truth } = folder(12, 6, 0.25, 3);
    const { sheets } = planSheets(neighboursOf(vectors, SHEET_SIZE - 1));
    expect(pairRecall(truth, sheets)).toBe(1);
  });

  it('still finds nearly every pair when the angles are far apart', () => {
    // `spread` at 0.8 against a separation of 1 is a product whose photographs
    // are almost as far from each other as from another product's — a sole shot
    // against a profile. This is the hard case for ANY appearance measure, and
    // is why the model is asked rather than the distance being trusted.
    const { vectors, truth } = folder(10, 6, 0.8, 5);
    const { sheets } = planSheets(neighboursOf(vectors, SHEET_SIZE - 1));
    expect(pairRecall(truth, sheets)).toBeGreaterThan(0.75);
  });

  it('holds up on a folder of a hundred and ten near-identical items', () => {
    // The folder that broke the old system: many products, few photographs
    // each, all of them close together.
    const { vectors, truth } = folder(22, 5, 0.3, 11, 0.6);
    const { sheets } = planSheets(neighboursOf(vectors, SHEET_SIZE - 1));

    expect(vectors).toHaveLength(110);
    expect(pairRecall(truth, sheets)).toBeGreaterThan(0.9);
  });

  it('costs a bounded, stated number of requests', () => {
    // Worth being exact about, because it is the price of the architecture.
    // The old pipeline sent about ten requests for a hundred and ten
    // photographs and compared no pair of them on pixels. This sends about
    // fifty and compares roughly a thousand pairs on pixels. Fewer than one
    // request per photograph is the bar; it must never approach the quadratic
    // cost of comparing every pair directly, which here would be 5,995.
    const { vectors } = folder(22, 5, 0.3, 11, 0.6);
    const { sheets } = planSheets(neighboursOf(vectors, SHEET_SIZE - 1));

    expect(sheets.length).toBeLessThan(vectors.length / 2);
    expect(sheets.length).toBeGreaterThan(10);
  });

  it('judges far more pairs than it sends requests', () => {
    const { vectors } = folder(22, 5, 0.3, 11, 0.6);
    const { sheets } = planSheets(neighboursOf(vectors, SHEET_SIZE - 1));

    // Each sheet of nine answers thirty-six pairs. That ratio is the reason
    // this is affordable at all.
    expect(coveredPairs(sheets).size).toBeGreaterThan(sheets.length * 20);
  });

  it('gives each photograph the coverage asked for, or reports it as thin', () => {
    const { vectors } = folder(15, 5, 0.35, 13);
    const { appearances, thin } = planSheets(neighboursOf(vectors, SHEET_SIZE - 1));

    appearances.forEach((count, i) => {
      if (!thin.includes(i)) expect(count).toBeGreaterThanOrEqual(COVERAGE);
    });
  });
});

describe('pairsOn', () => {
  it('gives every unordered pair on a sheet', () => {
    expect(pairsOn([1, 2, 3])).toEqual([
      [1, 2],
      [1, 3],
      [2, 3],
    ]);
  });

  it('gives nothing for a sheet of one', () => {
    expect(pairsOn([4])).toEqual([]);
  });
});
