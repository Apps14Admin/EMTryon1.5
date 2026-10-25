// services/groupFolderV3.test.ts
import { describe, expect, it, vi } from 'vitest';
import { groupFolderV3, NO_SINGLE_PHOTO_PRODUCTS, UNRESOLVED_REASONS } from './groupFolderV3';
import { FolderImage } from './productModel';

vi.mock('./isolateSubject', () => ({
  isolateFolder: async (photos: string[]) => photos.map(() => null),
  // groupFolderV3 crops on the worker pool now; there is no Worker under
  // vitest, so the real isolateFolderParallel would fall back to this same
  // mocked isolateFolder anyway. Mocked directly here for the same result.
  isolateFolderParallel: async (photos: string[]) => photos.map(() => null),
}));
// R3: the brief's `embedFolder: async () => []` mock deadlocks every scenario
// in vitest (no canvas, so no signature fallback either — zero candidates).
// Feed real vectors instead so pools have real geometry to work with.
vi.mock('./visualEmbedding', () => ({
  embedFolder: async (photos: string[]) =>
    photos.map((_, i) => Float32Array.from([1, i * 0.05, 0])),
  embedderStatus: () => ({ ready: true, backend: 'test' }),
}));

const image = (id: string): FolderImage =>
  ({ id, fileName: `${id}.jpg`, full: 'AAAA', thumb: 'AAAA', scout: 'AAAA' });

/**
 * Scripted ask. Each call pops the next reply for its schemaName.
 * Replies are the JSON the model would return, as strings.
 */
const scriptedAsk = (script: { angle: string[]; identity: string[]; coherence?: string[] }) => {
  const queues = {
    angle_atlas: [...script.angle],
    identity: [...script.identity],
    coherence: [...(script.coherence ?? [])],
  };
  const calls: string[] = [];
  const ask = async (_parts: any[], _schema: any, name: string) => {
    calls.push(name);
    const queue = (queues as Record<string, string[]>)[name] ?? queues.identity;
    const text = queue.shift();
    if (text === undefined) throw new Error(`script exhausted for ${name}`);
    return { text, usage: null };
  };
  return { ask, calls };
};

describe('groupFolderV3 end to end (scripted model)', () => {
  it('groups two photos the model joined, leaves the stranger apart', async () => {
    const images = [image('a'), image('b'), image('c')];
    const { ask } = scriptedAsk({
      angle: [JSON.stringify([
        { photo: 0, angle: 'FRONT', category: 'FOOTWEAR', colour: 'black' },
        { photo: 1, angle: 'LEFT', category: 'FOOTWEAR', colour: 'black' },
        { photo: 2, angle: 'BACK', category: 'FOOTWEAR', colour: 'red' },
      ])],
      identity: [
        // b (photo 1) is the highest-priority anchor: its top candidate by
        // cosine is c (photo 1 in ITS sheet), then a (photo 2). This request
        // rejects b-c and casts the FIRST sure-SAME vote for a-b, anchored
        // at b - a merge now needs a second, differently-anchored vote
        // (Change A), so this alone leaves a-b merely pending.
        JSON.stringify([
          { photo: 1, same: false, sure: true, because: 'red not black' },
          { photo: 2, same: true, sure: true, because: 'same heel logo' },
        ]),
        // a is then the highest-priority anchor left (its pool still holds
        // both b and c - only b's own direction toward them was consumed).
        // It confirms b from the OTHER framing (anchor differs from b's
        // vote above) -> MERGED, and rejects c on its own account.
        JSON.stringify([
          { photo: 1, same: true, sure: true, because: 'same heel logo' },
          { photo: 2, same: false, sure: true, because: 'red not black' },
        ]),
      ],
    });
    const result = await groupFolderV3(images, undefined, undefined, undefined, ask);
    expect(result.classified).toBe(true);
    const groupOfA = result.groups.find((g) =>
      g.images.some((im) => im.imageId === 'a'))!;
    expect(groupOfA.images.map((im) => im.imageId).sort()).toEqual(['a', 'b']);
    expect(groupOfA.images.every((im) =>
      im.imageId === 'a' || im.joinedVia !== undefined)).toBe(true);
  });

  it('never asks about a same-angle pair (the invariant reaches the wire)', async () => {
    const images = [image('a'), image('b')];
    const { ask, calls } = scriptedAsk({
      angle: [JSON.stringify([
        { photo: 0, angle: 'FRONT', category: 'FOOTWEAR', colour: 'black' },
        { photo: 1, angle: 'FRONT', category: 'FOOTWEAR', colour: 'black' },
      ])],
      identity: [],   // any identity request would exhaust the script and throw
    });
    const result = await groupFolderV3(images, undefined, undefined, undefined, ask);
    expect(calls.filter((c) => c === 'identity')).toEqual([]);
    expect(result.groups.length + result.unassigned.length).toBeGreaterThan(0);
    // both photos end up apart, unresolved-or-alone but never merged:
    expect(result.groups.every((g) => g.images.length === 1)).toBe(true);
  });

  it('a hedged answer creates no link and lands the pair in review, not a group', async () => {
    const images = [image('a'), image('b')];
    const { ask } = scriptedAsk({
      angle: [JSON.stringify([
        { photo: 0, angle: 'FRONT', category: 'FOOTWEAR', colour: 'black' },
        { photo: 1, angle: 'LEFT', category: 'FOOTWEAR', colour: 'black' },
      ])],
      identity: [
        JSON.stringify([{ photo: 1, same: true, sure: false, because: 'maybe' }]),
        JSON.stringify([{ photo: 1, same: true, sure: false, because: 'maybe' }]),
      ],
    });
    const result = await groupFolderV3(images, undefined, undefined, undefined, ask);
    expect(result.groups.every((g) => g.images.length === 1)).toBe(true);
    expect(result.unassigned.length).toBeGreaterThan(0);
    expect(Object.values(result.uncertainReasons ?? {}).join(' ')).toMatch(/commit/);
  });

  it('a failed identity request leaves photos Unresolved with the reason, never invents groups', async () => {
    const images = [image('a'), image('b')];
    const ask = async (_p: any[], _s: any, name: string) => {
      if (name === 'angle_atlas') {
        return {
          text: JSON.stringify([
            { photo: 0, angle: 'FRONT', category: 'FOOTWEAR', colour: 'black' },
            { photo: 1, angle: 'LEFT', category: 'FOOTWEAR', colour: 'black' },
          ]),
          usage: null,
        };
      }
      throw new Error('boom 500');
    };
    const result = await groupFolderV3(images, undefined, undefined, undefined, ask);
    expect(result.groups.every((g) => g.images.length === 1)).toBe(true);
    expect(result.unassigned).toContain('a');
  });

  it('is deterministic: the same script produces identical output twice', async () => {
    const images = [image('a'), image('b'), image('c')];
    const script = {
      angle: [JSON.stringify([
        { photo: 0, angle: 'FRONT', category: 'FOOTWEAR', colour: 'black' },
        { photo: 1, angle: 'LEFT', category: 'FOOTWEAR', colour: 'black' },
        { photo: 2, angle: 'BACK', category: 'FOOTWEAR', colour: 'black' },
      ])],
      identity: [
        // wave1: b asks [c,a] - first sure-SAME vote for both b-c and b-a,
        // anchored at b (Change A: pending, not yet merged).
        JSON.stringify([
          { photo: 1, same: true, sure: true, because: 'same logo' },
          { photo: 2, same: true, sure: true, because: 'same logo' },
        ]),
        // wave2: c asks [b,a] - confirms b-c from the other framing (MERGE)
        // and casts the first vote for a-c (pending).
        JSON.stringify([
          { photo: 1, same: true, sure: true, because: 'same logo' },
          { photo: 2, same: true, sure: true, because: 'same logo' },
        ]),
        // wave3: a asks [b,c] - confirms a-b from the other framing (MERGE,
        // which transitively folds c in too since b-c already merged).
        JSON.stringify([
          { photo: 1, same: true, sure: true, because: 'same logo' },
          { photo: 2, same: true, sure: true, because: 'same logo' },
        ]),
      ],
      // The finished cluster {a,b,c} has size 3 (== COHERENCE_MIN_GROUP), so
      // Change B's coherence pass checks it once: a clean all-A confirmation,
      // the common case that changes nothing.
      coherence: [JSON.stringify([
        { photo: 0, item: 'A', sure: true },
        { photo: 1, item: 'A', sure: true },
        { photo: 2, item: 'A', sure: true },
      ])],
    };
    const one = await groupFolderV3(images, undefined, undefined, undefined,
      scriptedAsk(structuredClone(script)).ask);
    const two = await groupFolderV3(images, undefined, undefined, undefined,
      scriptedAsk(structuredClone(script)).ask);
    expect(one.groups).toEqual(two.groups);
    expect(one.unassigned).toEqual(two.unassigned);
    // The all-A coherence reply actually got consumed and confirmed the
    // merge, rather than the check silently failing and forcing review.
    expect(one.groups).toHaveLength(1);
    expect(one.groups[0].images.map((im) => im.imageId).sort()).toEqual(['a', 'b', 'c']);
    expect(one.groups[0].needsReview).toBe(false);
  });
});

describe('NO_SINGLE_PHOTO_PRODUCTS (Change C)', () => {
  // The dataset guarantee - every product has at least two photographs - is
  // enforced by disabling the 'alone' classification outright. Reaching
  // that exact classify branch end to end needs a real cosine floor
  // (candidatePool.ts MIN_FLOOR_SAMPLES = 30 same-bucket-pair samples),
  // which no compact scripted fixture can produce; see
  // groupingV3.scenarios.test.ts's ORPHANS SCENARIO for the reasoning and
  // the end-to-end behaviour it verifies instead. This checks the piece an
  // E2E run cannot: the rule is actually on, and its reason text actually
  // names the dataset guarantee.
  it('is enabled, and its reason names the dataset guarantee', () => {
    expect(NO_SINGLE_PHOTO_PRODUCTS).toBe(true);
    expect(UNRESOLVED_REASONS.orphan).toMatch(/at least two photographs/);
  });
});
