import { bucketOf } from './angleAtlas';
import { Signature, visualDistance } from './imageSignature';

export const POOL_SIZE = 6;
export const FLOOR_PERCENTILE = 75;
export const MIN_FLOOR_SAMPLES = 30;

export const cosine = (a: Float32Array, b: Float32Array): number => {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (!normA || !normB) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
};

export const pairKey = (a: number, b: number): string =>
  a < b ? `${a},${b}` : `${b},${a}`;

export interface Pool {
  anchor: number;
  candidates: number[];
  truncated: boolean;
}

export const floorKey = (bucketA: string, bucketB: string): string =>
  bucketA < bucketB ? `${bucketA}|${bucketB}` : `${bucketB}|${bucketA}`;

/**
 * One floor per unordered pair of angle buckets, each on its own scale.
 * FRONT-to-LEFT cosines and FRONT-to-BACK cosines are different
 * distributions, and 0.62 can be exceptional in one while unremarkable in
 * the other - the heel-tab case in the spec. A pool of fewer than
 * MIN_FLOOR_SAMPLES yields no floor rather than a floor made of noise.
 */
export const pairFloors = (
  vectors: (Float32Array | null)[],
  angles: (string | undefined)[],
): Map<string, number> => {
  const samples = new Map<string, number[]>();

  for (let i = 0; i < vectors.length; i += 1) {
    const vi = vectors[i];
    const bi = bucketOf(angles[i]);
    if (!vi || !bi) continue;
    for (let j = i + 1; j < vectors.length; j += 1) {
      const vj = vectors[j];
      const bj = bucketOf(angles[j]);
      if (!vj || !bj || bi === bj) continue;
      const key = floorKey(bi, bj);
      const held = samples.get(key) ?? [];
      held.push(cosine(vi, vj));
      samples.set(key, held);
    }
  }

  const floors = new Map<string, number>();
  samples.forEach((pool, key) => {
    if (pool.length < MIN_FLOOR_SAMPLES) return;
    const sorted = [...pool].sort((x, y) => x - y);
    const index = Math.min(
      sorted.length - 1,
      Math.max(0, Math.ceil((FLOOR_PERCENTILE / 100) * sorted.length) - 1)
    );
    floors.set(key, sorted[index]);
  });
  return floors;
};

export const floorOf = (
  floors: Map<string, number>,
  angleA: string | undefined,
  angleB: string | undefined,
): number | null => {
  const ba = bucketOf(angleA);
  const bb = bucketOf(angleB);
  if (!ba || !bb || ba === bb) return null;
  return floors.get(floorKey(ba, bb)) ?? null;
};

/** For PRIORITY ORDERING only. Never used to remove a candidate. */
export const marginOf = (cos: number, floor: number | null): number =>
  floor === null ? cos : cos - floor;

/**
 * Stratified candidate selection - spec section 6, final form:
 *   1. remove same-angle photographs (cannot-link),
 *   2. remove recorded NOT-SAME pairs,
 *   3. reserve one slot per other angle bucket (best of each),
 *   4. fill the rest to k by global cosine rank.
 * NO floor is consulted here. The floor never prunes.
 */
export const buildPools = (
  vectors: (Float32Array | null)[],
  angles: (string | undefined)[],
  notSame: ReadonlySet<string>,
  k: number = POOL_SIZE,
): Pool[] =>
  vectors.map((vector, anchor) => {
    if (!vector) return { anchor, candidates: [], truncated: false };

    const anchorBucket = bucketOf(angles[anchor]);
    const scored: { index: number; score: number; bucket: string | null }[] = [];

    vectors.forEach((other, index) => {
      if (index === anchor || !other) return;
      const bucket = bucketOf(angles[index]);
      if (anchorBucket !== null && bucket === anchorBucket) return;   // cannot-link
      if (notSame.has(pairKey(anchor, index))) return;                // ruled out
      scored.push({ index, score: cosine(vector, other), bucket });
    });

    // Strongest first; folder order breaks exact ties for determinism.
    scored.sort((x, y) => (y.score - x.score) || (x.index - y.index));

    // Reserve the best candidate from every bucket present (unlabelled
    // photographs compete only in the fill).
    const reservedByBucket = new Map<string, number>();
    scored.forEach(({ index, bucket }) => {
      if (bucket && !reservedByBucket.has(bucket)) reservedByBucket.set(bucket, index);
    });
    const reserved = [...reservedByBucket.values()];

    // If buckets alone exceed k, keep the k strongest reservations - the
    // spec's named residual risk, deterministic by construction.
    const chosen = new Set<number>(
      reserved
        .sort((x, y) => {
          const sx = scored.find((s) => s.index === x)!.score;
          const sy = scored.find((s) => s.index === y)!.score;
          return (sy - sx) || (x - y);
        })
        .slice(0, k)
    );

    for (const { index } of scored) {
      if (chosen.size >= k) break;
      chosen.add(index);
    }

    const candidates = scored.filter((s) => chosen.has(s.index)).map((s) => s.index);
    return { anchor, candidates, truncated: scored.length > candidates.length };
  });

/**
 * Sibling of `buildPools` for when the embedder is unavailable: same
 * same-angle exclusion, same NOT-SAME exclusion, same stratify/cap/truncation
 * logic, ranked by `visualDistance` ASCENDING (closer first) instead of
 * cosine descending. Kept degraded, never lax — the fallback still refuses
 * same-angle candidates, it just recalls worse than a real embedding would.
 */
export const poolsFromSignatures = (
  signatures: (Signature | null)[],
  angles: (string | undefined)[],
  notSame: ReadonlySet<string>,
  k: number = POOL_SIZE,
): Pool[] =>
  signatures.map((signature, anchor) => {
    if (!signature) return { anchor, candidates: [], truncated: false };

    const anchorBucket = bucketOf(angles[anchor]);
    const scored: { index: number; score: number; bucket: string | null }[] = [];

    signatures.forEach((other, index) => {
      if (index === anchor || !other) return;
      const bucket = bucketOf(angles[index]);
      if (anchorBucket !== null && bucket === anchorBucket) return;   // cannot-link
      if (notSame.has(pairKey(anchor, index))) return;                // ruled out
      // Closer is better, so the score is the NEGATIVE distance — that keeps
      // the rest of this function (sorted "highest score first") identical to
      // buildPools' cosine version.
      scored.push({ index, score: -visualDistance(signature, other), bucket });
    });

    scored.sort((x, y) => (y.score - x.score) || (x.index - y.index));

    const reservedByBucket = new Map<string, number>();
    scored.forEach(({ index, bucket }) => {
      if (bucket && !reservedByBucket.has(bucket)) reservedByBucket.set(bucket, index);
    });
    const reserved = [...reservedByBucket.values()];

    const chosen = new Set<number>(
      reserved
        .sort((x, y) => {
          const sx = scored.find((s) => s.index === x)!.score;
          const sy = scored.find((s) => s.index === y)!.score;
          return (sy - sx) || (x - y);
        })
        .slice(0, k)
    );

    for (const { index } of scored) {
      if (chosen.size >= k) break;
      chosen.add(index);
    }

    const candidates = scored.filter((s) => chosen.has(s.index)).map((s) => s.index);
    return { anchor, candidates, truncated: scored.length > candidates.length };
  });
