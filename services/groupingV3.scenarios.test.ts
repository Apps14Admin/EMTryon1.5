// services/groupingV3.scenarios.test.ts
import { describe, expect, it, vi } from 'vitest';
import { groupFolderV3 } from './groupFolderV3';
import { loadRecording, replayingAsk, recordingAsk, dumpRecording } from './replayLog';
import { FolderImage } from './productModel';

vi.mock('./isolateSubject', () => ({
  isolateFolder: async (photos: string[]) => photos.map(() => null),
  // groupFolderV3 crops on the worker pool now; there is no Worker under
  // vitest, so the real isolateFolderParallel would fall back to this same
  // mocked isolateFolder anyway. Mocked directly here for the same result.
  isolateFolderParallel: async (photos: string[]) => photos.map(() => null),
}));
// R3: the heel-tab geometry from spec section 6/candidatePool.test.ts —
// cosine(A-FRONT, B-FRONT) = 0.95 (different products, same angle),
// cosine(A-FRONT, A-LEFT) = 0.62 (same product, different angle). Returned in
// image order (aFront, bFront, aLeft), matching how the tests build `images`.
//
// The orphans scenario (Change C) needs a fourth-photo geometry with two
// CLEARLY separated products (each pair close to itself, far from the
// other) rather than the heel-tab's deliberately close call, so it is kept
// as its own branch rather than distorting the tuned 3-vector case above.
vi.mock('./visualEmbedding', () => ({
  embedFolder: async (photos: string[]) => {
    if (photos.length === 4) {
      return [
        Float32Array.from([1, 0, 0]),       // a1
        Float32Array.from([0.99, 0.05, 0]), // a2 - close to a1
        Float32Array.from([0, 1, 0]),       // b1
        Float32Array.from([0.05, 0.99, 0]), // b2 - close to b1
      ];
    }
    return [
      Float32Array.from([1, 0, 0]),
      Float32Array.from([0.95, 0.31225, 0]),
      Float32Array.from([0.62, 0, 0.78460]),
    ];
  },
  embedderStatus: () => ({ ready: true, backend: 'test' }),
}));

const image = (id: string): FolderImage =>
  ({ id, fileName: `${id}.jpg`, full: 'AAAA', thumb: 'AAAA', scout: 'AAAA' });

describe('HEEL-TAB SCENARIO, end to end (spec sections 6 and 15)', () => {
  // Folder: A-FRONT, B-FRONT (different product, near-identical), A-LEFT.
  // The recording holds the answers a correct model gives when asked the
  // questions this pipeline is allowed to ask. If the pipeline ever asks a
  // same-angle question, or fails to ask about A-FRONT/A-LEFT, the replay
  // exhausts or the grouping comes out wrong - either way the test fails.
  //
  // Candidate geometry (spec section 6, R1/R3): A-FRONT and B-FRONT are
  // cannot-linked (both FRONT), so neither ever appears in the other's pool —
  // the only anchor with more than one live candidate is A-LEFT, whose pool
  // is [A-FRONT (cosine 0.62), B-FRONT (cosine 0.589)] in that rank order.
  // A-LEFT therefore has the largest live pool and is asked first; its one
  // request carries photo 1 = A-FRONT, photo 2 = B-FRONT.
  const recording = loadRecording(JSON.stringify([
    {
      schemaName: 'angle_atlas',
      reply: JSON.stringify([
        { photo: 0, angle: 'FRONT', category: 'FOOTWEAR', colour: 'black white' },
        { photo: 1, angle: 'FRONT', category: 'FOOTWEAR', colour: 'black' },
        { photo: 2, angle: 'LEFT', category: 'FOOTWEAR', colour: 'black white' },
      ]),
    },
    {
      // A-LEFT's anchor sheet: photo 1 = A-FRONT, photo 2 = B-FRONT. Change A:
      // a merge needs two independently-anchored sure votes, so A-LEFT's SAME
      // vote for A-FRONT only PARKS pending here; its sure NOT-SAME for
      // B-FRONT is recorded outright (a refusal never needs corroboration).
      schemaName: 'identity',
      reply: JSON.stringify([
        { photo: 1, same: true, sure: true, because: 'same white heel tab' },
        { photo: 2, same: false, sure: true, because: 'white heel tab vs black' },
      ]),
    },
    {
      // A-FRONT is then the highest-priority remaining anchor (its only
      // candidate, A-LEFT, is still live - only A-LEFT's OWN direction
      // toward A-FRONT was consumed above). A-FRONT confirms A-LEFT from the
      // other framing -> the second vote Change A requires -> MERGED.
      // B-FRONT never becomes a live anchor: its only candidate, A-LEFT, was
      // already ruled NOT-SAME above, so its pool is empty and it stays
      // Unresolved rather than asking a question.
      schemaName: 'identity',
      reply: JSON.stringify([
        { photo: 1, same: true, sure: true, because: 'same white heel tab' },
      ]),
    },
  ]));

  it('groups A-FRONT with A-LEFT and keeps B-FRONT out', async () => {
    const images = [image('aFront'), image('bFront'), image('aLeft')];
    const result = await groupFolderV3(
      images, undefined, undefined, undefined, replayingAsk([...recording])
    );
    const groupOfA = result.groups.find((g) =>
      g.images.some((im) => im.imageId === 'aFront'))!;
    const members = groupOfA.images.map((im) => im.imageId).sort();
    expect(members).toEqual(['aFront', 'aLeft']);
    expect(members).not.toContain('bFront');
  });

  it('no group ever holds two FRONTs, whatever the replay says', async () => {
    // Adversarial recording: the "model" insists the two FRONTs are the same.
    // It cannot actually be asked that question — A-FRONT and B-FRONT are
    // cannot-linked and never share a sheet — so this is a belt-and-braces
    // check on the invariant reaching all the way to the wire. Change A makes
    // this an even stronger check: A-LEFT's single insisting vote for
    // A-FRONT now yields only a PENDING corroboration, never a merge, so no
    // group can hold both A-FRONT and B-FRONT regardless of what the replay
    // insists.
    const hostile = [
      recording[0],
      {
        schemaName: 'identity',
        reply: JSON.stringify([
          { photo: 1, same: true, sure: true, because: 'they look identical' },
        ]),
      },
    ];
    const images = [image('aFront'), image('bFront'), image('aLeft')];
    const result = await groupFolderV3(
      images, undefined, undefined, undefined, replayingAsk(hostile as any)
    );
    result.groups.forEach((group) => {
      const fronts = group.images.filter((im) => im.view === 'FRONT');
      expect(fronts.length).toBeLessThanOrEqual(1);
      const ids = group.images.map((im) => im.imageId);
      expect(ids.includes('aFront') && ids.includes('bFront')).toBe(false);
    });
  });
});

describe('ORPHANS SCENARIO, end to end (Change C)', () => {
  // Two products, four photos: a1+a2 are one product's two angles, b1+b2 are
  // another's. a1-a2 join both ways (Change A's two-vote dance). b1 and b2
  // never confirm each other - every verdict that reaches either of them is
  // a hedge, so the model never commits.
  //
  // NOTE on the reason text asserted below: classifyAlone's checks run in a
  // fixed order (budget/rate-limited/failed/HEDGED/no-candidates/truncated/
  // weak-only/reciprocal/alone-or-orphan). A hedge touching a photograph
  // marks it hedged BEFORE the alone-or-orphan check is ever reached, so
  // this scenario - by construction, per the brief - actually exercises the
  // pre-existing 'hedged' reason, not 'orphan' (Change C never disables the
  // 'hedged' branch; it only renames the terminal 'alone' outcome). Reaching
  // the terminal branch itself needs a real cosine floor, which needs
  // MIN_FLOOR_SAMPLES (candidatePool.ts, 30) same-bucket-pair samples - not
  // obtainable from a 4-photo fixture at any bucket assignment. The
  // 'orphan' reason text itself, and the classification swap it depends on,
  // are verified directly against the exported constant/map in
  // groupFolderV3.test.ts's 'NO_SINGLE_PHOTO_PRODUCTS (Change C)' block.
  // What THIS test verifies end to end: b1 and b2 are never silently
  // accepted as two separate one-photo products - they land in
  // `unassigned` either way.
  it('joins a1-a2, leaves b1 and b2 unassigned rather than as one-photo products', async () => {
    const images = [image('a1'), image('a2'), image('b1'), image('b2')];
    const queues = {
      angle_atlas: [JSON.stringify([
        { photo: 0, angle: 'FRONT', category: 'FOOTWEAR', colour: 'black' },
        { photo: 1, angle: 'LEFT', category: 'FOOTWEAR', colour: 'black' },
        { photo: 2, angle: 'BACK', category: 'FOOTWEAR', colour: 'red' },
        { photo: 3, angle: 'RIGHT', category: 'FOOTWEAR', colour: 'red' },
      ])],
      identity: [
        // wave1: a1 asks [a2,b2,b1] (that pool/priority order traced via
        // the vectors above: a2 is a1's closest neighbour, then b2, b1).
        // Confirms a2 (first vote, pending); cleanly rejects both of b's
        // photos - a1 never hedges about anything, so a1 itself never
        // becomes hedged even though its reply mentions b1/b2.
        JSON.stringify([
          { photo: 1, same: true, sure: true, because: 'same logo' },
          { photo: 2, same: false, sure: true, because: 'different product' },
          { photo: 3, same: false, sure: true, because: 'different product' },
        ]),
        // wave2: a2 asks [a1,b2,b1] - confirms a1 from the OTHER framing
        // (Change A's second vote -> MERGED), rejects b's photos again.
        JSON.stringify([
          { photo: 1, same: true, sure: true, because: 'same logo' },
          { photo: 2, same: false, sure: true, because: 'different product' },
          { photo: 3, same: false, sure: true, because: 'different product' },
        ]),
        // wave3: b1 asks [b2] - a1/a2 are already excluded from b1's pool
        // (real NOT-SAME from wave1/2), leaving only b2. Hedge: the model
        // will not commit.
        JSON.stringify([{ photo: 1, same: true, sure: false, because: 'maybe' }]),
        // wave4: b2 asks [b1] - same shape, the reciprocal side. Also a
        // hedge: b1-b2 never confirm each other from either direction.
        JSON.stringify([{ photo: 1, same: true, sure: false, because: 'maybe' }]),
      ],
    };
    const ask = async (_p: any[], _s: any, name: string) => {
      const queue = (queues as Record<string, string[]>)[name] ?? queues.identity;
      const text = queue.shift();
      if (text === undefined) throw new Error(`script exhausted for ${name}`);
      return { text, usage: null };
    };

    const result = await groupFolderV3(images, undefined, undefined, undefined, ask);

    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].images.map((im) => im.imageId).sort()).toEqual(['a1', 'a2']);
    expect(result.unassigned.sort()).toEqual(['b1', 'b2']);
    expect(result.uncertainReasons?.b1).toBeDefined();
    expect(result.uncertainReasons?.b2).toBeDefined();
    // No group ever presents b1 or b2 as a confident standalone product.
    result.groups.forEach((g) => {
      expect(g.images.some((im) => im.imageId === 'b1' || im.imageId === 'b2')).toBe(false);
    });
  });
});

describe('replay round-trip', () => {
  it('records, dumps, loads and replays identically', async () => {
    const sink: any[] = [];
    const fake = async () => ({ text: '[{"photo":1,"same":false,"sure":true}]', usage: null });
    const recorder = recordingAsk(fake as any, sink);
    await recorder([], {}, 'identity');
    const replayed = replayingAsk(loadRecording(dumpRecording(sink)));
    const { text } = await replayed([], {}, 'identity');
    expect(text).toBe('[{"photo":1,"same":false,"sure":true}]');
  });
  it('an exhausted replay throws rather than inventing an answer', async () => {
    const replayed = replayingAsk([]);
    await expect(replayed([], {}, 'identity')).rejects.toThrow(/exhausted/);
  });
});
