import { describe, it, expect } from 'vitest';
import {
  bundleDuplicates,
  chainBundles,
  cutBatches,
  MAX_BUNDLE,
  lookalikeLimit,
  nearestGroup,
  LOOKALIKE_FLOOR,
  LOOKALIKE_CAP,
} from './photoClustering';
import { Signature } from './imageSignature';

/**
 * A fingerprint built by hand: `tone` sets the colour, `shape` the hash.
 * The colour spills into the next bin so that neighbouring tones overlap the
 * way two photos of one item do, and distant ones share nothing.
 */
const signature = (tone: number, shape = 0): Signature => {
  const hist = new Float32Array(64);
  hist[tone % 64] = 0.7;
  hist[(tone + 1) % 64] = 0.3;
  const bits = new Uint8Array(8);
  bits[0] = shape & 0xff;
  return { bits, hist };
};

describe('bundleDuplicates', () => {
  it('collapses frames that are the same shot', () => {
    const same = signature(3, 0b1010);
    const bundles = bundleDuplicates([same, same, signature(40, 0xff)]);
    expect(bundles).toEqual([[0, 1], [2]]);
  });

  it('leaves photos of different colour alone', () => {
    const bundles = bundleDuplicates([signature(1), signature(30), signature(60)]);
    expect(bundles).toEqual([[0], [1], [2]]);
  });

  it('never collapses more than a handful into one', () => {
    const same = signature(5);
    const bundles = bundleDuplicates(Array.from({ length: 10 }, () => same));
    expect(bundles.every((bundle) => bundle.length <= MAX_BUNDLE)).toBe(true);
    expect(bundles.flat()).toHaveLength(10);
  });

  it('gives every photo its own bundle when it cannot see them', () => {
    const bundles = bundleDuplicates([null, null, null]);
    expect(bundles).toEqual([[0], [1], [2]]);
  });
});

describe('chainBundles', () => {
  it('puts photos that look alike next to each other', () => {
    // Two colours, interleaved on upload, as a real folder arrives.
    const signatures = [signature(1), signature(50), signature(2), signature(51)];
    const bundles = [[0], [1], [2], [3]];

    const { order } = chainBundles(bundles, signatures);

    const positionOf = (bundle: number) => order.indexOf(bundle);
    expect(Math.abs(positionOf(0) - positionOf(2))).toBe(1);
    expect(Math.abs(positionOf(1) - positionOf(3))).toBe(1);
  });

  it('falls back to upload order with nothing to look at', () => {
    const bundles = [[0], [1], [2], [3]];
    expect(chainBundles(bundles, [null, null, null, null]).order).toEqual([0, 1, 2, 3]);
  });

  it('takes no filename, so no filename can influence the order', () => {
    // The signature is the whole input. If a name could reach this function it
    // would have to arrive through an argument, and there is not one.
    expect(chainBundles.length).toBe(2);
  });
});

describe('cutBatches', () => {
  it('sends a small folder as one request', () => {
    const chain = { order: [0, 1, 2], links: [1, 0.1, 0.1] };
    expect(cutBatches(chain, 12)).toEqual([[0, 1, 2]]);
  });

  it('cuts where consecutive photos look least alike', () => {
    // A seam in the middle: everything is close except one long link.
    const order = Array.from({ length: 20 }, (_, i) => i);
    const links = order.map((_, i) => (i === 0 ? 1 : i === 10 ? 0.9 : 0.05));

    const batches = cutBatches({ order, links }, 12);

    expect(batches[0]).toHaveLength(10);
    expect(batches[1][0]).toBe(10);
  });

  it('never leaves a photo out, whatever the cuts', () => {
    const order = Array.from({ length: 110 }, (_, i) => i);
    const links = order.map((_, i) => (i === 0 ? 1 : (i * 7) % 10 / 10));

    const batches = cutBatches({ order, links }, 12);

    expect(batches.flat().sort((a, b) => a - b)).toEqual(order);
    expect(batches.length).toBeGreaterThan(1);
  });
});

describe('lookalikeLimit', () => {
  it('falls back to the floor when the folder shows too few pairs', () => {
    expect(lookalikeLimit([])).toBe(LOOKALIKE_FLOOR);
    expect(lookalikeLimit([0.3, 0.31])).toBe(LOOKALIKE_FLOOR);
  });

  it('reads the bar off the folder when there is enough evidence', () => {
    // A shoot whose own products sit ~0.25 apart earns a looser bar than a
    // tight catalogue set, but never a looser one than the cap.
    const limit = lookalikeLimit([0.2, 0.22, 0.24, 0.25, 0.26]);
    expect(limit).toBeGreaterThan(LOOKALIKE_FLOOR);
    expect(limit).toBeLessThanOrEqual(LOOKALIKE_CAP);
  });

  it('never exceeds the cap, however loose the folder looks', () => {
    expect(lookalikeLimit([0.6, 0.7, 0.8, 0.9])).toBe(LOOKALIKE_CAP);
  });

  it('never drops below the floor, however tight the folder looks', () => {
    expect(lookalikeLimit([0.01, 0.02, 0.03, 0.04])).toBe(LOOKALIKE_FLOOR);
  });

  it('ignores one loose pair inside an otherwise tight group', () => {
    const tight = [0.05, 0.06, 0.07, 0.08, 0.9];
    expect(lookalikeLimit(tight)).toBeLessThan(0.9);
  });
});

describe('nearestGroup', () => {
  it('places a photo that is close to one group and far from the rest', () => {
    expect(nearestGroup([0.1, 0.6, 0.7], 0.3)).toBe(0);
  });

  it('refuses a photo that is not close to anything', () => {
    expect(nearestGroup([0.5, 0.6], 0.3)).toBeNull();
  });

  it('refuses a photo that two groups fit almost equally well', () => {
    // 0.20 and 0.24 are both under the limit: the pixels cannot choose, so the
    // photo stays in the tray rather than being blended into one product.
    expect(nearestGroup([0.2, 0.24], 0.3)).toBeNull();
  });

  it('places it when the best match is decisively closer', () => {
    expect(nearestGroup([0.1, 0.29], 0.3)).toBe(0);
  });

  it('handles a single group', () => {
    expect(nearestGroup([0.1], 0.3)).toBe(0);
    expect(nearestGroup([0.9], 0.3)).toBeNull();
  });

  it('has nothing to say about an empty folder', () => {
    expect(nearestGroup([], 0.3)).toBeNull();
  });
});
