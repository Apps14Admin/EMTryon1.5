import { describe, it, expect } from 'vitest';
import {
  slotFor,
  shotsForProduct,
  countRenders,
  buildProductPayload,
  assertProductIsolation,
  buildRun,
  buildOutfitRun,
  countOutfitRenders,
  individualSlotsFor,
  outfitLine,
  MANUAL_PRODUCT,
  type OutfitSlots,
  type ProductJob,
} from './batchRunner';
import { summarise, type ProductGroup, type FolderImage, type ViewName } from './productGrouper';

const image = (id: string): FolderImage => ({
  id,
  fileName: `${id}.jpg`,
  full: `FULL-${id}`,
  thumb: `THUMB-${id}`,
});

const group = (
  id: string,
  views: [string, ViewName][],
  category: ProductGroup['category'] = 'FOOTWEAR'
): ProductGroup =>
  summarise({
    id,
    name: `Product ${id}`,
    category,
    images: views.map(([imageId, view]) => ({ imageId, view, viewSource: 'model' as const })),
    confidence: 1,
    needsReview: false,
  });

const shotGroups: Record<string, string> = {
  front: 'outfit',
  side: 'outfit',
  detail: 'sneaker',
  shelf: 'sneaker',
};
const groupOfShot = (id: string) => shotGroups[id];

describe('slotFor', () => {
  it('routes each category to its garment slot', () => {
    expect(slotFor('FOOTWEAR')).toBe('footwear');
    expect(slotFor('TOP')).toBe('top');
    expect(slotFor('BOTTOMS')).toBe('bottoms');
  });

  it('treats an unclassified product as footwear', () => {
    expect(slotFor('OTHER')).toBe('footwear');
  });
});

describe('shotsForProduct', () => {
  it('gives footwear every selected shot', () => {
    expect(shotsForProduct('FOOTWEAR', ['front', 'detail'], groupOfShot)).toEqual(['front', 'detail']);
  });

  it('drops sneaker-only shots for apparel', () => {
    expect(shotsForProduct('TOP', ['front', 'detail', 'shelf'], groupOfShot)).toEqual(['front']);
  });

  it('can leave an apparel product with no shots at all', () => {
    expect(shotsForProduct('BOTTOMS', ['detail'], groupOfShot)).toEqual([]);
  });
});

describe('countRenders', () => {
  it('counts products times their applicable shots', () => {
    const groups = [group('p1', [['a', 'FRONT']]), group('p2', [['b', 'FRONT']], 'TOP')];
    // footwear gets both shots, the top gets only the outfit shot.
    expect(countRenders(groups, ['front', 'detail'], groupOfShot)).toBe(3);
  });

  it('is zero when nothing is selected', () => {
    expect(countRenders([group('p1', [['a', 'FRONT']])], [], groupOfShot)).toBe(0);
  });
});

describe('buildProductPayload', () => {
  const byId = new Map([image('a'), image('b'), image('c')].map((i) => [i.id, i]));

  it('makes the FRONT photo the primary and names the rest', () => {
    const payload = buildProductPayload(group('p1', [['a', 'SOLE'], ['b', 'FRONT'], ['c', 'BACK']]), byId);
    // FRONT first, every view kept: the renderer names each photograph by
    // the view the classifier gave it.
    expect(payload).toEqual([
      { data: 'FULL-b', view: 'FRONT' },
      { data: 'FULL-a', view: 'SOLE' },
      { data: 'FULL-c', view: 'BACK' },
    ]);
  });

  it('keeps every named view when no FRONT was detected, and never invents one', () => {
    const payload = buildProductPayload(group('p1', [['a', 'SOLE'], ['b', 'BACK']]), byId);
    expect(payload[0]).toEqual({ data: 'FULL-a', view: 'SOLE' });
    expect(payload[1]).toEqual({ data: 'FULL-b', view: 'BACK' });
  });

  it('sends a photo the classifier could not place as an unlabelled photo of the item', () => {
    const payload = buildProductPayload(group('p1', [['a', 'OTHER'], ['b', 'LEFT']]), byId);
    expect(payload).toEqual([{ data: 'FULL-a' }, { data: 'FULL-b', view: 'LEFT' }]);
  });

  it('sends full-size photos, never the thumbnails used for sorting', () => {
    const payload = buildProductPayload(group('p1', [['a', 'FRONT']]), byId);
    expect(payload).toEqual([{ data: 'FULL-a', view: 'FRONT' }]);
  });

  it('skips a photo that is no longer in the folder', () => {
    const payload = buildProductPayload(group('p1', [['a', 'FRONT'], ['gone', 'BACK']]), byId);
    expect(payload).toHaveLength(1);
  });
});

describe('assertProductIsolation', () => {
  const byId = new Map([image('a'), image('b')].map((i) => [i.id, i]));

  it('passes a payload built from the product itself', () => {
    const g = group('p1', [['a', 'FRONT']]);
    expect(() => assertProductIsolation(buildProductPayload(g, byId), g, byId)).not.toThrow();
  });

  it('throws when another product\'s photo is present', () => {
    const g = group('p1', [['a', 'FRONT']]);
    const contaminated = [...buildProductPayload(g, byId), { data: 'FULL-b', view: 'BACK' as const }];
    expect(() => assertProductIsolation(contaminated, g, byId)).toThrow(/isolation failed/i);
  });

  it('names the product in the error so the failure is traceable', () => {
    const g = group('p1', [['a', 'FRONT']]);
    expect(() => assertProductIsolation([{ data: 'FULL-b' }], g, byId)).toThrow(/Product p1/);
  });
});

describe('buildRun', () => {
  const images = [image('a'), image('b'), image('c')];

  it('builds one job per product with its own payload', () => {
    const groups = [group('p1', [['a', 'FRONT']]), group('p2', [['b', 'FRONT']], 'TOP')];
    const run = buildRun(groups, images, ['front', 'detail'], groupOfShot);

    expect(run).toHaveLength(2);
    expect(run[0].slot).toBe('footwear');
    expect(run[0].shots).toEqual(['front', 'detail']);
    expect(run[1].slot).toBe('top');
    expect(run[1].shots).toEqual(['front']);
  });

  it('keeps every product\'s payload disjoint from the others', () => {
    const groups = [group('p1', [['a', 'FRONT']]), group('p2', [['b', 'FRONT']])];
    const run = buildRun(groups, images, ['front'], groupOfShot);

    const first = new Set(run[0].payload.map((p) => (typeof p === 'string' ? p : p.data)));
    const second = run[1].payload.map((p) => (typeof p === 'string' ? p : p.data));
    expect(second.some((data) => first.has(data))).toBe(false);
  });

  it('drops a product left with no applicable shot', () => {
    const groups = [group('p1', [['a', 'FRONT']], 'TOP')];
    expect(buildRun(groups, images, ['detail'], groupOfShot)).toEqual([]);
  });

  it('drops a product whose photos are all missing', () => {
    const groups = [group('p1', [['gone', 'FRONT']])];
    expect(buildRun(groups, images, ['front'], groupOfShot)).toEqual([]);
  });
});

/**
 * INDIVIDUAL mode changes only the selected product: its own slot holds it,
 * the other two hold nothing, so those slots are rendered plain.
 * A manual upload is worn only when an outfit names it explicitly.
 */
describe('individualSlotsFor', () => {
  const jobOf = (category: ProductGroup['category']): ProductJob => ({
    group: group('p1', [['a', 'FRONT']], category),
    slot: slotFor(category),
    payload: [{ data: 'FULL-a' }],
    shots: ['front'],
  });

  it('puts a footwear product in the footwear slot and nothing elsewhere', () => {
    const slots = individualSlotsFor(jobOf('FOOTWEAR'));
    expect(slots.footwear).toEqual([{ data: 'FULL-a' }]);
    expect(slots.top).toBeNull();
    expect(slots.bottoms).toBeNull();
  });

  it('puts a top product in the top slot and nothing elsewhere', () => {
    const slots = individualSlotsFor(jobOf('TOP'));
    expect(slots.top).toEqual([{ data: 'FULL-a' }]);
    expect(slots.footwear).toBeNull();
    expect(slots.bottoms).toBeNull();
  });
});

/**
 * OUTFIT mode executes the combinations the user composed — folder products
 * by id, the manual upload by `MANUAL_PRODUCT`, or nothing — and never
 * invents one.
 */
describe('buildOutfitRun', () => {
  const images = [image('a'), image('b'), image('c')];
  const byId = new Map(images.map((i) => [i.id, i]));
  const shoes = group('p1', [['a', 'FRONT']], 'FOOTWEAR');
  const shirt = group('p2', [['b', 'FRONT']], 'TOP');
  const pants = group('p3', [['c', 'FRONT']], 'BOTTOMS');
  const groups = [shoes, shirt, pants];
  const groupOfShot = (id: string) => (id === 'detail' ? 'sneaker' : 'outfit');
  const manual: OutfitSlots = { footwear: null, bottoms: [{ data: 'MANUAL-pants' }], top: null };

  it('builds one job per outfit with each slot from its own product, the same product reusable', () => {
    const jobs = buildOutfitRun(
      [
        { id: 'o1', name: 'Outfit 1', footwear: 'p1', bottoms: 'p3', top: 'p2' },
        { id: 'o2', name: 'Outfit 2', footwear: 'p1', bottoms: null, top: 'p2' },
      ],
      groups,
      images,
      ['front', 'detail'],
      groupOfShot
    );
    expect(jobs).toHaveLength(2);
    expect(jobs[0].slots.footwear).toEqual([{ data: 'FULL-a', view: 'FRONT' }]);
    expect(jobs[0].slots.top).toEqual([{ data: 'FULL-b', view: 'FRONT' }]);
    expect(jobs[0].names).toEqual({ footwear: 'Product p1', bottoms: 'Product p3', top: 'Product p2' });
    // An empty slot carries no reference: null, not a guess.
    expect(jobs[1].slots.bottoms).toBeNull();
    expect(jobs[1].shots).toEqual(['front', 'detail']);
    expect(countOutfitRenders(jobs)).toBe(4);
    expect(byId.size).toBe(3);
  });

  it('skips sneaker shots for an outfit with no shoes', () => {
    const jobs = buildOutfitRun(
      [{ id: 'o1', name: 'Outfit 1', footwear: null, bottoms: 'p3', top: 'p2' }],
      groups,
      images,
      ['front', 'detail'],
      groupOfShot
    );
    expect(jobs[0].shots).toEqual(['front']);
  });

  it('wears the manual upload only where an outfit names it', () => {
    const jobs = buildOutfitRun(
      [{ id: 'o1', name: 'Outfit 1', footwear: 'p1', bottoms: MANUAL_PRODUCT, top: null }],
      groups,
      images,
      ['front'],
      groupOfShot,
      manual
    );
    expect(jobs[0].slots.bottoms).toEqual([{ data: 'MANUAL-pants' }]);
    expect(jobs[0].names.bottoms).toBe('manual upload');
    expect(outfitLine(jobs[0].outfit, groups)).toBe('Outfit 1 → Pants manual upload + Shoes Product p1');
  });

  it('refuses an outfit that names an empty manual strip, a missing product, or a product in the wrong slot', () => {
    expect(() =>
      buildOutfitRun([{ id: 'o1', name: 'Outfit 1', footwear: null, bottoms: null, top: MANUAL_PRODUCT }], groups, images, ['front'], groupOfShot, manual)
    ).toThrow(/manual upload, but that strip is empty/);
    expect(() =>
      buildOutfitRun([{ id: 'o1', name: 'Outfit 1', footwear: 'gone', bottoms: null, top: null }], groups, images, ['front'], groupOfShot)
    ).toThrow(/no longer exists/);
    expect(() =>
      buildOutfitRun([{ id: 'o1', name: 'Outfit 1', footwear: 'p2', bottoms: null, top: null }], groups, images, ['front'], groupOfShot)
    ).toThrow(/cannot be worn as footwear/);
  });

  it('drops an outfit with nothing in it', () => {
    expect(
      buildOutfitRun([{ id: 'o1', name: 'Outfit 1', footwear: null, bottoms: null, top: null }], groups, images, ['front'], groupOfShot)
    ).toEqual([]);
  });
});
