import { describe, it, expect } from 'vitest';
import {
  extractJsonArray,
  toPlacements,
  colourFamilies,
  colourAllows,
  summarise,
  renumber,
  mergeGroups,
  moveImage,
  assignedIds,
  type ProductGroup,
  type FolderImage,
} from './productGrouper';

const image = (id: string): FolderImage => ({
  id,
  fileName: `${id}.jpg`,
  full: 'FULL',
  thumb: 'THUMB',
});

const group = (id: string, imageIds: string[], extra: Partial<ProductGroup> = {}): ProductGroup =>
  summarise({
    id,
    name: `Product ${id}`,
    category: 'FOOTWEAR',
    images: imageIds.map((imageId) => ({ imageId, view: 'FRONT', viewSource: 'model' as const })),
    confidence: 1,
    needsReview: false,
    ...extra,
  });

describe('extractJsonArray', () => {
  it('reads a bare array', () => {
    expect(extractJsonArray('[{"image":0}]')).toEqual([{ image: 0 }]);
  });

  it('survives code fences and prose', () => {
    const reply = 'Here you go:\n```json\n[{"image":0,"group":-1}]\n```\nHope that helps.';
    expect(extractJsonArray(reply)).toEqual([{ image: 0, group: -1 }]);
  });

  it('returns null for a reply with no array', () => {
    expect(extractJsonArray('I cannot tell these apart.')).toBeNull();
  });

  it('returns null for malformed JSON rather than throwing', () => {
    expect(extractJsonArray('[{"image":0,]')).toBeNull();
  });
});

describe('toPlacements', () => {
  it('reads a product and an angle per photo', () => {
    const out = toPlacements(
      [
        { image: 0, product: 'A', angle: 'FRONT', colour: 'grey white' },
        { image: 1, product: 'A', angle: 'SOLE' },
      ],
      2
    );
    expect(out.map((p) => p.product)).toEqual(['A', 'A']);
    expect(out.map((p) => p.view)).toEqual(['FRONT', 'SOLE']);
    expect(out[0].colour).toBe('grey white');
  });

  it('treats the product label case-insensitively', () => {
    expect(toPlacements([{ image: 0, product: 'p0' }], 1)[0].product).toBe('P0');
  });

  it('drops an answer about a photo that was never sent', () => {
    expect(toPlacements([{ image: 9, product: 'A' }], 2)).toEqual([]);
  });

  it('drops an answer that names no product', () => {
    expect(toPlacements([{ image: 0, angle: 'FRONT' }], 2)).toEqual([]);
  });

  it('keeps only the first answer about a photo', () => {
    const out = toPlacements(
      [
        { image: 0, product: 'A' },
        { image: 0, product: 'B' },
      ],
      2
    );
    expect(out).toHaveLength(1);
    expect(out[0].product).toBe('A');
  });

  it('falls back to reply position when the index is missing', () => {
    const out = toPlacements([{ product: 'A' }, { product: 'B' }], 2);
    expect(out.map((p) => p.image)).toEqual([0, 1]);
  });

  it('accepts the other names the model gives the field', () => {
    expect(toPlacements([{ image: 0, group: 'A' }], 1)[0].product).toBe('A');
    expect(toPlacements([{ image: 0, shoe: 'B' }], 1)[0].product).toBe('B');
  });

  it('normalises loose angle wording', () => {
    expect(toPlacements([{ image: 0, product: 'A', angle: 'outsole' }], 1)[0].view).toBe('SOLE');
    expect(toPlacements([{ image: 0, product: 'A', angle: 'rear' }], 1)[0].view).toBe('BACK');
  });

  it('leaves an unrecognisable angle unnamed rather than guessing', () => {
    expect(toPlacements([{ image: 0, product: 'A', angle: 'diagonal-ish' }], 1)[0].view)
      .toBeUndefined();
  });
});

describe('colourFamilies', () => {
  it('folds shades into the family that distinguishes products', () => {
    expect([...colourFamilies('charcoal')]).toEqual(['black']);
    expect([...colourFamilies('silver')]).toEqual(['grey']);
    expect([...colourFamilies('khaki')]).toEqual(['green']);
  });

  it('reads every colour in a multi-colour description', () => {
    expect([...colourFamilies('grey white')].sort()).toEqual(['grey', 'white']);
  });

  it('ignores finish words that describe no colour', () => {
    expect([...colourFamilies('dark matte black')]).toEqual(['black']);
  });

  it('yields nothing for a description naming no colour', () => {
    expect([...colourFamilies('multicolour')]).toEqual([]);
    expect([...colourFamilies(undefined)]).toEqual([]);
  });
});

describe('colourAllows', () => {
  it('refuses two products whose colours do not overlap', () => {
    expect(colourAllows('grey white', 'olive green')).toBe(false);
    expect(colourAllows('black', 'white')).toBe(false);
  });

  it('allows the same colour described loosely', () => {
    expect(colourAllows('charcoal', 'black')).toBe(true);
    expect(colourAllows('grey white', 'silver white')).toBe(true);
  });

  it('allows a partial overlap, since an angle may not show every colour', () => {
    expect(colourAllows('grey white', 'grey')).toBe(true);
  });

  it('cannot veto when a colour is unknown', () => {
    expect(colourAllows(undefined, 'olive')).toBe(true);
    expect(colourAllows('multicolour', 'olive')).toBe(true);
  });
});

describe('summarise', () => {
  it('flags review when a photo landed without a named angle', () => {
    const g = summarise({
      ...group('a', []),
      images: [{ imageId: 'x', view: 'OTHER', viewSource: 'fallback' }],
    });
    expect(g.needsReview).toBe(true);
  });

  it('does not flag a group whose photos were all identified', () => {
    const g = summarise({
      ...group('a', []),
      images: [{ imageId: 'x', view: 'FRONT', viewSource: 'model' }],
    });
    expect(g.needsReview).toBe(false);
  });

  it('keeps a flag set for another reason', () => {
    const g = summarise({
      ...group('a', []),
      images: [{ imageId: 'x', view: 'FRONT', viewSource: 'model' }],
      flagged: true,
    });
    expect(g.needsReview).toBe(true);
  });
});

describe('renumber', () => {
  it('renames default-named groups to their new position', () => {
    const out = renumber([group('p9', ['a']), group('p3', ['b'])]);
    expect(out.map((g) => g.id)).toEqual(['product-1', 'product-2']);
  });

  it('leaves a user-chosen name alone', () => {
    const renamed = { ...group('p1', ['a']), name: 'Air Zoom Black' };
    expect(renumber([renamed])[0].name).toBe('Air Zoom Black');
  });

  it('restores default numbering for untouched names', () => {
    const defaults = [
      { ...group('p1', ['a']), name: 'Product 007' },
      { ...group('p2', ['b']), name: 'Product 009' },
    ];
    expect(renumber(defaults).map((g) => g.name)).toEqual(['Product 001', 'Product 002']);
  });
});

describe('mergeGroups', () => {
  it('folds the source into the target and drops the source', () => {
    const out = mergeGroups([group('p1', ['a']), group('p2', ['b'])], 'p2', 'p1');
    expect(out).toHaveLength(1);
    expect(out[0].images.map((i) => i.imageId)).toEqual(['a', 'b']);
  });

  it('does not duplicate a photo the target already holds', () => {
    const out = mergeGroups([group('p1', ['a', 'b']), group('p2', ['b', 'c'])], 'p2', 'p1');
    expect(out[0].images.map((i) => i.imageId)).toEqual(['a', 'b', 'c']);
  });

  it('is a no-op for an unknown group', () => {
    const groups = [group('p1', ['a'])];
    expect(mergeGroups(groups, 'nope', 'p1')).toBe(groups);
  });
});

describe('moveImage', () => {
  it('moves a photo between groups', () => {
    const out = moveImage([group('p1', ['a', 'b']), group('p2', ['c'])], 'b', 'p2');
    expect(out[0].images.map((i) => i.imageId)).toEqual(['a']);
    expect(out[1].images.map((i) => i.imageId)).toEqual(['c', 'b']);
  });

  it('drops a photo out of every group when the target is null', () => {
    const out = moveImage([group('p1', ['a', 'b'])], 'b', null);
    expect(assignedIds(out).has('b')).toBe(false);
  });

  it('removes a group left empty by the move', () => {
    const out = moveImage([group('p1', ['a']), group('p2', ['b'])], 'a', 'p2');
    expect(out).toHaveLength(1);
    expect(out[0].images.map((i) => i.imageId)).toEqual(['b', 'a']);
  });

  it('is a no-op for an unknown photo', () => {
    const groups = [group('p1', ['a'])];
    expect(moveImage(groups, 'zzz', null)).toBe(groups);
  });
});

