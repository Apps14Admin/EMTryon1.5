import { describe, it, expect } from 'vitest';
import {
  garmentLine,
  originsOfUnit,
  sourceOf,
  unitKeyOf,
  unitLabelOf,
  unitMetaFor,
} from './libraryUnit';

describe('sourceOf', () => {
  it('names a unit by where its garments came from', () => {
    expect(sourceOf(['folder'])).toBe('folder');
    expect(sourceOf(['folder', 'folder'])).toBe('folder');
    expect(sourceOf(['manual'])).toBe('manual');
    expect(sourceOf(['folder', 'manual'])).toBe('mixed');
  });

  it('calls a unit with no garments mixed rather than guessing', () => {
    expect(sourceOf([])).toBe('mixed');
  });
});

describe('originsOfUnit', () => {
  it('reads the folder from a group behind the slot and manual from photos without one', () => {
    const unit = {
      groups: { top: { id: 'product-1' } },
      slots: { top: [{ data: 'x' }], bottoms: [{ data: 'y' }], footwear: null },
    };
    expect(originsOfUnit(unit)).toEqual(['folder', 'manual']);
  });

  it('says nothing for an empty slot', () => {
    expect(originsOfUnit({ groups: {}, slots: { top: null, bottoms: null, footwear: null } })).toEqual([]);
  });
});

describe('unitMetaFor', () => {
  it('keys the unit to its run and carries kind and source', () => {
    expect(
      unitMetaFor({ runKey: 'run-1', unitId: 'outfit-abc', kind: 'outfit', origins: ['folder', 'manual'] })
    ).toEqual({ unitKey: 'run-1::outfit-abc', kind: 'outfit', source: 'mixed' });
  });

  it('gives the same unit in the same run the same key, and a new run a new one', () => {
    expect(unitKeyOf('run-1', 'product-2')).toBe(unitKeyOf('run-1', 'product-2'));
    expect(unitKeyOf('run-1', 'product-2')).not.toBe(unitKeyOf('run-2', 'product-2'));
  });
});

describe('garmentLine', () => {
  it('lists the garments top to toe and skips empty slots', () => {
    expect(garmentLine({ footwear: 'Runner', top: 'Tee', bottoms: 'Shorts' })).toBe('Tee + Shorts + Runner');
    expect(garmentLine({ footwear: 'Runner' })).toBe('Runner');
    expect(garmentLine({})).toBe('');
  });
});

describe('unitLabelOf', () => {
  it('labels each kind from its own counter', () => {
    expect(unitLabelOf('product', 12)).toBe('Product 12');
    expect(unitLabelOf('outfit', 3)).toBe('Outfit 3');
  });
});
