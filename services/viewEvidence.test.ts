import { describe, it, expect } from 'vitest';
import { missingViewEvidence, SIDE_DEPENDENT_STYLES, VIEW_DEPENDENT_STYLES } from './viewEvidence';
import type { OutfitSlots } from './batchRunner';

/** Every visible style in the production picker, for the exhaustive sweep. */
const VISIBLE_STYLES = [
  'front',
  'three_quarter',
  'side',
  'back',
  'top_front_torso',
  'top_upper_body',
  'top_fabric_detail',
  'detail',
  'side_detail',
  'back_detail',
  'ground_front',
  'ground_side',
  'ground_rear',
  'sole_detail',
  'overhead_detail',
  'top_back_view',
];

const photo = (view?: string) => ({ data: 'AAAA', view });
const slots = (o: Partial<OutfitSlots> = {}): OutfitSlots => ({
  footwear: null,
  bottoms: null,
  top: null,
  ...o,
});

describe('SIDE_DEPENDENT_STYLES', () => {
  it('is exactly side, side_detail and ground_side', () => {
    expect([...SIDE_DEPENDENT_STYLES].sort()).toEqual(['ground_side', 'side', 'side_detail']);
  });

  it('marks no other visible style side-dependent', () => {
    const flagged = VISIBLE_STYLES.filter((s) => SIDE_DEPENDENT_STYLES.has(s));
    expect(flagged.sort()).toEqual(['ground_side', 'side', 'side_detail']);
  });
});

describe('non-side styles are never blocked', () => {
  // Front-only evidence for every garment: the worst case for a side shot,
  // and irrelevant to every other shot.
  const frontOnly = slots({
    footwear: [photo('FRONT')],
    bottoms: [photo('FRONT')],
    top: [photo('FRONT')],
  });

  for (const style of VISIBLE_STYLES.filter((s) => !VIEW_DEPENDENT_STYLES.has(s))) {
    it(`${style} passes with front-only photographs`, () => {
      expect(missingViewEvidence(frontOnly, {}, [style])).toEqual([]);
    });
  }
});

describe('side evidence per garment', () => {
  it('accepts LEFT for footwear', () => {
    expect(missingViewEvidence(slots({ footwear: [photo('LEFT')] }), {}, ['side_detail'])).toEqual([]);
  });

  it('accepts RIGHT for footwear', () => {
    expect(missingViewEvidence(slots({ footwear: [photo('RIGHT')] }), {}, ['side_detail'])).toEqual([]);
  });

  it('accepts LEFT for bottoms', () => {
    expect(missingViewEvidence(slots({ bottoms: [photo('LEFT')] }), {}, ['side'])).toEqual([]);
  });

  it('accepts RIGHT for bottoms', () => {
    expect(missingViewEvidence(slots({ bottoms: [photo('RIGHT')] }), {}, ['side'])).toEqual([]);
  });

  it('accepts LEFT for top', () => {
    expect(missingViewEvidence(slots({ top: [photo('LEFT')] }), {}, ['side'])).toEqual([]);
  });

  it('accepts RIGHT for top', () => {
    expect(missingViewEvidence(slots({ top: [photo('RIGHT')] }), {}, ['side'])).toEqual([]);
  });

  it('accepts a lower-case view name', () => {
    expect(missingViewEvidence(slots({ footwear: [photo('left')] }), {}, ['side'])).toEqual([]);
  });

  it('passes when all three garments carry side evidence', () => {
    const all = slots({
      footwear: [photo('FRONT'), photo('LEFT')],
      bottoms: [photo('FRONT'), photo('RIGHT')],
      top: [photo('FRONT'), photo('LEFT')],
    });
    expect(missingViewEvidence(all, {}, ['side'])).toEqual([]);
  });
});

describe('blocking', () => {
  it('blocks one garment that has no side photograph', () => {
    const found = missingViewEvidence(
      slots({ footwear: [photo('FRONT'), photo('BACK')] }),
      { footwear: 'PUMA Softride' },
      ['side_detail']
    );
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ styleId: 'side_detail', slot: 'footwear', product: 'PUMA Softride' });
  });

  it('names every affected garment when several are missing', () => {
    const found = missingViewEvidence(
      slots({
        footwear: [photo('FRONT')],
        bottoms: [photo('BACK')],
        top: [photo('FRONT')],
      }),
      { footwear: 'PUMA Softride', bottoms: 'adidas pants', top: 'Nike tee' },
      ['side']
    );
    expect(found.map((f) => f.product).sort()).toEqual(['Nike tee', 'PUMA Softride', 'adidas pants']);
  });

  it('falls back to the slot word when a garment has no product name', () => {
    const found = missingViewEvidence(slots({ bottoms: [photo('FRONT')] }), {}, ['side']);
    expect(found[0].product).toBe('the trousers');
  });

  it('reports each side shot in a multi-shot run', () => {
    const found = missingViewEvidence(
      slots({ footwear: [photo('FRONT')] }),
      {},
      ['front', 'side', 'ground_side', 'back']
    );
    expect(found.map((f) => f.styleId).sort()).toEqual(['ground_side', 'side']);
  });
});

describe('absent garments never block', () => {
  it('ignores a slot with no photographs', () => {
    expect(missingViewEvidence(slots({ footwear: [photo('LEFT')] }), {}, ['side'])).toEqual([]);
  });

  it('ignores an empty array as well as null', () => {
    expect(missingViewEvidence(slots({ footwear: [], bottoms: null }), {}, ['side'])).toEqual([]);
  });

  it('does not require a top for the sneaker close-ups, which crop it out', () => {
    const noTopEvidence = slots({ footwear: [photo('LEFT')], top: [photo('FRONT')] });
    expect(missingViewEvidence(noTopEvidence, {}, ['side_detail'])).toEqual([]);
    expect(missingViewEvidence(noTopEvidence, {}, ['ground_side'])).toEqual([]);
    // The full side profile DOES show the top, so there it is required.
    expect(missingViewEvidence(noTopEvidence, {}, ['side'])).toHaveLength(1);
  });
});

describe('view-less photographs follow the renderer', () => {
  // trimToShot keeps `!p.view` for every shot, so these reach the model and
  // must count as evidence. A stricter guard would block a render the
  // renderer would have served.
  it('accepts the primary upload, which never carries a view', () => {
    expect(missingViewEvidence(slots({ footwear: [{ data: 'AAAA' }] }), {}, ['side'])).toEqual([]);
  });

  it('accepts an unconfirmed angle photo, whose slot name is withheld', () => {
    const unconfirmed = slots({ bottoms: [photo('FRONT'), { data: 'BBBB' }] });
    expect(missingViewEvidence(unconfirmed, {}, ['side'])).toEqual([]);
  });

  it('still blocks when every photograph is named and none is a side', () => {
    const named = slots({ top: [photo('FRONT'), photo('BACK')] });
    expect(missingViewEvidence(named, {}, ['side'])).toHaveLength(1);
  });
});

describe('the reference-dependent shots', () => {
  it('knows exactly which shots depend on a specific face', () => {
    expect([...VIEW_DEPENDENT_STYLES].sort()).toEqual([
      'ground_side',
      'overhead_detail',
      'side',
      'side_detail',
      'sole_detail',
      'top_back_view',
    ]);
  });

  describe('sole / under view', () => {
    it('passes when the shoe has a SOLE photograph', () => {
      const ok = slots({ footwear: [photo('FRONT'), photo('SOLE')] });
      expect(missingViewEvidence(ok, {}, ['sole_detail'])).toEqual([]);
    });

    it('blocks when the shoe has every face except the sole', () => {
      const no = slots({ footwear: [photo('FRONT'), photo('BACK'), photo('LEFT'), photo('TOP')] });
      const found = missingViewEvidence(no, { footwear: 'PUMA Softride' }, ['sole_detail']);
      expect(found).toHaveLength(1);
      expect(found[0]).toMatchObject({ slot: 'footwear', need: 'SOLE', product: 'PUMA Softride' });
    });

    it('does not demand a sole photograph of the trousers or the shirt', () => {
      const onlyApparelNamed = slots({
        footwear: [photo('SOLE')],
        bottoms: [photo('FRONT')],
        top: [photo('FRONT')],
      });
      expect(missingViewEvidence(onlyApparelNamed, {}, ['sole_detail'])).toEqual([]);
    });
  });

  describe('top-down sneaker view', () => {
    it('passes when the shoe has a TOP photograph', () => {
      const ok = slots({ footwear: [photo('FRONT'), photo('TOP')] });
      expect(missingViewEvidence(ok, {}, ['overhead_detail'])).toEqual([]);
    });

    it('blocks when the shoe has no TOP photograph', () => {
      const no = slots({ footwear: [photo('FRONT'), photo('SOLE')] });
      const found = missingViewEvidence(no, {}, ['overhead_detail']);
      expect(found).toHaveLength(1);
      expect(found[0]).toMatchObject({ slot: 'footwear', need: 'TOP' });
    });
  });

  describe('top back view', () => {
    it('passes when the shirt has a BACK photograph', () => {
      const ok = slots({ top: [photo('FRONT'), photo('BACK')] });
      expect(missingViewEvidence(ok, {}, ['top_back_view'])).toEqual([]);
    });

    it('blocks when the shirt has only a front photograph', () => {
      const no = slots({ top: [photo('FRONT')] });
      const found = missingViewEvidence(no, { top: 'Nike tee' }, ['top_back_view']);
      expect(found).toHaveLength(1);
      expect(found[0]).toMatchObject({ slot: 'top', need: 'BACK', product: 'Nike tee' });
    });

    it('does not block on the footwear, which is not the subject here', () => {
      const ok = slots({ top: [photo('BACK')], footwear: [photo('FRONT')] });
      expect(missingViewEvidence(ok, {}, ['top_back_view'])).toEqual([]);
    });
  });

  describe('absent garments and view-less photographs behave as before', () => {
    it('never blocks a sole shot when no footwear was supplied at all', () => {
      expect(missingViewEvidence(slots({ top: [photo('FRONT')] }), {}, ['sole_detail'])).toEqual([]);
    });

    it('accepts a view-less photograph for the new shots too', () => {
      const bare = slots({ footwear: [{ data: 'AAAA' }], top: [{ data: 'BBBB' }] });
      expect(missingViewEvidence(bare, {}, ['sole_detail', 'overhead_detail', 'top_back_view'])).toEqual([]);
    });
  });

  it('reports every missing face across a mixed multi-shot run', () => {
    const found = missingViewEvidence(
      slots({ footwear: [photo('FRONT')], top: [photo('FRONT')] }),
      { footwear: 'PUMA Softride', top: 'Nike tee' },
      ['front', 'sole_detail', 'overhead_detail', 'top_back_view', 'back']
    );
    expect(found.map((f) => f.styleId).sort()).toEqual([
      'overhead_detail',
      'sole_detail',
      'top_back_view',
    ]);
    expect([...new Set(found.map((f) => f.need))].sort()).toEqual(['BACK', 'SOLE', 'TOP']);
  });
});
