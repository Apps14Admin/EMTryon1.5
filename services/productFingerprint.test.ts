import { describe, it, expect } from 'vitest';
import {
  aggregateFingerprint,
  attributeAgreement,
  buildVocabulary,
  colourAllows,
  detailsAgree,
  detailWords,
  dominantColour,
  compare,
  confidenceOf,
  describeFingerprint,
  normaliseAttribute,
  normaliseSize,
  normaliseSku,
  parseAttributes,
  type ImageAttributes,
} from './productFingerprint';

/** A black block-heel square-toe ankle boot with a side zip. */
const productA = (over: Partial<ImageAttributes> = {}): ImageAttributes => ({
  category: 'FOOTWEAR',
  type: 'ankle boot',
  colour: 'black',
  material: 'leather',
  heelType: 'block',
  toeShape: 'square',
  soleThickness: 'thick',
  closure: 'zipper',
  ...over,
});

/** Same colour, same material, same category — a genuinely different boot. */
const productB = (over: Partial<ImageAttributes> = {}): ImageAttributes => ({
  category: 'FOOTWEAR',
  type: 'ankle boot',
  colour: 'black',
  material: 'leather',
  heelType: 'stiletto',
  toeShape: 'pointed',
  soleThickness: 'thin',
  closure: 'zipper',
  ...over,
});

describe('normalising what the model says', () => {
  it('turns every way of saying "I cannot see it" into nothing at all', () => {
    ['unknown', 'UNKNOWN', 'n/a', 'not visible', 'obscured', '  ', '-'].forEach((word) => {
      expect(normaliseAttribute(word)).toBeUndefined();
    });
  });

  it('keeps a real value, folded to one spelling', () => {
    expect(normaliseAttribute('  Block_Heel ')).toBe('block heel');
  });

  it('reads a code through whatever punctuation the label used', () => {
    expect(normaliseSku('XJ-204')).toBe('XJ204');
    expect(normaliseSku('xj 204')).toBe('XJ204');
  });

  it('refuses a word in the code field, which would be a decisive wrong match', () => {
    // Two products both described as "leather" must not match on their SKU.
    expect(normaliseSku('leather')).toBeUndefined();
    expect(normaliseSku('BLACK')).toBeUndefined();
  });

  it('refuses something too short to be an identifier', () => {
    expect(normaliseSku('39')).toBeUndefined();
  });

  it('refuses a SIZE in the code field, which merged two shoes decisively', () => {
    // Found by reading the field back: every one of these was being accepted
    // as a product code. Two different shoes in the same size then shared an
    // identifier, and a shared identifier settles a comparison on its own.
    ['42.5', 'EU 41', 'US 10.5', 'UK 8', 'size 42.5', '27.5 cm'].forEach((size) => {
      expect(normaliseSku(size)).toBeUndefined();
    });
  });

  it('refuses a bare number that is not long enough to be a code', () => {
    expect(normaliseSku('2024')).toBeUndefined();
    expect(normaliseSku('425')).toBeUndefined();
  });

  it('accepts what a product code actually looks like', () => {
    expect(normaliseSku('XJ-204')).toBe('XJ204');
    expect(normaliseSku('376094-01')).toBe('37609401');
    expect(normaliseSku('AH2430 102')).toBe('AH2430102');
  });

  it('reads a size out of however it was written', () => {
    expect(normaliseSize('EU 39')).toBe('39');
    expect(normaliseSize('39.0')).toBe('39');
    expect(normaliseSize('size: 39')).toBe('39');
  });
});

describe('parseAttributes', () => {
  it('keeps only what the photograph actually showed', () => {
    const attributes = parseAttributes({
      category: 'footwear',
      type: 'ankle_boot',
      colour: 'black',
      heelType: 'unknown',
      toeShape: 'square',
      sku: 'unknown',
    });

    expect(attributes.category).toBe('FOOTWEAR');
    expect(attributes.toeShape).toBe('square');
    expect('heelType' in attributes).toBe(false);
    expect('sku' in attributes).toBe(false);
  });

  it('accepts the several names a model gives one field', () => {
    expect(parseAttributes({ color: 'black' }).colour).toBe('black');
    expect(parseAttributes({ heel: 'block' }).heelType).toBe('block');
    expect(parseAttributes({ modelNumber: 'XJ-204' }).sku).toBe('XJ204');
  });

  it('reads distinctive details as a list, however they arrive', () => {
    expect(parseAttributes({ details: 'metal buckle, white sole' }).details)
      .toEqual(['metal buckle', 'white sole']);
    expect(parseAttributes({ distinctiveDetails: ['metal buckle'] }).details)
      .toEqual(['metal buckle']);
  });
});

describe('attributeAgreement — a fuller phrase is not a disagreement', () => {
  it('agrees when one reading says more than the other', () => {
    expect(attributeAgreement('heelType', 'block heel 7cm', 'block')).toBe('agree');
  });

  it('folds the words that mean the same construction', () => {
    expect(attributeAgreement('heelType', 'chunky', 'block')).toBe('agree');
    expect(attributeAgreement('toeShape', 'pointy', 'pointed')).toBe('agree');
    expect(attributeAgreement('closure', 'side zip', 'zipper')).toBe('agree');
  });

  it('does NOT fold two constructions that are genuinely different', () => {
    expect(attributeAgreement('heelType', 'thin', 'stiletto')).toBe('conflict');
    expect(attributeAgreement('heelType', 'block', 'stiletto')).toBe('conflict');
    expect(attributeAgreement('toeShape', 'square', 'pointed')).toBe('conflict');
  });

  it('says nothing when either side did not see it', () => {
    expect(attributeAgreement('heelType', undefined, 'block')).toBe('unknown');
    expect(attributeAgreement('heelType', 'block', undefined)).toBe('unknown');
  });
});

describe('the dominant colour', () => {
  /**
   * The pair that forced this rule, off a real review screen: a top-down
   * photograph reading "white black gray" and a front-on one reading "black
   * white", grouped as one product. Different angles, so the angle rule had
   * nothing to say, and the two colour SETS intersect in every colour they
   * name — so the old set-overlap test allowed it.
   *
   * They are a mostly-white trainer and a mostly-black one.
   */
  it('reads the first colour as the one the item mostly is', () => {
    expect(dominantColour('white black gray')).toBe('white');
    expect(dominantColour('black white')).toBe('black');
    expect(dominantColour('jet black')).toBe('black');
    expect(dominantColour('multicolour')).toBeUndefined();
  });

  it('refuses a mostly-white item and a mostly-black one', () => {
    expect(colourAllows('white black gray', 'black white')).toBe(false);
  });

  it('is not fooled by two items sharing every colour they name', () => {
    // Same three colours on both, in a different order. Two colourways.
    expect(colourAllows('black white grey', 'white grey black')).toBe(false);
  });

  it('still allows one angle seeing fewer colours than another', () => {
    expect(colourAllows('grey white black', 'grey')).toBe(true);
    expect(colourAllows('olive green black', 'olive green')).toBe(true);
  });

  it('still allows the same colour described loosely', () => {
    expect(colourAllows('charcoal white', 'black white')).toBe(true);
    expect(colourAllows('gray white black', 'grey white black')).toBe(true);
  });

  it('splits two trainers whose dominant colour differs', () => {
    const trainer = (colour: string): ImageAttributes => ({
      category: 'FOOTWEAR', type: 'sneaker', colour,
      material: 'mesh', heelType: 'flat', toeShape: 'round',
      soleType: 'rubber', closure: 'laces', brand: 'puma',
    });

    const verdict = compare(trainer('white black gray'), trainer('black white'));
    expect(verdict.verdict).toBe('different');
    expect(verdict.decisive).toBe('colour');
  });

  it('splits a sole photograph whose sole heel is the wrong colour', () => {
    // Off the review screen: an olive trainer's two side views, and with them
    // a sole photograph whose heel end is WHITE while the sides plainly show a
    // BLACK heel. A different shoe, and the only field that says so is the
    // colour of the heel end of the sole.
    //
    // A side view sees both the upper's heel and the sole's heel end; a sole
    // view sees only the latter. Splitting them into two fields is what makes
    // the comparison possible at all — one field called "heel" meant the
    // upper from one angle and the sole from the other.
    const side: ImageAttributes = {
      category: 'FOOTWEAR', type: 'sneaker', colour: 'olive black',
      material: 'mesh', heelType: 'flat', soleType: 'rubber', closure: 'laces',
      brand: 'puma', heelColour: 'black', soleHeelColour: 'black',
      logoPlacement: 'side panel',
    };
    const strayLooking: ImageAttributes = {
      category: 'FOOTWEAR', type: 'sneaker', colour: 'olive black white',
      soleType: 'rubber', soleColour: 'black white',
      // No upper visible from underneath, so no opinion about its heel.
      soleHeelColour: 'white',
    };

    const verdict = compare(side, strayLooking);
    expect(verdict.conflicts.join(' ')).toContain('soleHeelColour');
    expect(verdict.verdict).not.toBe('same');
  });

  it('keeps the upper heel and the sole heel as separate questions', () => {
    // One shoe: black upper heel sitting on a white sole heel. Two different
    // parts, two different colours, and no conflict between them.
    const side: ImageAttributes = {
      category: 'FOOTWEAR', type: 'sneaker', colour: 'olive black white',
      heelColour: 'black', soleHeelColour: 'white', soleType: 'rubber',
    };
    const underneath: ImageAttributes = {
      category: 'FOOTWEAR', type: 'sneaker', colour: 'olive black white',
      soleHeelColour: 'white', soleType: 'rubber',
    };
    expect(compare(side, underneath).structuralConflicts).toBe(0);
  });

  it('splits two black trainers whose heel counters are different colours', () => {
    // The other pair from the same screen: same angles allowed, same dominant
    // colour, and the heel counter is white on one and black on the other.
    const trainer = (over: Partial<ImageAttributes>): ImageAttributes => ({
      category: 'FOOTWEAR', type: 'sneaker', colour: 'black white',
      material: 'mesh', heelType: 'flat', toeShape: 'round',
      soleType: 'rubber', closure: 'laces', brand: 'puma',
      soleColour: 'white', logoPlacement: 'side panel',
      ...over,
    });

    // The heel counter is structural and the logo colour is not, so this comes
    // out UNCERTAIN rather than DIFFERENT — one disagreeing physical fact is
    // honestly ambiguous between two finished candidates.
    //
    // Uncertain is enough to keep them apart everywhere it matters: the identity
    // join merges only on `same`, and a photograph is refused entry to a group
    // being built on a single structural conflict. What it no longer does is
    // claim more certainty than one field can carry.
    const verdict = compare(
      trainer({ heelColour: 'white', logoColour: 'white' }),
      trainer({ heelColour: 'black', logoColour: 'black' })
    );
    expect(verdict.verdict).not.toBe('same');
    expect(verdict.structuralConflicts).toBeGreaterThan(0);
  });
});

describe('compare — false merging', () => {
  it('keeps two black leather boots apart on heel, toe and sole', () => {
    const verdict = compare(productA(), productB());
    expect(verdict.verdict).toBe('different');
    expect(verdict.decisive).toBe('structure');
  });

  it('keeps two colourways of one silhouette apart', () => {
    const verdict = compare(productA(), productA({ colour: 'olive green' }));
    expect(verdict.verdict).toBe('different');
    expect(verdict.decisive).toBe('colour');
  });

  it('keeps two categories apart whatever else agrees', () => {
    const verdict = compare(productA(), productA({ category: 'TOP' }));
    expect(verdict.verdict).toBe('different');
    expect(verdict.decisive).toBe('category');
  });

  it('keeps two named brands apart', () => {
    const verdict = compare(productA({ brand: 'alpha' }), productA({ brand: 'omega' }));
    expect(verdict.verdict).toBe('different');
    expect(verdict.decisive).toBe('brand');
  });

  it('lets a pile of small disagreements add up to a different product', () => {
    // A knit trainer and a mesh one, both black and white, both flat, round,
    // rubber-soled and laced. Nothing structural disagrees. Four judgements
    // do, and until they were allowed to accumulate the two sat in one group:
    // each disagreement was individually forgivable and nothing counted them.
    const knit: ImageAttributes = {
      category: 'FOOTWEAR', type: 'sneaker', colour: 'black white',
      heelType: 'flat', toeShape: 'round', soleType: 'rubber', closure: 'laces',
      material: 'knit', pattern: 'ribbed knit', texture: 'knitted', finish: 'matte',
    };
    const mesh: ImageAttributes = {
      ...knit,
      material: 'mesh', pattern: 'elongated perforated mesh',
      texture: 'woven', finish: 'sheen',
    };

    const verdict = compare(knit, mesh);
    expect(verdict.structuralConflicts).toBe(0);
    expect(verdict.verdict).toBe('different');
    expect(verdict.decisive).toBe('accumulated difference');
  });

  it('still forgives one or two of them', () => {
    const shoe: ImageAttributes = {
      category: 'FOOTWEAR', type: 'sneaker', colour: 'black white',
      heelType: 'flat', toeShape: 'round', soleType: 'rubber', closure: 'laces',
      material: 'mesh', pattern: 'perforated', texture: 'woven',
    };
    // One angle calls the finish matte and the other calls it sheen, and one
    // reads the pattern differently. Two judgements, one shoe.
    expect(compare(shoe, { ...shoe, pattern: 'knitted' }).verdict).not.toBe('different');
    expect(
      compare(shoe, { ...shoe, pattern: 'knitted', texture: 'smooth' }).verdict
    ).not.toBe('different');
  });

  it('refuses to call "black footwear" enough evidence on its own', () => {
    const bare: ImageAttributes = { category: 'FOOTWEAR', colour: 'black' };
    expect(compare(bare, bare).verdict).toBe('uncertain');
  });

  it('refuses a perfect match made entirely of generic description', () => {
    // Category, type, colour and material agree completely, and half a
    // footwear catalogue would agree with them. Nothing here identifies an
    // item, so the honest verdict is that nobody can tell yet.
    const generic: ImageAttributes = {
      category: 'FOOTWEAR', type: 'ankle boot', colour: 'black', material: 'leather',
    };
    const verdict = compare(generic, { ...generic });
    expect(verdict.score).toBe(1);
    expect(verdict.verdict).toBe('uncertain');
    expect(verdict.decisive).toBe('generic');
  });

  it('does not call one shared structural fact identification either', () => {
    // "Black leather ankle boot with a zip" still describes a great many
    // boots. This is the reading a top-down photograph gives, and treating it
    // as a match merged a stiletto-heeled boot into a block-heeled one.
    const generic: ImageAttributes = {
      category: 'FOOTWEAR', type: 'ankle boot', colour: 'black', material: 'leather',
    };
    expect(compare(
      { ...generic, closure: 'zipper' },
      { ...generic, closure: 'zipper' }
    ).verdict).toBe('uncertain');
  });

  it('accepts a match on two structural facts, or on one identifying mark', () => {
    const generic: ImageAttributes = {
      category: 'FOOTWEAR', type: 'ankle boot', colour: 'black', material: 'leather',
    };

    expect(compare(
      { ...generic, heelType: 'block', closure: 'zipper' },
      { ...generic, heelType: 'block', closure: 'zipper' }
    ).verdict).toBe('same');

    expect(compare(
      { ...generic, details: ['gold buckle at ankle'] },
      { ...generic, details: ['gold buckle at ankle'] }
    ).verdict).toBe('same');

    expect(compare(
      { ...generic, logo: 'embossed crest on heel counter' },
      { ...generic, logo: 'embossed crest on heel counter' }
    ).verdict).toBe('same');
  });

  it('will not let a pile of soft agreement out-vote the structure', () => {
    const verdict = compare(
      productA({ texture: 'smooth', finish: 'matte', stitching: 'contrast', pattern: 'plain' }),
      productB({ texture: 'smooth', finish: 'matte', stitching: 'contrast', pattern: 'plain' })
    );
    expect(verdict.verdict).toBe('different');
  });
});

describe('compare — false splitting', () => {
  it('joins two angles that agree on everything both could see', () => {
    // A front view: toe, colour, material, type, and a detail it can see.
    const front: ImageAttributes = {
      category: 'FOOTWEAR', type: 'ankle boot', colour: 'black',
      material: 'leather', toeShape: 'square', details: ['contrast white outsole'],
    };
    // A profile: heel, sole, shaft — no toe — and the same detail from its side.
    const profile: ImageAttributes = {
      category: 'FOOTWEAR', type: 'ankle boot', colour: 'black',
      material: 'leather', heelType: 'block', soleThickness: 'thick', shaftHeight: 'ankle',
      details: ['contrast white outsole'],
    };

    expect(compare(front, profile).verdict).toBe('same');
  });

  it('treats a missing attribute as silence, not as a mismatch', () => {
    const full = productA();
    const partial: ImageAttributes = {
      category: 'FOOTWEAR', type: 'ankle boot', colour: 'black',
      material: 'leather', closure: 'zipper', heelType: 'block',
    };
    // The toe and the sole are unknown on one side and must not count against
    // it: what the two DO share is enough on its own.
    expect(compare(full, partial).verdict).toBe('same');
  });

  it('is unmoved by a size the other photograph did not show', () => {
    expect(compare(productA({ size: '39' }), productA()).verdict).toBe('same');
  });

  it('does not split the same model in two sizes', () => {
    expect(compare(productA({ size: '39' }), productA({ size: '41' })).verdict).toBe('same');
  });

  it('reads the same colour described loosely as the same colour', () => {
    expect(compare(productA({ colour: 'jet black' }), productA({ colour: 'black' })).verdict)
      .toBe('same');
  });
});

describe('compare — the colour of each part', () => {
  /**
   * The rule this implements, as the person who owns the folder states it:
   * same colour, same heel colour, same logo, same laces, same colours — then
   * it is the same boot. And, read the other way round, a different sole
   * colour or a different lace colour is a different boot however alike the
   * rest is.
   *
   * Everything in this block is two black PUMA trainers, which is what the
   * real folder is made of. Nothing else in the reading separates them.
   */
  const trainer = (over: Partial<ImageAttributes> = {}): ImageAttributes => ({
    category: 'FOOTWEAR',
    type: 'sneaker',
    colour: 'black',
    material: 'mesh',
    heelType: 'flat',
    toeShape: 'round',
    soleType: 'rubber',
    closure: 'laces',
    brand: 'puma',
    soleColour: 'white',
    heelColour: 'black',
    laceColour: 'black',
    logoColour: 'white',
    logoPlacement: 'side panel',
    ...over,
  });

  it('calls two trainers the same when every part matches', () => {
    expect(compare(trainer(), trainer()).verdict).toBe('same');
  });

  it('separates two black trainers whose soles are different colours', () => {
    const verdict = compare(trainer(), trainer({ soleColour: 'gum', laceColour: 'brown' }));
    expect(verdict.verdict).toBe('different');
    expect(verdict.decisive).toBe('structure');
  });

  it('does not separate them on the logo alone when the logo also moved', () => {
    // This asserted the opposite, and a folder of a hundred and ten trainers
    // showed why it cannot.
    //
    // A trainer carries its logo on the side panel AND the heel counter AND the
    // tongue. A profile reports one, a rear view reports another, and both are
    // correct about the SAME shoe — so "the logo moved" is a fact about where
    // the camera stood. Taken as identity it split nearly every product in that
    // folder, and the two readings it split were both true.
    //
    // The logo still counts towards agreement and its colour still counts as a
    // soft conflict. It can no longer decide on its own.
    const verdict = compare(
      trainer(),
      trainer({ logoColour: 'red', logoPlacement: 'heel counter' })
    );
    expect(verdict.verdict).not.toBe('different');
  });

  it('reads a part colour by family, so lighting cannot split a product', () => {
    // The same white sole, photographed twice.
    expect(compare(trainer(), trainer({ soleColour: 'off-white' })).verdict).toBe('same');
    // The same black heel counter, described two ways.
    expect(compare(trainer(), trainer({ heelColour: 'charcoal' })).verdict).toBe('same');
  });

  it('does not split on a part the other photograph could not see', () => {
    const sole: ImageAttributes = {
      category: 'FOOTWEAR', type: 'sneaker', colour: 'black', soleColour: 'white',
      soleType: 'rubber',
    };
    expect(compare(trainer(), sole).verdict).toBe('same');
  });

  it('separates two grey trainers lined in different colours', () => {
    // Straight off a real review screen: three photographs in one group, and
    // the third was a different shoe. Same brand, same grey and white upper,
    // same white sole, same logo in the same place — and lined in black
    // instead of white. Nothing in the reading objected, because nothing in
    // the reading looked inside the shoe.
    const grey = (over: Partial<ImageAttributes> = {}): ImageAttributes => ({
      category: 'FOOTWEAR',
      type: 'sneaker',
      colour: 'grey white black',
      material: 'mesh',
      heelType: 'flat',
      toeShape: 'round',
      soleType: 'rubber',
      closure: 'laces',
      brand: 'puma',
      soleColour: 'white',
      logoColour: 'white',
      logoPlacement: 'side panel',
      liningColour: 'white',
      collarColour: 'white',
      ...over,
    });

    expect(compare(grey(), grey()).verdict).toBe('same');

    const blackLined = grey({ liningColour: 'black', collarColour: 'black' });
    expect(compare(grey(), blackLined).verdict).toBe('different');
  });

  it('never counts a part the other photograph could not see against it', () => {
    const outside: ImageAttributes = {
      category: 'FOOTWEAR', type: 'sneaker', colour: 'grey white',
      soleColour: 'white', logoColour: 'white', logoPlacement: 'side panel',
    };
    const inside: ImageAttributes = {
      category: 'FOOTWEAR', type: 'sneaker', colour: 'grey white',
      soleColour: 'white', liningColour: 'white', collarColour: 'white',
    };

    // The lining is unknown on one side and the logo on the other. Neither is
    // a disagreement, so nothing here can split them.
    const verdict = compare(outside, inside);
    expect(verdict.verdict).not.toBe('different');
    expect(verdict.structuralConflicts).toBe(0);

    // They share one part colour, which is thin — two photographs agreeing
    // only that the sole is white have not identified a product. One more
    // shared part settles it.
    expect(verdict.verdict).toBe('uncertain');
    expect(
      compare({ ...outside, collarColour: 'white' }, inside).verdict
    ).toBe('same');
  });

  it('gives a part colour of "none" its own meaning', () => {
    // A slip-on has no laces. That is a fact about it, not a gap in the
    // photograph, and it separates it from the laced version of the same shoe.
    const laced = trainer({ laceColour: 'white' });
    const slipOn = trainer({ laceColour: 'none', closure: 'slipon' });
    expect(compare(laced, slipOn).verdict).toBe('different');
  });
});

describe('compare — identifiers', () => {
  it('settles it when two photographs show the same code', () => {
    const left: ImageAttributes = { sku: 'XJ204' };
    const right: ImageAttributes = { sku: 'xj-204', colour: 'black' };
    const verdict = compare(left, right);
    expect(verdict.verdict).toBe('same');
    expect(verdict.decisive).toBe('sku');
  });

  it('settles it the other way when the codes differ', () => {
    const verdict = compare(productA({ sku: 'XJ204' }), productA({ sku: 'XJ205' }));
    expect(verdict.verdict).toBe('different');
    expect(verdict.decisive).toBe('sku');
  });

  it('never reads a missing code as a contradicting one', () => {
    const verdict = compare(productA({ sku: 'XJ204' }), productA());
    expect(verdict.verdict).toBe('same');
    expect(verdict.decisive).not.toBe('sku');
  });
});

describe('compare — the honestly undecided', () => {
  it('says uncertain when one structural fact disagrees and nothing else does', () => {
    const verdict = compare(productA(), productA({ heelType: 'wedge' }));
    expect(verdict.verdict).toBe('uncertain');
  });

  it('says uncertain when neither photograph saw enough', () => {
    expect(compare({ colour: 'black' }, { material: 'leather' }).verdict).toBe('uncertain');
  });
});

describe('detailsAgree — the same feature, worded two ways', () => {
  it('matches two descriptions of one feature', () => {
    expect(detailsAgree(
      'white outsole with hexagonal tread',
      'hexagonal tread on the white midsole'
    )).toBe(true);
  });

  it('folds outsole and midsole, which name the same piece of rubber', () => {
    expect([...detailWords('white outsole')]).toEqual(['white', 'sole']);
    expect([...detailWords('white midsole')]).toEqual(['white', 'sole']);
  });

  it('does not match two features that merely share a word', () => {
    expect(detailsAgree('white outsole', 'white laces')).toBe(false);
  });

  it('ignores the words that carry no meaning', () => {
    expect(detailsAgree('a stripe on the side', 'the buckle at the side')).toBe(false);
  });
});

describe('buildVocabulary — distinctive means distinctive HERE', () => {
  /** A folder where everything is a black PUMA trainer. */
  const folder = Array.from({ length: 20 }, (_, i) => ({
    category: 'FOOTWEAR' as const,
    type: 'sneaker',
    colour: 'black white',
    brand: 'puma',
    heelType: 'flat',
    toeShape: 'round',
    soleType: 'rubber',
    closure: 'laces',
    // Two trainers in twenty carry each tread.
    details: [`white sole with ${['hexagonal', 'chevron'][i % 2 === 0 ? 0 : 1]} tread`],
  }));

  const vocabulary = buildVocabulary(folder);

  it('knows a brand the whole folder shares says nothing', () => {
    expect(vocabulary.share('brand', 'puma')).toBe(1);
    expect(vocabulary.share('heelType', 'flat')).toBe(1);
    expect(vocabulary.share('closure', 'laces')).toBe(1);
  });

  it('knows a value nothing else uses says a great deal', () => {
    expect(vocabulary.share('heelType', 'stiletto')).toBe(0);
  });

  it('reads a phrase by its RAREST word, not its commonest', () => {
    const mixed = buildVocabulary([
      { soleType: 'rubber lug' },
      { soleType: 'rubber' },
      { soleType: 'rubber' },
      { soleType: 'rubber' },
    ]);
    // "rubber" is the whole folder; "lug" is a quarter of it, and "rubber lug"
    // is distinctive because of the lug.
    expect(mixed.share('soleType', 'rubber')).toBe(1);
    expect(mixed.share('soleType', 'rubber lug')).toBe(0.25);
  });

  it('scores a word most of the folder uses in its details as common', () => {
    expect(vocabulary.wordShare('sole')).toBe(1);
    expect(vocabulary.wordShare('hexagonal')).toBeLessThan(1);
  });

  it('refuses to identify two items on what the whole folder shares', () => {
    // Two DIFFERENT trainers: same brand, same heel, same toe, same sole, same
    // closure, and tread patterns that share only the words everything shares.
    const left = { ...folder[0] };
    const right = { ...folder[1] };

    expect(compare(left, right).verdict).toBe('same');
    expect(compare(left, right, vocabulary).verdict).toBe('uncertain');
    expect(compare(left, right, vocabulary).decisive).toBe('generic');
  });

  it('still identifies two photographs that share a rare word', () => {
    const left = { ...folder[0] };
    const right = { ...folder[2] };

    // Both carry "hexagonal", which only a tenth of the folder does.
    expect(compare(left, right, vocabulary).verdict).toBe('same');
  });
});

describe('aggregateFingerprint', () => {
  const front: ImageAttributes = {
    category: 'FOOTWEAR', type: 'ankle boot', colour: 'black',
    material: 'leather', toeShape: 'square', details: ['metal buckle'],
  };
  const profile: ImageAttributes = {
    category: 'FOOTWEAR', type: 'ankle boot', colour: 'black',
    heelType: 'block', heelHeight: '7cm', shaftHeight: 'ankle', details: ['stitched upper'],
  };
  const label: ImageAttributes = { sku: 'XJ-204', size: '39' };

  it('builds one identity out of what several angles each saw', () => {
    const fingerprint = aggregateFingerprint([front, profile, label]);

    expect(fingerprint.toeShape).toBe('square');
    expect(fingerprint.heelType).toBe('block');
    expect(fingerprint.heelHeight).toBe('7cm');
    expect(fingerprint.sku).toBe('XJ204');
    expect(fingerprint.sizes).toEqual(['39']);
    expect(fingerprint.imageCount).toBe(3);
  });

  it('accumulates the distinctive details rather than voting on them', () => {
    const fingerprint = aggregateFingerprint([front, profile]);
    expect(fingerprint.details?.sort()).toEqual(['metal buckle', 'stitched upper']);
  });

  it('accumulates every size, because one model may have several', () => {
    const fingerprint = aggregateFingerprint([label, { size: '41' }]);
    expect(fingerprint.sizes.sort()).toEqual(['39', '41']);
    expect(fingerprint.internalConflicts).toEqual([]);
  });

  it('takes the majority reading and records the dissent', () => {
    const fingerprint = aggregateFingerprint([
      { heelType: 'block' },
      { heelType: 'block' },
      { heelType: 'stiletto' },
    ]);
    expect(fingerprint.heelType).toBe('block');
    expect(fingerprint.support.heelType).toBe(2);
    expect(fingerprint.internalConflicts).toHaveLength(1);
  });

  it('does not call a fuller phrase a disagreement', () => {
    const fingerprint = aggregateFingerprint([
      { heelType: 'block' },
      { heelType: 'block heel 7cm' },
    ]);
    expect(fingerprint.internalConflicts).toEqual([]);
  });

  it('flags two different codes inside one candidate product', () => {
    const fingerprint = aggregateFingerprint([{ sku: 'XJ204' }, { sku: 'XJ205' }]);
    expect(fingerprint.skus).toEqual(['XJ204', 'XJ205']);
    expect(fingerprint.internalConflicts.join(' ')).toContain('sku');
  });

  it('has nothing to say about no photographs', () => {
    const fingerprint = aggregateFingerprint([]);
    expect(fingerprint.imageCount).toBe(0);
    expect(fingerprint.skus).toEqual([]);
  });

  it('lets a folded fingerprint answer for the angles that built it', () => {
    // The point of aggregating: the label shot alone knows nothing about a
    // boot, but folded into the product it makes the code available to every
    // later comparison.
    const fingerprint = aggregateFingerprint([front, profile, label]);
    expect(compare(fingerprint, { sku: 'XJ204' }).verdict).toBe('same');
  });
});

describe('confidenceOf', () => {
  const fingerprint = aggregateFingerprint([
    { category: 'FOOTWEAR', type: 'ankle boot', colour: 'black', material: 'leather',
      heelType: 'block', toeShape: 'square', closure: 'zipper', details: ['metal buckle', 'white sole'] },
    { category: 'FOOTWEAR', type: 'ankle boot', colour: 'black', material: 'leather',
      soleType: 'rubber', shaftHeight: 'ankle' },
  ]);

  it('rewards photographs that agree with each other', () => {
    const high = confidenceOf({ fingerprint, agreed: 6, uncertain: 0, contradicted: 0, fallbackPlacements: 0 });
    const low = confidenceOf({ fingerprint, agreed: 1, uncertain: 5, contradicted: 0, fallbackPlacements: 0 });
    expect(high).toBeGreaterThan(low);
  });

  it('punishes a photograph the evidence says does not belong', () => {
    const clean = confidenceOf({ fingerprint, agreed: 6, uncertain: 0, contradicted: 0, fallbackPlacements: 0 });
    const dirty = confidenceOf({ fingerprint, agreed: 6, uncertain: 0, contradicted: 3, fallbackPlacements: 0 });
    expect(dirty).toBeLessThan(clean);
  });

  it('punishes a photograph that was placed rather than identified', () => {
    const clean = confidenceOf({ fingerprint, agreed: 6, uncertain: 0, contradicted: 0, fallbackPlacements: 0 });
    const guessed = confidenceOf({ fingerprint, agreed: 6, uncertain: 0, contradicted: 0, fallbackPlacements: 2 });
    expect(guessed).toBeLessThan(clean);
  });

  it('rewards a legible product code', () => {
    const withCode = aggregateFingerprint([{ colour: 'black', sku: 'XJ204' }]);
    const without = aggregateFingerprint([{ colour: 'black' }]);
    expect(
      confidenceOf({ fingerprint: withCode, agreed: 1, uncertain: 0, contradicted: 0, fallbackPlacements: 0 })
    ).toBeGreaterThan(
      confidenceOf({ fingerprint: without, agreed: 1, uncertain: 0, contradicted: 0, fallbackPlacements: 0 })
    );
  });

  it('punishes a group whose own photographs contradict each other', () => {
    const conflicted = aggregateFingerprint([
      { colour: 'black', heelType: 'block', toeShape: 'square' },
      { colour: 'black', heelType: 'stiletto', toeShape: 'square' },
    ]);
    expect(conflicted.internalConflicts).toHaveLength(1);
    expect(
      confidenceOf({ fingerprint: conflicted, agreed: 0, uncertain: 1, contradicted: 0, fallbackPlacements: 0 })
    ).toBeLessThan(0.7);
  });

  it('never claims certainty, however good the evidence', () => {
    const perfect = confidenceOf({
      fingerprint: aggregateFingerprint([
        { category: 'FOOTWEAR', type: 'ankle boot', colour: 'black', material: 'leather',
          heelType: 'block', toeShape: 'square', soleType: 'rubber', shaftHeight: 'ankle',
          closure: 'zipper', logo: 'crest', brand: 'alpha', sku: 'XJ204',
          details: ['metal buckle', 'white sole'] },
      ]),
      agreed: 99, uncertain: 0, contradicted: 0, fallbackPlacements: 0,
    });
    expect(perfect).toBeLessThan(1);
    expect(perfect).toBeGreaterThan(0.8);
  });

  it('stays inside 0..1 whatever it is handed', () => {
    const awful = confidenceOf({
      fingerprint: aggregateFingerprint([
        { heelType: 'block' }, { heelType: 'stiletto' }, { heelType: 'wedge' },
      ]),
      agreed: 0, uncertain: 0, contradicted: 9, fallbackPlacements: 9,
    });
    expect(awful).toBeGreaterThanOrEqual(0);
    expect(awful).toBeLessThanOrEqual(1);
  });
});

describe('describeFingerprint', () => {
  it('reads as the sentence the review screen shows', () => {
    const fingerprint = aggregateFingerprint([
      { colour: 'black', material: 'leather', type: 'ankle boot',
        heelType: 'block', toeShape: 'square', closure: 'side zipper' },
    ]);
    expect(describeFingerprint(fingerprint)).toBe(
      'black leather ankle boot — block heel · square toe · side zipper'
    );
  });

  it('says only what is known', () => {
    expect(describeFingerprint(aggregateFingerprint([{ colour: 'black' }]))).toBe('black');
    expect(describeFingerprint(aggregateFingerprint([]))).toBe('');
  });
});
