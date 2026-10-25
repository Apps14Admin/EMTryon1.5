import { describe, it, expect } from 'vitest';
import type { ProductGroup } from './productModel';
import { MANUAL_PRODUCT, type OutfitSpec } from './batchRunner';
import { clearSlot, dragFor, frontImageOf, manualDrag, placeInOutfit, readDrag } from './outfitBoard';

const group = (id: string, category: ProductGroup['category'], views: string[]): ProductGroup =>
  ({
    id,
    name: id,
    category,
    images: views.map((view, i) => ({ imageId: `${id}-${i}`, view, viewSource: 'model' })),
    confidence: 1,
    needsReview: false,
  }) as ProductGroup;

const outfit = (id: string, slots: Partial<OutfitSpec> = {}): OutfitSpec => ({
  id,
  name: id,
  footwear: null,
  bottoms: null,
  top: null,
  ...slots,
});

describe('frontImageOf', () => {
  it('prefers the FRONT view', () => {
    expect(frontImageOf(group('g', 'FOOTWEAR', ['SOLE', 'FRONT', 'BACK']))).toBe('g-1');
  });
  it('falls back to the first photo when nothing is tagged FRONT', () => {
    expect(frontImageOf(group('g', 'FOOTWEAR', ['SOLE', 'BACK']))).toBe('g-0');
  });
  it('is null for a product with no photos', () => {
    expect(frontImageOf(group('g', 'FOOTWEAR', []))).toBeNull();
  });
});

describe('dragFor', () => {
  it('carries the slot the product category maps to', () => {
    expect(dragFor(group('t', 'TOP', ['FRONT']))).toEqual({ product: 't', slot: 'top' });
    expect(dragFor(group('b', 'BOTTOMS', ['FRONT']))).toEqual({ product: 'b', slot: 'bottoms' });
    expect(dragFor(group('s', 'FOOTWEAR', ['FRONT']))).toEqual({ product: 's', slot: 'footwear' });
  });
  it('records the outfit it was dragged out of', () => {
    expect(dragFor(group('t', 'TOP', ['FRONT']), 'o1')).toEqual({ product: 't', slot: 'top', from: 'o1' });
  });
  it('names the manual upload', () => {
    expect(manualDrag('bottoms')).toEqual({ product: MANUAL_PRODUCT, slot: 'bottoms' });
  });
});

describe('placeInOutfit', () => {
  it('lands the product in its own slot whatever zone it was dropped on', () => {
    const next = placeInOutfit([outfit('o1')], 'o1', { product: 't', slot: 'top' });
    expect(next[0]).toEqual(outfit('o1', { top: 't' }));
  });

  it('replaces a product already in that slot', () => {
    const next = placeInOutfit([outfit('o1', { top: 'old' })], 'o1', { product: 'new', slot: 'top' });
    expect(next[0].top).toBe('new');
  });

  it('leaves the other slots alone', () => {
    const next = placeInOutfit([outfit('o1', { bottoms: 'b', footwear: 's' })], 'o1', { product: 't', slot: 'top' });
    expect(next[0]).toEqual(outfit('o1', { top: 't', bottoms: 'b', footwear: 's' }));
  });

  it('lets the same product sit in several outfits', () => {
    let outfits = [outfit('o1'), outfit('o2')];
    outfits = placeInOutfit(outfits, 'o1', { product: 's', slot: 'footwear' });
    outfits = placeInOutfit(outfits, 'o2', { product: 's', slot: 'footwear' });
    expect(outfits.map((o) => o.footwear)).toEqual(['s', 's']);
  });

  it('moves a product dragged out of another outfit', () => {
    const next = placeInOutfit([outfit('o1', { top: 't' }), outfit('o2')], 'o2', { product: 't', slot: 'top', from: 'o1' });
    expect(next[0].top).toBeNull();
    expect(next[1].top).toBe('t');
  });

  it('a move onto its own outfit changes nothing', () => {
    const before = [outfit('o1', { top: 't' })];
    const next = placeInOutfit(before, 'o1', { product: 't', slot: 'top', from: 'o1' });
    expect(next).toEqual(before);
  });

  it('ignores a drop on an outfit that no longer exists', () => {
    const before = [outfit('o1', { top: 't' })];
    expect(placeInOutfit(before, 'gone', { product: 'x', slot: 'top', from: 'o1' })).toBe(before);
  });
});

describe('clearSlot', () => {
  it('empties one slot of one outfit', () => {
    const next = clearSlot([outfit('o1', { top: 't', bottoms: 'b' }), outfit('o2', { top: 't' })], 'o1', 'top');
    expect(next[0]).toEqual(outfit('o1', { bottoms: 'b' }));
    expect(next[1].top).toBe('t');
  });
});

describe('readDrag', () => {
  it('round-trips a drag', () => {
    const drag = { product: 'p', slot: 'bottoms' as const, from: 'o1' };
    expect(readDrag(JSON.stringify(drag))).toEqual(drag);
  });
  it('rejects anything that is not ours', () => {
    expect(readDrag(null)).toBeNull();
    expect(readDrag('')).toBeNull();
    expect(readDrag('not json')).toBeNull();
    expect(readDrag(JSON.stringify({ product: 'p', slot: 'hat' }))).toBeNull();
    expect(readDrag(JSON.stringify({ slot: 'top' }))).toBeNull();
  });
});
