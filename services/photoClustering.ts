/**
 * The local pass that runs before a single request is sent.
 *
 * Two jobs, both free:
 *   1. collapse frames that are literally the same shot, so the model is not
 *      asked twice about one photograph;
 *   2. put photos that look alike next to each other, and cut the request
 *      batches where consecutive photos look LEAST alike — so one product
 *      rarely straddles two requests in the first place.
 *
 * None of this decides what a product is. It decides WHAT TO ASK, and in what
 * order — the model still answers, the fingerprints still adjudicate, and the
 * review screen is still the gate. That distinction is what makes the ordering
 * safe: a bad order costs an extra request or leaves a product split across
 * two of them, and neither can put two different products in one group.
 *
 * FILENAMES ARE NOT USED HERE, AND NOTHING IN THIS FILE READS ONE.
 *
 * An earlier revision read product identifiers out of filenames and used them
 * both to order the folder and to rejoin groups the model had split. It worked
 * on tidy exports and was worthless on the folders this actually receives —
 * `IMG_001.jpg`, `photo_83.jpg`, `abc.jpg`, `DSC_4412.jpg` — where the same
 * product's six photographs carry six unrelated names and two different
 * products carry consecutive ones. Worse than worthless, in fact: a name-based
 * join is confident, so it produced wrong groups rather than uncertain ones.
 * Product identity now comes from the photographs and from nothing else.
 */

import { Signature, isNearDuplicate, visualDistance } from './imageSignature';

// --- bundles -------------------------------------------------------------

/** Frames collapsed into one before anything is sent. */
export const MAX_BUNDLE = 6;

/**
 * Groups photos that are the same shot: a burst, a duplicate, one export at
 * two sizes. Each bundle is asked about once, through its first photo, and the
 * answer applies to all of them — including the angle, which really is the
 * same. Nothing here merges two different views of one item; that judgement
 * stays with the model.
 */
export const bundleDuplicates = (signatures: (Signature | null)[]): number[][] => {
  const parent = signatures.map((_, i) => i);
  const size = signatures.map(() => 1);

  const find = (i: number): number => {
    let root = i;
    while (parent[root] !== root) {
      parent[root] = parent[parent[root]];
      root = parent[root];
    }
    return root;
  };

  for (let i = 0; i < signatures.length; i += 1) {
    if (!signatures[i]) continue;
    for (let j = i + 1; j < signatures.length; j += 1) {
      if (!signatures[j]) continue;
      const a = find(i);
      const b = find(j);
      if (a === b) continue;
      if (size[a] + size[b] > MAX_BUNDLE) continue;
      if (!isNearDuplicate(signatures[i], signatures[j])) continue;
      parent[b] = a;
      size[a] += size[b];
    }
  }

  const byRoot = new Map<number, number[]>();
  signatures.forEach((_, i) => {
    const root = find(i);
    const bundle = byRoot.get(root);
    if (bundle) bundle.push(i);
    else byRoot.set(root, [i]);
  });

  return [...byRoot.values()].sort((a, b) => a[0] - b[0]);
};

// --- ordering ------------------------------------------------------------

export interface Chain {
  /** Bundle indices, arranged so neighbours look alike. */
  order: number[];
  /** `links[k]` is how far `order[k]` sits from `order[k - 1]`; `links[0]` is 1. */
  links: number[];
}

const uniformChain = (count: number): Chain => ({
  order: Array.from({ length: count }, (_, i) => i),
  links: Array.from({ length: count }, (_, i) => (i === 0 ? 1 : 0)),
});

/**
 * Arranges bundles so photos of one product end up adjacent.
 *
 * A greedy nearest-neighbour walk, which is enough: the point is not an
 * optimal tour, it is that the seams between products land somewhere sensible
 * so a batch boundary can be put there. With no signatures — no canvas, or a
 * folder of formats that would not decode — this is upload order, and the run
 * still works, it just cuts blind.
 */
export const chainBundles = (
  bundles: number[][],
  signatures: (Signature | null)[]
): Chain => {
  const count = bundles.length;
  if (count < 3 || !signatures.some(Boolean)) return uniformChain(count);

  const rep = (bundle: number) => signatures[bundles[bundle][0]];

  const taken = new Array<boolean>(count).fill(false);
  const order = [0];
  taken[0] = true;
  let current = 0;

  for (let step = 1; step < count; step += 1) {
    let best = -1;
    let bestDistance = Infinity;

    for (let candidate = 0; candidate < count; candidate += 1) {
      if (taken[candidate]) continue;
      const distance = visualDistance(rep(current), rep(candidate));
      if (distance < bestDistance) {
        bestDistance = distance;
        best = candidate;
      }
    }

    taken[best] = true;
    order.push(best);
    current = best;
  }

  return {
    order,
    links: order.map((bundle, i) =>
      i === 0 ? 1 : visualDistance(rep(order[i - 1]), rep(bundle))
    ),
  };
};

// --- batching ------------------------------------------------------------

/**
 * Splits the chain into request-sized runs, cutting where consecutive photos
 * look least alike.
 *
 * Fixed-size cuts split a product in half roughly once per batch. Cutting at a
 * seam costs nothing and usually falls between two products, which is the
 * whole reason for ordering the photos first.
 */
export const cutBatches = (chain: Chain, target: number): number[][] => {
  const { order, links } = chain;
  if (order.length <= target) return order.length ? [order.slice()] : [];

  const min = Math.max(2, Math.round(target * 0.6));
  const max = Math.max(min + 1, Math.round(target * 1.3));

  // A seam is a link that stands out: in the longest fifth of them, and longer
  // than the typical one. Cutting at an ordinary link only buys a smaller
  // batch, which costs a request and gains nothing.
  const sorted = links.slice(1).filter((d) => d > 0).sort((a, b) => a - b);
  const seam = sorted.length ? sorted[Math.floor(sorted.length * 0.8)] : Infinity;
  const typical = sorted.length ? sorted[Math.floor(sorted.length * 0.5)] : Infinity;

  const batches: number[][] = [];
  let current: number[] = [];

  order.forEach((bundle, i) => {
    const atSeam = current.length >= min && links[i] >= seam && links[i] > typical;
    if (current.length >= max || atSeam) {
      batches.push(current);
      current = [];
    }
    current.push(bundle);
  });

  if (current.length) {
    // A stray tail is cheaper folded into the batch before it than sent alone.
    if (current.length < min && batches.length) batches[batches.length - 1].push(...current);
    else batches.push(current);
  }

  return batches;
};

// --- look-alike joining --------------------------------------------------

/**
 * How close two photos must look before they count as one product.
 *
 * The model splits a product across requests more often than it merges two
 * products, and the splits it leaves behind are exactly the ones a person
 * spots instantly: the same shoe, photographed from two angles, sitting in two
 * groups. Pixels can rejoin those without spending a request.
 *
 * The limit is read off the folder rather than fixed, because "how far apart
 * do two photos of ONE product look" depends on the shoot: a white-background
 * catalogue set scores far tighter than photos taken around a shop. The
 * distances inside the groups the model already made are that measurement, so
 * the folder sets its own bar. Where there is not enough of it, the floor
 * applies, which only rejoins photos that look nearly the same.
 */
export const LOOKALIKE_FLOOR = 0.18;

/** Ceiling regardless of the folder: past this, two colourways start to merge. */
export const LOOKALIKE_CAP = 0.34;

export const lookalikeLimit = (withinGroup: number[]): number => {
  const usable = withinGroup.filter((d) => Number.isFinite(d));
  if (usable.length < 3) return LOOKALIKE_FLOOR;

  const sorted = [...usable].sort((a, b) => a - b);
  // The 75th percentile, so one odd pair inside a group cannot raise the bar
  // for the whole folder.
  const p75 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.75))];
  return Math.min(LOOKALIKE_CAP, Math.max(LOOKALIKE_FLOOR, p75));
};

/**
 * Which group an orphan photo belongs to, if any.
 *
 * Two tests, not one. Close enough on its own is not sufficient: a photo that
 * sits almost as close to a second group is a photo the pixels cannot place,
 * and guessing there is how two products get blended. It must also be
 * decisively closer to its best match than to the runner-up, or it stays in
 * the tray for a person to place.
 */
export const MARGIN = 0.75;

export const nearestGroup = (
  distances: number[],
  limit: number
): number | null => {
  if (!distances.length) return null;

  let best = Infinity;
  let bestIndex = -1;
  let second = Infinity;

  distances.forEach((d, i) => {
    if (d < best) {
      second = best;
      best = d;
      bestIndex = i;
    } else if (d < second) {
      second = d;
    }
  });

  if (bestIndex === -1 || best > limit) return null;
  if (Number.isFinite(second) && best > second * MARGIN) return null;
  return bestIndex;
};
