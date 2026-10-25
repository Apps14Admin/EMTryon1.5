import { describe, it, expect, vi, beforeEach } from 'vitest';

const { generateContent } = vi.hoisted(() => ({ generateContent: vi.fn() }));

vi.mock('@google/genai', () => ({
  GoogleGenAI: vi.fn().mockImplementation(() => ({ models: { generateContent } })),
}));

import {
  groupFolder,
  clearAttributeCache,
  readAudit,
  applyAudit,
  auditSelection,
  summarise,
  MAX_AUDIT_IMAGES,
  type FolderImage,
  type GroupedImage,
  type ProductGroup,
} from './productGrouper';

vi.stubGlobal('window', { location: { origin: 'http://localhost:3000' } });

/**
 * THE AUDIT — the last pass, and the only one that looks at a product's
 * photographs together.
 *
 * Everything before it decides on WORDS: a reading per photograph, folded into
 * a fingerprint, compared by weighted arithmetic. That has a ceiling no further
 * rule can lift, because in a folder of near-identical items the honest
 * descriptions converge and the difference between two black trainers is simply
 * not in the text any more.
 *
 * So the audit hands the question back to the model with the actual pictures,
 * one product at a time, and tells it that what grouped them was mechanical.
 *
 * The asymmetry these tests pin down: the audit may SPLIT and may never MERGE.
 * A wrong split costs one click on the review screen. A wrong merge renders one
 * shoe wearing another shoe's sole and nothing downstream catches it.
 */

const reply = (payload: unknown) => ({
  candidates: [
    {
      content: {
        parts: [{ text: typeof payload === 'string' ? payload : JSON.stringify(payload) }],
      },
    },
  ],
});

const folder = (count: number): FolderImage[] =>
  Array.from({ length: count }, (_, i) => ({
    id: `img-${i}`,
    fileName: `IMG_${String(i + 1).padStart(3, '0')}.jpg`,
    full: `FULL-${i}`,
    thumb: `THUMB-${i}`,
    scout: `SCOUT-${i}`,
  }));

const textOf = (parts: any[]): string =>
  parts
    .filter((part) => typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n');

const isAudit = (parts: any[]): boolean =>
  textOf(parts).includes('pre-grouped by deterministic visual rules');

/** Which photographs an audit request carried, by index. */
const auditedIndices = (parts: any[]): number[] =>
  parts
    .filter((part) => part.inlineData)
    .map((part) => Number(String(part.inlineData.data).replace(/^(SCOUT|THUMB)-/, '')));

const auditRequests = () =>
  generateContent.mock.calls
    .map((call: any) => call[0].contents.parts)
    .filter(isAudit);

/**
 * A stand-in that reads every photograph as one product, and answers the audit
 * however the test tells it to.
 *
 * `onAudit` is given the indices of the photographs actually shown, so a test
 * can rule on them by index rather than by guessing the order the selection
 * chose.
 */
const modelSaying = (
  batch: Record<string, unknown>[],
  onAudit: (indices: number[]) => unknown
) => {
  generateContent.mockImplementation(async ({ contents }: any) => {
    const parts: any[] = contents.parts;
    if (isAudit(parts)) return reply(onAudit(auditedIndices(parts)));
    return reply(batch);
  });
};

/** Two photographs of one product, as the reading pass would report them. */
const onePair = [
  { image: 0, product: 'A', angle: 'LEFT', colour: 'black', type: 'sneaker' },
  { image: 1, product: 'A', angle: 'SOLE', colour: 'black', type: 'sneaker' },
];

const idsIn = (group: ProductGroup) => group.images.map((image) => image.imageId).sort();

beforeEach(() => {
  generateContent.mockReset();
  clearAttributeCache();
});

// --- the pass, end to end ------------------------------------------------

describe('the audit, running inside groupFolder', () => {
  it('shows the model the photographs of one product together', async () => {
    modelSaying(onePair, (indices) => indices.map((_, photo) => ({ photo, item: 'A' })));

    await groupFolder(folder(2));

    const requests = auditRequests();
    expect(requests).toHaveLength(1);
    // Both photographs, in ONE request. That is the whole point of the pass:
    // nothing before it ever had them side by side.
    expect(auditedIndices(requests[0]).sort()).toEqual([0, 1]);
  });

  it('sends the thumb, not the smaller scout copy', async () => {
    modelSaying(onePair, (indices) => indices.map((_, photo) => ({ photo, item: 'A' })));

    await groupFolder(folder(2));

    // The audit is the request that has to see a lining, a tread and a logo
    // placement rather than a silhouette, so it gets the larger copy. Reading
    // and ordering are cheap enough on the scout; this is not.
    const carried = auditRequests()[0]
      .filter((part: any) => part.inlineData)
      .map((part: any) => part.inlineData.data);

    expect(carried.every((data: string) => data.startsWith('THUMB-'))).toBe(true);
  });

  it('leaves a group alone when the model confirms it', async () => {
    modelSaying(onePair, (indices) => indices.map((_, photo) => ({ photo, item: 'A' })));

    const result = await groupFolder(folder(2));

    expect(result.groups).toHaveLength(1);
    expect(idsIn(result.groups[0])).toEqual(['img-0', 'img-1']);
  });

  it('splits a group the model says holds two products', async () => {
    // The rules put both photographs in one product — same colour, same type,
    // no disagreeing structural fact between a profile and a sole. Only the
    // pictures say otherwise.
    modelSaying(onePair, (indices) =>
      indices.map((index, photo) => ({
        photo,
        item: index === 1 ? 'B' : 'A',
        because: index === 1 ? 'gum outsole, the other is white' : 'white outsole',
      }))
    );

    const result = await groupFolder(folder(2));

    expect(result.groups).toHaveLength(2);
    expect(result.groups.map(idsIn).sort()).toEqual([['img-0'], ['img-1']]);
  });

  it('puts the reason the model gave on the photograph', async () => {
    modelSaying(onePair, (indices) =>
      indices.map((index, photo) => ({
        photo,
        item: 'A',
        because: index === 1 ? 'same hexagonal tread from underneath' : 'white outsole',
      }))
    );

    const result = await groupFolder(folder(2));
    const placed = result.groups[0].images.find((image) => image.imageId === 'img-1');

    // The only line in the system written by something that looked at the
    // picture, so it replaces the rule's account of why the photo is there.
    expect(placed?.reason).toBe('same hexagonal tread from underneath');
  });

  it('flags both halves of a split for review', async () => {
    modelSaying(onePair, (indices) =>
      indices.map((index, photo) => ({ photo, item: index === 1 ? 'B' : 'A' }))
    );

    const result = await groupFolder(folder(2));

    // A group the model had to take apart is a group whose automatic reading
    // was wrong somewhere. Neither half is presented as settled.
    expect(result.groups.every((group) => group.needsReview || group.flagged)).toBe(true);
  });

  it('says in the log what it re-examined and what it did', async () => {
    modelSaying(onePair, (indices) =>
      indices.map((index, photo) => ({ photo, item: index === 1 ? 'B' : 'A' }))
    );

    const result = await groupFolder(folder(2));

    expect(result.log.some((line) => /Re-examined 1 product/.test(line))).toBe(true);
    expect(result.log.some((line) => /split apart/.test(line))).toBe(true);
  });

  it('never audits a product of one photograph', async () => {
    modelSaying(
      [
        { image: 0, product: 'A', angle: 'LEFT', colour: 'black' },
        { image: 1, product: 'B', angle: 'LEFT', colour: 'olive' },
      ],
      (indices) => indices.map((_, photo) => ({ photo, item: 'A' }))
    );

    await groupFolder(folder(2));

    // Two products of one photograph each. There is nothing for this pass to
    // ask about — one photograph is one item by definition.
    expect(auditRequests()).toHaveLength(0);
  });
});

// --- when it does not work -----------------------------------------------

describe('the audit failing', () => {
  it('leaves the grouping as the rules left it when the reply cannot be read', async () => {
    modelSaying(onePair, () => 'the photographs appear to show footwear');

    const result = await groupFolder(folder(2));

    expect(result.classified).toBe(true);
    expect(result.groups).toHaveLength(1);
    expect(idsIn(result.groups[0])).toEqual(['img-0', 'img-1']);
  });

  it('ignores a reply that answers the READING prompt instead of this one', async () => {
    // `product` is the key the batch prompt answers with, `item` is this one's.
    // Accepting both means a misrouted reply splits a group on an answer to a
    // different question.
    modelSaying(onePair, (indices) =>
      indices.map((index, photo) => ({ photo, product: index === 1 ? 'B' : 'A' }))
    );

    const result = await groupFolder(folder(2));

    expect(result.groups).toHaveLength(1);
  });

  it('keeps the products when the request itself fails', async () => {
    generateContent.mockImplementation(async ({ contents }: any) => {
      if (isAudit(contents.parts)) throw new Error('503 UNAVAILABLE');
      return reply(onePair);
    });

    const result = await groupFolder(folder(2));

    expect(result.classified).toBe(true);
    expect(result.groups).toHaveLength(1);
    expect(result.log.some((line) => /could not be checked and stand as grouped/.test(line))).toBe(
      true
    );
  });
});

// --- cost ----------------------------------------------------------------

describe('what the audit costs', () => {
  /**
   * Enough shared evidence for the two photographs to be one product on the
   * readings ALONE.
   *
   * A cached run rebuilds the grouping from the stored readings and does not
   * keep the model's own product label, so a pair held together only by that
   * label comes back as two products the second time. That is the reading
   * cache's behaviour and not the audit's; this fixture stays out of its way so
   * the test measures the thing it names.
   */
  const evidently = [
    {
      image: 0,
      product: 'A',
      angle: 'LEFT',
      colour: 'black',
      type: 'sneaker',
      silhouette: 'low-top sneaker',
      soleType: 'rubber',
      soleThickness: 'medium',
      soleColour: 'white',
    },
    {
      image: 1,
      product: 'A',
      angle: 'SOLE',
      colour: 'black',
      type: 'sneaker',
      silhouette: 'low-top sneaker',
      soleType: 'rubber',
      soleThickness: 'medium',
      soleColour: 'white',
    },
  ];

  it('does not ask twice about the same photographs', async () => {
    modelSaying(evidently, (indices) => indices.map((_, photo) => ({ photo, item: 'A' })));

    const first = await groupFolder(folder(2));
    expect(first.groups).toHaveLength(1);
    expect(auditRequests()).toHaveLength(1);

    // A fresh upload of the same photographs: new ids, new filenames. The
    // verdict was about the pictures, not about the ids they arrived with.
    const again = folder(2).map((image, i) => ({
      ...image,
      id: `second-${i}`,
      fileName: `different-${i}.jpg`,
    }));

    const second = await groupFolder(again);

    expect(second.groups).toHaveLength(1);
    expect(auditRequests()).toHaveLength(1);
  });
});

// --- reading the answer --------------------------------------------------

describe('readAudit', () => {
  it('reads a letter per photograph', () => {
    expect(
      readAudit(
        [
          { photo: 0, item: 'A', because: 'white outsole' },
          { photo: 1, item: 'B' },
        ],
        2
      )
    ).toEqual([
      { photo: 0, item: 'A', because: 'white outsole' },
      { photo: 1, item: 'B', because: undefined },
    ]);
  });

  it('falls back to position when the reply omits the number', () => {
    expect(readAudit([{ item: 'A' }, { item: 'B' }], 2).map((claim) => claim.photo)).toEqual([0, 1]);
  });

  it('drops a photograph number that was never sent', () => {
    expect(readAudit([{ photo: 9, item: 'A' }], 2)).toEqual([]);
  });

  it('keeps only the first claim about a photograph', () => {
    const claims = readAudit(
      [
        { photo: 0, item: 'A' },
        { photo: 0, item: 'B' },
      ],
      2
    );
    expect(claims).toHaveLength(1);
    expect(claims[0].item).toBe('A');
  });

  it('refuses the key the reading prompt answers with', () => {
    expect(readAudit([{ photo: 0, product: 'A' }], 1)).toEqual([]);
  });

  it('treats a letter as a letter whatever case it arrives in', () => {
    expect(readAudit([{ photo: 0, item: 'a' }], 1)[0].item).toBe('A');
  });
});

// --- applying it ---------------------------------------------------------

const groupOf = (id: string, imageIds: string[]): ProductGroup =>
  summarise({
    id,
    name: id,
    category: 'FOOTWEAR',
    images: imageIds.map((imageId) => ({
      imageId,
      view: 'OTHER' as const,
      viewSource: 'model' as const,
    })),
    confidence: 1,
    needsReview: false,
  });

describe('applyAudit', () => {
  it('changes nothing when every photograph gets one letter', () => {
    const groups = [groupOf('product-1', ['a', 'b', 'c'])];
    const result = applyAudit(
      groups,
      [
        { photo: 0, item: 'A' },
        { photo: 1, item: 'A' },
        { photo: 2, item: 'A' },
      ],
      ['a', 'b', 'c']
    );

    expect(result.splits).toBe(0);
    expect(result.groups).toBe(groups);
  });

  it('splits one letter off and leaves the majority in place', () => {
    const result = applyAudit(
      [groupOf('product-1', ['a', 'b', 'c'])],
      [
        { photo: 0, item: 'A' },
        { photo: 1, item: 'A' },
        { photo: 2, item: 'B' },
      ],
      ['a', 'b', 'c']
    );

    expect(result.splits).toBe(1);
    expect(result.groups.map(idsIn).sort()).toEqual([['a', 'b'], ['c']]);
  });

  it('makes a group per letter when the model finds three items', () => {
    const result = applyAudit(
      [groupOf('product-1', ['a', 'b', 'c', 'd'])],
      [
        { photo: 0, item: 'A' },
        { photo: 1, item: 'A' },
        { photo: 2, item: 'B' },
        { photo: 3, item: 'C' },
      ],
      ['a', 'b', 'c', 'd']
    );

    expect(result.splits).toBe(2);
    expect(result.groups).toHaveLength(3);
    expect(result.groups.map(idsIn).sort()).toEqual([['a', 'b'], ['c'], ['d']]);
  });

  it('leaves a photograph the model skipped where it was', () => {
    // A missing answer is not a verdict. Moving a photograph on the strength of
    // one would be inventing evidence at the point this pass exists to stop it.
    const result = applyAudit(
      [groupOf('product-1', ['a', 'b', 'c'])],
      [
        { photo: 0, item: 'A' },
        { photo: 2, item: 'B' },
      ],
      ['a', 'b', 'c']
    );

    const home = result.groups.find((group) => idsIn(group).includes('a'))!;
    expect(idsIn(home)).toEqual(['a', 'b']);
  });

  it('touches no other product in the folder', () => {
    const result = applyAudit(
      [groupOf('product-1', ['a', 'b']), groupOf('product-2', ['x', 'y'])],
      [
        { photo: 0, item: 'A' },
        { photo: 1, item: 'B' },
      ],
      ['a', 'b']
    );

    expect(result.groups.map(idsIn)).toContainEqual(['x', 'y']);
  });

  it('collects the reasons whether or not anything was split', () => {
    const result = applyAudit(
      [groupOf('product-1', ['a', 'b'])],
      [
        { photo: 0, item: 'A', because: 'white outsole' },
        { photo: 1, item: 'A', because: 'same tread from underneath' },
      ],
      ['a', 'b']
    );

    expect(result.splits).toBe(0);
    expect(result.reasons.get('b')).toBe('same tread from underneath');
  });

  it('ignores a claim about a photograph that was not in the group', () => {
    const result = applyAudit(
      [groupOf('product-1', ['a', 'b'])],
      [
        { photo: 0, item: 'A' },
        { photo: 1, item: 'B' },
      ],
      ['a', 'missing']
    );

    expect(result.splits).toBe(0);
  });
});

// --- choosing what to send -----------------------------------------------

const viewed = (views: string[]): GroupedImage[] =>
  views.map((view, i) => ({
    imageId: `img-${i}`,
    view: view as GroupedImage['view'],
    viewSource: 'model',
  }));

describe('auditSelection', () => {
  it('sends everything when the group is small enough', () => {
    const images = viewed(['LEFT', 'SOLE', 'BACK']);
    expect(auditSelection(images)).toEqual(images);
  });

  it('takes one of each view before a second of any', () => {
    // Six near-identical profiles and one sole. Sent in order, the request
    // would arrive without the sole — which is the photograph most likely to be
    // the second product.
    const images = viewed(['LEFT', 'LEFT', 'LEFT', 'LEFT', 'SOLE']);
    const chosen = auditSelection(images, 2).map((image) => image.view);

    expect(chosen).toEqual(['LEFT', 'SOLE']);
  });

  it('fills the rest of the budget with the repeats', () => {
    const chosen = auditSelection(viewed(['LEFT', 'LEFT', 'SOLE']), 3);
    expect(chosen.map((image) => image.imageId)).toEqual(['img-0', 'img-2', 'img-1']);
  });

  it('never sends more than the ceiling', () => {
    const images = viewed(Array.from({ length: 20 }, () => 'CLOSEUP'));
    expect(auditSelection(images)).toHaveLength(MAX_AUDIT_IMAGES);
  });
});
