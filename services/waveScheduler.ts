import { Pool } from './candidatePool';
import { LinkGraph } from './linkGraph';

export const WAVE_WIDTH = 8;

export interface LivePool {
  anchor: number;
  live: number[];
  bestMargin: number;
}

export const livePools = (
  pools: Pool[],
  idOf: (index: number) => string,
  graph: LinkGraph,
  margin: (anchor: number, candidate: number) => number,
): LivePool[] => {
  const out: LivePool[] = [];
  for (const pool of pools) {
    const anchorId = idOf(pool.anchor);
    const live = pool.candidates.filter((candidate) => {
      const candidateId = idOf(candidate);
      if (graph.sameCluster(anchorId, candidateId)) return false;  // transitivity answered it
      if (graph.cannotJoin(anchorId, candidateId)) return false;   // angle or NOT-SAME bar
      if (graph.isNotSame(anchorId, candidateId)) return false;
      return true;
    });
    if (!live.length) continue;                                    // the free skip
    const bestMargin = Math.max(...live.map((c) => margin(pool.anchor, c)));
    out.push({ anchor: pool.anchor, live, bestMargin });
  }
  return out;
};

export const byPriority = (a: LivePool, b: LivePool): number =>
  (b.live.length - a.live.length) ||
  (b.bestMargin - a.bestMargin) ||
  (a.anchor - b.anchor);

export const buildWave = (queue: LivePool[], width: number = WAVE_WIDTH): LivePool[] => {
  const wave: LivePool[] = [];
  const taken = new Set<number>();
  for (const entry of queue) {
    if (wave.length >= width) break;
    const footprint = [entry.anchor, ...entry.live];
    if (footprint.some((index) => taken.has(index))) continue;
    footprint.forEach((index) => taken.add(index));
    wave.push(entry);
  }
  return wave;
};
