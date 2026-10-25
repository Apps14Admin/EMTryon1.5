/**
 * PRODUCT IDENTITY, as opposed to image similarity.
 *
 * Two photographs of one boot — one from the front, one of the sole — share
 * almost no pixels. Two photographs of two different black leather boots share
 * a great many. So the question this file answers is never "do these look
 * alike"; it is "are these the same physical item", and it answers it from a
 * structured reading of what each photograph shows rather than from the
 * photograph itself.
 *
 * Three things live here and nothing else:
 *
 *   1. ImageAttributes — one photograph's reading, every field optional
 *      because a field that is not visible from that angle is UNKNOWN, and
 *      unknown is never evidence of anything.
 *   2. ProductFingerprint — the readings of every photograph of one candidate
 *      product, folded together. The front photograph contributes the toe, the
 *      profile contributes the heel, the label photograph contributes the SKU,
 *      and the fingerprint holds all three.
 *   3. compare() — two fingerprints in, a verdict out, weighted so that a
 *      distinctive structural feature outweighs "black" by a wide margin.
 *
 * The rule that governs the whole file, and the one that is easiest to get
 * wrong:
 *
 *     UNKNOWN IS NOT A MISMATCH.
 *
 * A signal counts only where BOTH sides know it. A photograph that cannot see
 * the heel neither agrees nor disagrees about the heel, and the arithmetic
 * must not let it drag a score down — otherwise every close-up in the folder
 * becomes its own product.
 */

export type Category = 'FOOTWEAR' | 'TOP' | 'BOTTOMS' | 'OTHER';

export const CATEGORIES: Category[] = ['FOOTWEAR', 'TOP', 'BOTTOMS', 'OTHER'];

// --- colour ---------------------------------------------------------------

/**
 * Colour words folded into the families that actually separate products.
 * Lighting moves a colour within its family, never across one: a grey shoe
 * never photographs olive.
 */
const COLOUR_FAMILIES: Record<string, string> = {
  black: 'black', jet: 'black', charcoal: 'black', graphite: 'black',
  grey: 'grey', gray: 'grey', silver: 'grey', ash: 'grey', slate: 'grey', stone: 'grey',
  white: 'white', cream: 'white', ivory: 'white', offwhite: 'white', bone: 'white', chalk: 'white',
  olive: 'green', green: 'green', khaki: 'green', sage: 'green', mint: 'green', lime: 'green',
  blue: 'blue', navy: 'blue', teal: 'blue', cyan: 'blue', denim: 'blue', cobalt: 'blue',
  red: 'red', crimson: 'red', burgundy: 'red', maroon: 'red', wine: 'red',
  brown: 'brown', tan: 'brown', beige: 'brown', camel: 'brown', taupe: 'brown', sand: 'brown', gum: 'brown',
  pink: 'pink', rose: 'pink', magenta: 'pink', fuchsia: 'pink',
  purple: 'purple', violet: 'purple', lilac: 'purple', lavender: 'purple',
  yellow: 'yellow', gold: 'yellow', mustard: 'yellow',
  orange: 'orange', coral: 'orange', rust: 'orange', peach: 'orange',
};

const COLOUR_NOISE = new Set([
  'light', 'dark', 'pale', 'deep', 'bright', 'muted', 'pastel', 'neon', 'metallic',
  'matte', 'gloss', 'glossy', 'shiny', 'and', 'with', 'the', 'a', 'multicolour',
  'multicolor', 'mixed', 'two', 'tone', 'twotone', 'accents', 'accent', 'trim',
]);

export const colourFamilies = (description?: string): Set<string> => {
  if (!description) return new Set();

  return new Set(
    description
      .toLowerCase()
      .split(/[^a-z]+/)
      .filter((word) => word && !COLOUR_NOISE.has(word))
      .map((word) => COLOUR_FAMILIES[word] ?? COLOUR_FAMILIES[word.replace(/s$/, '')])
      .filter((family): family is string => !!family)
  );
};

/**
 * The colour the item mostly IS.
 *
 * The reading is asked for its colours most dominant first, so the first
 * recognised colour word is the dominant one. A Set preserves insertion order,
 * which is what makes this a one-liner.
 */
export const dominantColour = (description?: string): string | undefined =>
  [...colourFamilies(description)][0];

/**
 * Whether two colour descriptions can be one product.
 *
 * The cheapest veto there is, because the colour arrives in the same answer as
 * everything else, and it catches the mistake that ruins a render — two
 * colourways of one silhouette treated as a single product. An unknown colour
 * vetoes nothing.
 *
 * THE DOMINANT COLOUR HAS TO MATCH, and set overlap is not enough. This was
 * the rule for a long time and it let through the pair that prompted writing
 * this paragraph: a mostly-white trainer with black laces read "white black
 * gray", a mostly-black trainer with a white sole read "black white", the two
 * sets intersect in every colour they name, and they are obviously two
 * different shoes. Sharing colours is not being the same colourway — a shoe
 * that is mostly white is not a shoe that is mostly black, whatever else both
 * of them have on them.
 *
 * The order is the model's answer to a question the prompt asks explicitly, so
 * this reads evidence rather than inventing it.
 */
export const colourAllows = (a?: string, b?: string): boolean => {
  const first = dominantColour(a);
  const second = dominantColour(b);
  if (!first || !second) return true;
  return first === second;
};

// --- one photograph's reading --------------------------------------------

/**
 * What one photograph shows, as far as it shows it.
 *
 * EVERY FIELD IS OPTIONAL, and that is the design rather than laziness. A
 * front-on photograph cannot see a sole; a sole photograph cannot see a toe
 * box; a photograph of the box shows a SKU and no product at all. Each of
 * those is a complete, honest reading with most fields absent, and the
 * fingerprint is what puts them back together.
 */
export interface ImageAttributes {
  // classification
  category?: Category;
  type?: string;
  subcategory?: string;
  gender?: string;

  // appearance
  colour?: string;
  secondaryColours?: string;
  material?: string;
  texture?: string;
  finish?: string;
  pattern?: string;
  silhouette?: string;

  // footwear construction
  heelType?: string;
  heelHeight?: string;
  soleType?: string;
  soleThickness?: string;
  toeShape?: string;
  shaftHeight?: string;
  closure?: string;
  straps?: string;
  stitching?: string;

  /**
   * THE COLOUR OF EACH PART, not of the item.
   *
   * The single most useful set of fields for footwear, and the one the first
   * three revisions of this did not have. Two black PUMA trainers are both
   * "black": same category, same type, same material, same flat heel, same
   * round toe, same rubber sole, same laces, same brand. What differs is the
   * colour of the SOLE, of the HEEL COUNTER, of the LACES, and the colour and
   * placement of the LOGO — and none of that was being asked for, so the
   * system was blind to the only thing that told them apart.
   *
   * They compare by colour FAMILY, like every other colour here, so "off-white"
   * and "white" are one answer and a change of lighting cannot split a product.
   */
  soleColour?: string;
  /**
   * The UPPER's heel — the back of the shoe above the sole. Not the sole.
   *
   * This field used to be described as "the heel or heel counter", and that is
   * two different parts seen from two different angles: from the side it is
   * the back of the upper, from underneath it is the heel block of the sole
   * unit. One shoe therefore answered "black" from the side and "white" from
   * below, and — worse — a sole photograph of one shoe agreed with a side
   * photograph of another. The two parts now have a field each.
   */
  heelColour?: string;
  /** The heel end of the SOLE unit, seen from underneath or from the side. */
  soleHeelColour?: string;
  laceColour?: string;
  logoColour?: string;
  logoPlacement?: string;

  /**
   * THE COLOUR OF THE INSIDE.
   *
   * Two grey trainers, same brand, same sole, same laces, same logo in the
   * same place — and one is lined in white and the other in black. From the
   * side, which is how a shoe is usually photographed, the lining and the
   * padded collar are plainly visible through the opening, and they are often
   * the ONLY thing that separates two colourways of one model.
   *
   * They were missing, so a black-lined trainer was landing in a white-lined
   * trainer's group with nothing in the reading to object.
   */
  liningColour?: string;
  collarColour?: string;
  tongueColour?: string;

  // marks and identifiers
  logo?: string;
  brand?: string;
  sku?: string;
  size?: string;

  /** Distinctive elements: "metal buckle", "embossed logo on heel counter". */
  details?: string[];
}

/** Every attribute key, in one place, so nothing is compared by accident. */
export const ATTRIBUTE_KEYS = [
  'category', 'type', 'subcategory', 'gender',
  'colour', 'secondaryColours', 'material', 'texture', 'finish', 'pattern', 'silhouette',
  'heelType', 'heelHeight', 'soleType', 'soleThickness', 'toeShape', 'shaftHeight',
  'closure', 'straps', 'stitching',
  'soleColour', 'heelColour', 'soleHeelColour', 'laceColour', 'logoColour', 'logoPlacement',
  'liningColour', 'collarColour', 'tongueColour',
  'logo', 'brand', 'sku', 'size',
] as const;

/**
 * Words the model uses to say "I cannot see that".
 *
 * Every one of these must become `undefined`, because the whole arithmetic
 * downstream depends on absent meaning absent. A literal "unknown" left in a
 * field would compare unequal to a real value and split a product in two.
 */
const NOT_VISIBLE = new Set([
  'unknown', 'unclear', 'n/a', 'na', 'null', 'nil', 'none visible', 'not visible',
  'not applicable', 'cannot tell', 'can not tell', "can't tell", 'indeterminate',
  'undetermined', 'not shown', 'obscured', 'hidden', 'unreadable', 'illegible',
  '-', '?', '',
]);

/** Trims a model's word to a comparable value, or drops it as unknown. */
export const normaliseAttribute = (value: unknown): string | undefined => {
  if (typeof value === 'number') return String(value);
  if (typeof value !== 'string') return undefined;

  const cleaned = value.trim().toLowerCase().replace(/[\s_]+/g, ' ').replace(/[.,;]+$/, '');
  if (!cleaned || NOT_VISIBLE.has(cleaned)) return undefined;
  return cleaned;
};

/**
 * A SKU, model number or product code, reduced to what can be matched.
 *
 * Case, spaces and separators vary between a printed label and a stamped
 * insole; the characters do not.
 *
 * WHAT IS REJECTED MATTERS FAR MORE THAN THE NORMALISATION, because a SKU is
 * the one decisive signal in the system — it settles a comparison in either
 * direction on its own — and a false one is unrecoverable.
 *
 * An earlier version asked only for three characters and one digit, and that
 * let SIZES through. "42.5" became the code "425"; "EU 41" became "EU41";
 * "US 10.5" became "US105". Two different shoes in the same size then carried
 * the same "code" and were merged as one product, decisively, on the strength
 * of a number that says nothing about which shoe it is. In a folder of one
 * shop's stock, most shoes share a handful of sizes.
 *
 * So a value has to LOOK like a product code:
 *
 *   - at least four characters, so no size and no shelf letter qualifies;
 *   - at least one digit, so a word the model misfiled ("BLACK", "LEATHER")
 *     cannot become an identifier;
 *   - letters AND digits together, or a run of five or more digits. "XJ-204"
 *     and "376094-01" are codes. "2024" is a year, "425" is a size, and
 *     neither is allowed to settle anything.
 *
 * The words a size is written with are refused outright, because "size 42.5"
 * survives the character tests and is not a code.
 */
const SIZE_WORDS = /\bsizes?\b|\beur?\b|\buk\b|\bus\b|\bcm\b|\bmm\b/;

export const normaliseSku = (value: unknown): string | undefined => {
  const base = normaliseAttribute(value);
  if (!base) return undefined;
  if (SIZE_WORDS.test(base)) return undefined;

  const stripped = base.replace(/[^a-z0-9]/g, '').toUpperCase();
  if (stripped.length < 4) return undefined;

  const digits = (stripped.match(/\d/g) ?? []).length;
  const letters = (stripped.match(/[A-Z]/g) ?? []).length;
  if (!digits) return undefined;
  if (!letters && digits < 5) return undefined;

  return stripped;
};

/** A size, reduced so "EU 39", "39", "39.0" and "size: 39" are one value. */
export const normaliseSize = (value: unknown): string | undefined => {
  const base = normaliseAttribute(value);
  if (!base) return undefined;
  const number = base.match(/\d+(?:[.,]5)?/);
  if (!number) return base.replace(/[^a-z0-9]/g, '') || undefined;
  return number[0].replace(',', '.').replace(/\.0$/, '');
};

export const asCategory = (value: unknown): Category | undefined => {
  const base = normaliseAttribute(value);
  if (!base) return undefined;
  const upper = base.toUpperCase();
  const direct = CATEGORIES.find((c) => c === upper);
  if (direct) return direct;
  if (/SHOE|SNEAKER|BOOT|FOOTWEAR|SANDAL|HEEL|LOAFER|TRAINER|PUMP/.test(upper)) return 'FOOTWEAR';
  if (/PANT|TROUSER|SHORT|BOTTOM|JEAN|SKIRT/.test(upper)) return 'BOTTOMS';
  if (/SHIRT|TEE|HOODIE|JACKET|TOP|SWEATER|COAT|BLOUSE/.test(upper)) return 'TOP';
  return undefined;
};

const asDetails = (value: unknown): string[] | undefined => {
  const list = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(/[;,]/)
      : [];

  const out = list
    .map((item) => normaliseAttribute(item))
    .filter((item): item is string => !!item && item.length >= 3);

  return out.length ? [...new Set(out)] : undefined;
};

/**
 * One photograph's answer, read out of the model's JSON object.
 *
 * Unrecognised keys are ignored and missing keys stay missing. Nothing here
 * infers a value from another value — a reading that says nothing about the
 * heel produces a reading that says nothing about the heel.
 */
export const parseAttributes = (record: Record<string, unknown>): ImageAttributes => {
  const pick = (...names: string[]): string | undefined => {
    for (const name of names) {
      const value = normaliseAttribute(record[name]);
      if (value) return value;
    }
    return undefined;
  };

  const attributes: ImageAttributes = {
    category: asCategory(record.category),
    type: pick('type', 'productType'),
    subcategory: pick('subcategory', 'subType'),
    gender: pick('gender'),

    colour: pick('colour', 'color', 'dominantColor', 'dominantColour'),
    secondaryColours: pick('secondaryColours', 'secondaryColors', 'secondaryColour', 'secondaryColor'),
    material: pick('material'),
    texture: pick('texture'),
    finish: pick('finish'),
    pattern: pick('pattern'),
    silhouette: pick('silhouette', 'shape'),

    heelType: pick('heelType', 'heel'),
    heelHeight: pick('heelHeight'),
    soleType: pick('soleType', 'sole'),
    soleThickness: pick('soleThickness'),
    toeShape: pick('toeShape', 'toe'),
    shaftHeight: pick('shaftHeight', 'shaft', 'bootHeight'),
    closure: pick('closure', 'fastening'),
    straps: pick('straps', 'strap'),
    stitching: pick('stitching'),

    soleColour: pick('soleColour', 'soleColor'),
    heelColour: pick('heelColour', 'heelColor', 'heelCounterColour', 'heelCounterColor'),
    soleHeelColour: pick('soleHeelColour', 'soleHeelColor'),
    laceColour: pick('laceColour', 'laceColor', 'lacesColour', 'lacesColor'),
    logoColour: pick('logoColour', 'logoColor'),
    logoPlacement: pick('logoPlacement', 'logoPosition'),

    liningColour: pick('liningColour', 'liningColor', 'innerColour', 'innerColor', 'insideColour', 'insideColor'),
    collarColour: pick('collarColour', 'collarColor', 'cuffColour', 'cuffColor'),
    tongueColour: pick('tongueColour', 'tongueColor'),

    logo: pick('logo', 'branding'),
    brand: pick('brand'),
    sku: normaliseSku(record.sku ?? record.modelNumber ?? record.productCode ?? record.code),
    size: normaliseSize(record.size),

    details: asDetails(record.details ?? record.distinctiveDetails ?? record.distinctive),
  };

  // Undefined keys are dropped rather than carried, so `Object.keys` on a
  // reading is exactly the list of things that photograph could actually see.
  (Object.keys(attributes) as (keyof ImageAttributes)[]).forEach((key) => {
    if (attributes[key] === undefined) delete attributes[key];
  });

  return attributes;
};

// --- comparing one attribute ---------------------------------------------

/** Words that describe the field rather than the value it holds. */
const FIELD_NOISE = new Set([
  'heel', 'sole', 'toe', 'shaft', 'shape', 'type', 'style', 'height', 'thickness',
  'with', 'and', 'a', 'an', 'the', 'of', 'is', 'has', 'looks', 'appears', 'visible',
  'colour', 'color', 'material', 'closure', 'finish', 'box', 'upper', 'approximately',
  'about', 'very', 'quite', 'fairly', 'somewhat', 'slightly', 'moderate', 'moderately',
]);

/**
 * Synonyms folded per field, for the fields whose disagreement actually splits
 * a product.
 *
 * Deliberately literal. "chunky" and "block" are the same heel and are folded;
 * "thin" and "stiletto" are NOT folded, because a thin heel that is not a
 * stiletto exists and inventing the equivalence would merge two products.
 */
const SYNONYMS: Record<string, Record<string, string>> = {
  heelType: {
    chunky: 'block', blocky: 'block', column: 'block',
    stilleto: 'stiletto', pin: 'stiletto', needle: 'stiletto', spike: 'stiletto',
    flatform: 'platform',
    tapered: 'cone', conical: 'cone',
    none: 'flat', flats: 'flat', noheel: 'flat',
  },
  toeShape: {
    rounded: 'round', oval: 'round',
    pointy: 'pointed', point: 'pointed', sharp: 'pointed',
    chisel: 'square', squared: 'square', rectangular: 'square',
    peep: 'open', peeptoe: 'open', opentoe: 'open',
  },
  soleType: {
    lugged: 'lug', treaded: 'lug', cleated: 'lug', tread: 'lug',
    crepesole: 'crepe',
    eva: 'foam', cushioned: 'foam',
    smooth: 'flat', plain: 'flat',
  },
  soleThickness: {
    chunky: 'thick', heavy: 'thick', substantial: 'thick', platformed: 'thick',
    slim: 'thin', slender: 'thin', fine: 'thin', low: 'thin',
    mid: 'medium',
  },
  closure: {
    zip: 'zipper', zipped: 'zipper', zippered: 'zipper', sidezip: 'zipper', backzip: 'zipper',
    lace: 'laces', laced: 'laces', laceup: 'laces',
    buckled: 'buckle', buckles: 'buckle',
    pullon: 'slipon', slip: 'slipon', pull: 'slipon', elasticated: 'elastic',
    none: 'slipon',
    hookandloop: 'velcro',
  },
  material: {
    leathers: 'leather', calfskin: 'leather', cowhide: 'leather',
    nubuck: 'suede',
    patentleather: 'patent',
    textile: 'fabric', cloth: 'fabric', woven: 'fabric',
    synthetics: 'synthetic', faux: 'synthetic', pu: 'synthetic', pleather: 'synthetic',
    knitted: 'knit',
  },
};

/** A value reduced to the set of words that carry its meaning. */
export const valueTokens = (field: string, value: string): Set<string> => {
  const fold = SYNONYMS[field] ?? {};

  const tokens = value
    .split(/[^a-z0-9]+/)
    .filter((token) => token && !FIELD_NOISE.has(token))
    .map((token) => fold[token] ?? fold[token.replace(/s$/, '')] ?? token);

  // A value that was ENTIRELY field noise ("heel shape") still has to say
  // something, or it silently becomes unknown at comparison time only — which
  // is worse than saying nothing, because the caller thinks it knows.
  return new Set(tokens.length ? tokens : [value.replace(/\s+/g, '')]);
};

export type Agreement = 'agree' | 'conflict' | 'unknown';

/**
 * Whether two readings of one field are the same reading.
 *
 * Overlap, not equality. "block heel, 7cm" and "block" describe one heel; a
 * profile photograph gives more of the phrase than a front one does, and
 * demanding the same phrase from both would split every product with a good
 * side shot.
 */
/** Fields whose value is a colour, and must be read as one. */
const COLOUR_FIELDS = new Set([
  'colour', 'secondaryColours', 'soleColour', 'heelColour', 'soleHeelColour',
  'laceColour', 'logoColour', 'liningColour', 'collarColour', 'tongueColour',
]);

/** "none", "no laces", "without a logo" — the part is absent, not unseen. */
const ABSENT_WORDS = new Set(['none', 'no', 'without', 'absent', 'bare', 'nothing']);

const namesNothing = (value: string): boolean =>
  value.split(/[^a-z]+/).some((word) => ABSENT_WORDS.has(word));

export const attributeAgreement = (
  field: string,
  a: string | undefined,
  b: string | undefined
): Agreement => {
  if (!a || !b) return 'unknown';
  if (a === b) return 'agree';

  // A colour is compared by FAMILY. "off-white" and "white" are one sole;
  // "charcoal" and "black" are one heel. Comparing those as words would split
  // a product on the lighting it was photographed in, which is the mistake
  // this whole file exists to avoid — and it would do it in the fields that
  // matter most, since a part's colour is often the only thing that separates
  // two items of the same model line.
  if (COLOUR_FIELDS.has(field)) {
    // "none" is an ANSWER, not a gap. A shoe with no laces has been looked at
    // and found to have none, and that separates it from the laced version of
    // the same shoe — which is exactly the kind of pair this has to catch.
    // Reading it as "not visible" made the difference invisible.
    const leftAbsent = namesNothing(a);
    const rightAbsent = namesNothing(b);
    if (leftAbsent || rightAbsent) return leftAbsent && rightAbsent ? 'agree' : 'conflict';

    const left = colourFamilies(a);
    const right = colourFamilies(b);
    // A description naming no colour at all ("two-tone", "multicolour") is not
    // a disagreement with anything.
    if (!left.size || !right.size) return 'unknown';
    return [...left].some((family) => right.has(family)) ? 'agree' : 'conflict';
  }

  const left = valueTokens(field, a);
  const right = valueTokens(field, b);
  for (const token of left) if (right.has(token)) return 'agree';
  return 'conflict';
};

// --- the weighting -------------------------------------------------------

/**
 * How strongly each field speaks, and what a disagreement in it means.
 *
 *   `structural` — a physical fact about how the item is built. Two of these
 *                  disagreeing is a different product, full stop: a block heel
 *                  is not a stiletto and no lighting makes it one.
 *   `strong`     — identity-bearing but readable wrong (product type).
 *   `soft`       — real evidence, individually survivable.
 *   `none`       — supporting only; a disagreement is noted, never acted on.
 *
 * Weights are the arithmetic; kinds are the vetoes. The two are separate
 * because a field can be worth a lot to a score and still not be allowed to
 * split a product on its own.
 */
export type VetoKind = 'structural' | 'strong' | 'soft' | 'none';

export interface Signal {
  key: keyof ImageAttributes;
  weight: number;
  veto: VetoKind;
}

export const SIGNALS: Signal[] = [
  { key: 'type', weight: 4, veto: 'strong' },
  { key: 'silhouette', weight: 3, veto: 'soft' },
  { key: 'subcategory', weight: 1, veto: 'none' },
  { key: 'gender', weight: 1, veto: 'none' },

  { key: 'heelType', weight: 4, veto: 'structural' },
  { key: 'toeShape', weight: 4, veto: 'structural' },
  { key: 'soleType', weight: 3, veto: 'structural' },
  { key: 'shaftHeight', weight: 3, veto: 'structural' },
  { key: 'closure', weight: 3, veto: 'structural' },
  { key: 'soleThickness', weight: 2, veto: 'soft' },
  { key: 'heelHeight', weight: 2, veto: 'soft' },
  { key: 'straps', weight: 2, veto: 'soft' },

  // The colour of each part.
  //
  // A FIELD MAY ONLY BE A STRUCTURAL VETO IF IT IS ANGLE-INVARIANT — if the
  // honest answer is the same whichever side the photograph was taken from.
  // That is the rule this list broke, and breaking it turned a folder of a
  // hundred and ten trainers into seventy-two products.
  //
  // These pass the test. One shoe has ONE sole colour, ONE lining, ONE set of
  // laces, and no angle or light turns a white sole black.
  { key: 'soleColour', weight: 3, veto: 'structural' },
  { key: 'heelColour', weight: 3, veto: 'structural' },
  { key: 'laceColour', weight: 2, veto: 'structural' },
  { key: 'liningColour', weight: 3, veto: 'structural' },
  { key: 'tongueColour', weight: 2, veto: 'structural' },

  // THESE DO NOT PASS IT, and each one was splitting real products.
  //
  // `logoPlacement` is the clearest case. A trainer carries its logo on the
  // side panel AND on the heel counter AND on the tongue. Which one a
  // photograph reports is decided by where the camera stood, so a profile
  // saying "side panel" and a rear view saying "heel counter" are two correct
  // readings of ONE shoe. As a structural veto it split those two apart on
  // every product in the folder, which is the single commonest refusal in the
  // log. It still counts towards agreement — two photographs that BOTH say
  // "side panel" have agreed on something — but it can no longer refuse.
  { key: 'logoPlacement', weight: 1, veto: 'none' },

  // `logoColour` follows from the same fact: the side-panel cat and the heel
  // cat are frequently different colours on one shoe, so this disagrees
  // between two honest readings of one product. Soft, so two of them together
  // still count, and one alone no longer vetoes.
  { key: 'logoColour', weight: 2, veto: 'soft' },

  // `soleHeelColour` is angle-invariant in principle and was not in practice.
  // A two-tone sole unit reads "white" from the side and "black" from
  // underneath depending on which end of it filled the frame, and the log
  // shows that flip on product after product. Kept as evidence, demoted out of
  // the veto.
  { key: 'soleHeelColour', weight: 2, veto: 'soft' },

  // The collar and the lining are the colourway, and a colourway is the thing
  // this system most has to get right. Both stay structural.
  { key: 'collarColour', weight: 3, veto: 'structural' },

  // The upper's material. Soft, and deliberately not structural: agreeing on
  // "leather" identifies nothing — half a boot catalogue is leather — and
  // promoting it made "black leather ankle boot with a zip" read as a match.
  // What it gets instead is DOUBLE WEIGHT when it disagrees, below.
  { key: 'material', weight: 3, veto: 'soft' },
  { key: 'logo', weight: 3, veto: 'soft' },
  { key: 'finish', weight: 1, veto: 'none' },

  // `pattern` and `texture` are not anchored to a PART, so from the side they
  // describe the upper and from underneath they describe the outsole.
  // "mesh-textured" and "repeating cat-shaped traction lugs" are both true of
  // one trainer, and in the log they disagree constantly for that reason.
  //
  // They are NOT demoted, because a ribbed-knit upper and a perforated-mesh
  // upper really are two products and this pair is how that is seen. What
  // changed instead is the number of them it takes to refuse a photograph while
  // a group is being built — two was reachable by these two fields alone.
  { key: 'pattern', weight: 2, veto: 'soft' },
  { key: 'texture', weight: 1, veto: 'soft' },
  { key: 'stitching', weight: 1, veto: 'none' },
  { key: 'secondaryColours', weight: 1, veto: 'none' },

  // Size is evidence, never a grouping key. One photograph showing 39 and
  // another showing nothing is not a disagreement, and the same model in two
  // sizes is one product unless a business rule says otherwise. Weight zero,
  // veto none: it appears in the fingerprint and changes no decision.
  { key: 'size', weight: 0, veto: 'none' },
];

// --- distinctiveness, measured against THIS folder ------------------------

/**
 * The flaw this exists to fix, stated plainly, because it is not obvious and it
 * cost a folder of a hundred and ten photographs to find:
 *
 *     AN ATTRIBUTE IS ONLY DISTINCTIVE RELATIVE TO WHAT ELSE IS IN THE FOLDER.
 *
 * The weights and vetoes above are absolute, and for boots they work: a block
 * heel really is not a stiletto. Given a folder of a hundred and ten black
 * PUMA trainers they collapse completely. Every one of them is `flat` heeled,
 * `round` toed, `rubber` soled and fastened with `laces`; every one of them is
 * branded PUMA. Four structural agreements and a brand, on every pair in the
 * folder — so the identification bar was cleared by every pair, and a hundred
 * and ten photographs became four products.
 *
 * The measurement that fixes it is free and local. Count how much of the folder
 * uses each word. A word almost everything uses identifies nothing, whatever
 * the table above says it is worth; a word a handful of readings use is what
 * actually separates one trainer from the next.
 *
 * Only IDENTIFICATION consults this. Conflicts and vetoes stay absolute: two
 * disagreeing heels are two products whether or not the folder is full of
 * heels, and no amount of arithmetic about word frequency should be able to
 * merge two colourways.
 */

/** A value this much of the folder shares tells one item from another not at all. */
export const COMMON_SHARE = 0.5;

export interface FolderVocabulary {
  /** Readings it was built from. */
  readings: number;
  /** Share of readings whose value for this field shares the given one's rarest word. */
  share: (field: string, value: string) => number;
  /** Share of readings naming a distinctive detail containing this word. */
  wordShare: (word: string) => number;
}

/** Words that carry no meaning of their own inside a description of a feature. */
const DETAIL_STOPWORDS = new Set([
  'the', 'and', 'with', 'on', 'at', 'of', 'in', 'to', 'for', 'from', 'is', 'are',
  'has', 'have', 'its', 'it', 'this', 'that', 'both', 'one', 'two', 'three',
  'visible', 'small', 'large', 'big', 'little', 'over', 'under', 'across', 'near',
  'around', 'along', 'onto', 'into', 'very', 'quite',
]);

/**
 * The meaningful words in a description of a feature.
 *
 * "outsole" and "midsole" fold to "sole" because a model uses whichever occurs
 * to it, from whichever angle, for the same piece of rubber — and this text is
 * matched between two photographs of one item.
 */
export const detailWords = (detail: string): Set<string> =>
  new Set(
    detail
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .map((word) => (word === 'outsole' || word === 'midsole' ? 'sole' : word))
      .filter((word) => word.length > 2 && !DETAIL_STOPWORDS.has(word))
  );

/**
 * Whether two descriptions describe the same feature.
 *
 * Exact string equality was the original test and it is close to useless: one
 * photograph says "white outsole with hexagonal tread" and another says
 * "hexagonal tread on the white midsole", and those are the same sole. What
 * matters is whether they share a word the rest of the folder does NOT use —
 * "hexagonal" identifies, "white" and "sole" do not.
 *
 * Without a vocabulary to ask, two shared words is the fallback bar.
 */
export const detailsAgree = (
  a: string,
  b: string,
  vocabulary?: FolderVocabulary
): boolean => {
  if (a === b) return true;

  const left = detailWords(a);
  const right = detailWords(b);
  const shared = [...left].filter((word) => right.has(word));
  if (!shared.length) return false;

  if (!vocabulary) return shared.length >= 2;
  return shared.some((word) => vocabulary.wordShare(word) < COMMON_SHARE);
};

/**
 * How much of this folder uses each word, per field.
 *
 * Built once per assembly from every reading the folder produced, and consulted
 * only to answer "does this agreement narrow anything down".
 */
export const buildVocabulary = (readings: ImageAttributes[]): FolderVocabulary => {
  const total = Math.max(1, readings.length);
  const perField = new Map<string, Map<string, number>>();
  const perDetailWord = new Map<string, number>();

  const bump = (counts: Map<string, number>, token: string) =>
    counts.set(token, (counts.get(token) ?? 0) + 1);

  readings.forEach((reading) => {
    ATTRIBUTE_KEYS.forEach((key) => {
      const value = reading[key] as string | undefined;
      if (!value) return;

      let counts = perField.get(key);
      if (!counts) {
        counts = new Map();
        perField.set(key, counts);
      }
      // Once per reading, not once per occurrence: a reading that says
      // "black black" is one reading that said black.
      valueTokens(key, value).forEach((token) => bump(counts!, token));
    });

    const words = new Set<string>();
    (reading.details ?? []).forEach((detail) =>
      detailWords(detail).forEach((word) => words.add(word))
    );
    words.forEach((word) => bump(perDetailWord, word));
  });

  return {
    readings: readings.length,

    share: (field, value) => {
      const counts = perField.get(field);
      if (!counts) return 0;

      const tokens = [...valueTokens(field, value)];
      if (!tokens.length) return 0;

      // The RAREST word decides. "white outsole with hexagonal tread" is
      // distinctive because of "hexagonal", not despite "white" — taking the
      // commonest word instead would call every phrase generic the moment it
      // contained one ordinary word, which is all of them.
      return Math.min(...tokens.map((token) => (counts.get(token) ?? 0) / total));
    },

    wordShare: (word) => (perDetailWord.get(word) ?? 0) / total,
  };
};

/**
 * Soft-veto fields that are two words for one observation.
 *
 * A disagreement across a group counts once, so a single fact cannot reach a
 * threshold that was set for independent judgements.
 */
const CORRELATED: Record<string, string> = {
  pattern: 'surface',
  texture: 'surface',
  finish: 'surface',
};

/** Colour and the distinctive details are scored outside the table. */
export const COLOUR_WEIGHT = 3;
export const DETAIL_WEIGHT = 3;

/** Below this much shared evidence, no verdict is honest. */
export const MIN_EVIDENCE = 5;

export const SAME_SCORE = 0.72;
export const DIFFERENT_SCORE = 0.45;

export interface Comparison {
  verdict: 'same' | 'different' | 'uncertain';
  /** Agreement over the evidence BOTH sides actually had, 0..1. */
  score: number;
  /** Weight of the signals both sides knew. Low means "too little was seen". */
  known: number;
  agreements: string[];
  conflicts: string[];
  /**
   * How many physical facts about how the item is built disagreed.
   *
   * Reported separately from `conflicts` because callers act on the COUNT.
   * Two is a different product; one is the ambiguous case. A caller deciding
   * whether to absorb a photograph into a group it is already building needs
   * that number, not a verdict computed for a different question.
   */
  structuralConflicts: number;
  /**
   * How many judgements disagreed — material, pattern, texture, logo.
   *
   * Individually forgivable, which is why they are counted rather than vetoed.
   * A caller BUILDING a group cares about two of them; a caller comparing two
   * finished candidates waits for three.
   */
  softConflicts: number;
  /** The single fact that settled it, when one did. */
  decisive?: string;
}

/**
 * Are these two the same physical product?
 *
 * The order matters and is not arbitrary. The decisive facts are asked first,
 * so a matching SKU is not diluted by a dozen soft fields and a category
 * conflict does not have to out-vote them. Then structure. Only then the
 * weighted score, which is where the ordinary evidence lives.
 */
export const compare = (
  a: ImageAttributes,
  b: ImageAttributes,
  /**
   * What the rest of the folder looks like. Optional, and absent means every
   * agreement is taken at face value — which is right for a pair judged on its
   * own, and wrong for a pair judged inside a folder of near-identical items.
   */
  vocabulary?: FolderVocabulary
): Comparison => {
  const agreements: string[] = [];
  const conflicts: string[] = [];

  /** Does agreeing on this value narrow anything down, in THIS folder? */
  const identifying = (field: string, value?: string): boolean =>
    !!value && (!vocabulary || vocabulary.share(field, value) < COMMON_SHARE);

  const settle = (verdict: 'same' | 'different', decisive: string): Comparison => ({
    verdict,
    score: verdict === 'same' ? 1 : 0,
    known: MIN_EVIDENCE,
    agreements,
    conflicts,
    structuralConflicts: 0,
    softConflicts: 0,
    decisive,
  });

  // 1. Category. A boot and a jacket are not one product whatever else agrees.
  if (a.category && b.category && a.category !== b.category) {
    conflicts.push(`category ${a.category} vs ${b.category}`);
    return settle('different', 'category');
  }

  // 2. Colourway. Two colourways of one silhouette are two products, and a
  //    render built from both is wrong in a way nobody can unpick afterwards.
  if (!colourAllows(a.colour, b.colour)) {
    conflicts.push(`colour "${a.colour}" vs "${b.colour}"`);
    return settle('different', 'colour');
  }

  // 3. SKU. The only field in the system that is decisive in both directions,
  //    because it is the only one that is an identifier rather than a
  //    description. Missing on one side settles nothing at all.
  //
  //    Normalised HERE rather than trusted from the caller. This is the one
  //    comparison that ends the function on its own, so a code that reached
  //    the fingerprint unnormalised — hand-built, restored from an older
  //    result, read by a future caller that does not go through
  //    `parseAttributes` — would make "XJ-204" and "XJ204" two products.
  const skuA = normaliseSku(a.sku);
  const skuB = normaliseSku(b.sku);
  if (skuA && skuB) {
    if (skuA === skuB) {
      agreements.push(`sku ${skuA}`);
      return settle('same', 'sku');
    }
    conflicts.push(`sku ${skuA} vs ${skuB}`);
    return settle('different', 'sku');
  }

  // 4. Brand. Two named brands that disagree are two products. A brand read
  //    off one photograph and not the other says nothing.
  if (attributeAgreement('brand', a.brand, b.brand) === 'conflict') {
    conflicts.push(`brand "${a.brand}" vs "${b.brand}"`);
    return settle('different', 'brand');
  }
  if (a.brand && b.brand) agreements.push(`brand ${a.brand}`);

  // 5. Everything else, weighted.
  let known = 0;
  let agreed = 0;
  let structuralConflicts = 0;
  let strongConflicts = 0;
  const softConflictingFields = new Set<string>();

  /**
   * Agreements that IDENTIFY an item, as opposed to describing it.
   *
   * "Both are black leather ankle boots" is three fields agreeing perfectly
   * and is worth nothing as evidence of identity — half a footwear catalogue
   * answers to it. Two kinds of agreement are worth more, and they are worth
   * DIFFERENT amounts, which is why they are counted separately.
   *
   * An identity mark — a distinctive detail both photographs show, a legible
   * logo, a named brand — narrows the field on its own.
   *
   * A structural agreement — a matching heel, sole, toe, shaft or closure —
   * does not. "Black leather ankle boot with a zip" is still a description of
   * a great many boots, and treating one such agreement as identification
   * merged a stiletto-heeled boot into a block-heeled one on the strength of
   * a top-down photograph that could see the zip and nothing else. Two of
   * them together is a specification; one is an adjective.
   */
  let identityMarks = 0;
  let structuralAgreements = 0;
  if (a.brand && b.brand && identifying('brand', a.brand)) identityMarks += 1;

  SIGNALS.forEach(({ key, weight, veto }) => {
    if (!weight) return;
    const agreement = attributeAgreement(
      key,
      a[key] as string | undefined,
      b[key] as string | undefined
    );
    if (agreement === 'unknown') return;

    known += weight;
    if (agreement === 'agree') {
      agreed += weight;
      agreements.push(`${key} ${String(a[key])}`);
      if (!identifying(key, a[key] as string)) return;
      if (key === 'logo') identityMarks += 1;
      else if (veto === 'structural') structuralAgreements += 1;
      return;
    }

    conflicts.push(`${key} "${String(a[key])}" vs "${String(b[key])}"`);
    if (veto === 'structural') structuralConflicts += 1;
    if (veto === 'strong') strongConflicts += 1;
    if (veto === 'soft') softConflictingFields.add(key);
  });

  // Fields that describe ONE observation count ONCE.
  //
  // `pattern`, `texture` and `finish` are three words for the surface, and a
  // model given three boxes fills all three from the same look at the shoe. So
  // a profile answering "mesh-textured"/"textured" against a sole shot
  // answering "repeating cat-shaped traction lugs"/"treaded" produced TWO soft
  // conflicts out of ONE fact — that the upper and the outsole do not look
  // alike, which is true of every shoe ever made.
  //
  // Counting them separately let a single observation reach a threshold meant
  // for independent evidence, which is how a sole photograph came to be
  // refused entry to its own product.
  const softGroups = new Set(
    [...softConflictingFields].map((key) => CORRELATED[key] ?? key)
  );

  // A DISAGREEING MATERIAL COUNTS DOUBLE.
  //
  // It is the strongest of the soft signals and the only one the prompt pins
  // to a single part of the shoe — "the material of the UPPER only". A knit
  // trainer against a mesh one disagrees about the material and about the
  // surface, and that pair is two products; a profile against a sole shot of
  // ONE shoe disagrees about the surface and the heel end of the sole, and
  // that pair is one product. Both are two soft groups, so the count alone
  // cannot tell them apart. Which fields they are can.
  const softConflicts = softGroups.size + (softGroups.has('material') ? 1 : 0);

  // Colour agreement is worth counting once the veto above has let it through.
  const colourA = colourFamilies(a.colour);
  const colourB = colourFamilies(b.colour);
  if (colourA.size && colourB.size) {
    known += COLOUR_WEIGHT;
    agreed += COLOUR_WEIGHT;
    agreements.push(`colour ${a.colour}`);
  }

  // Distinctive details are positive-only. A buckle the profile shows and the
  // sole shot cannot is not a disagreement about the buckle — which is exactly
  // why details are never allowed to subtract.
  const detailsA = a.details ?? [];
  const detailsB = b.details ?? [];
  const shared = detailsA.filter((detail) =>
    detailsB.some((other) => detailsAgree(detail, other, vocabulary))
  );
  if (shared.length) {
    known += DETAIL_WEIGHT;
    agreed += DETAIL_WEIGHT;
    agreements.push(`details ${shared.join(', ')}`);
    identityMarks += 1;
  }

  const score = known ? agreed / known : 0;

  // DISAGREEMENTS ADD UP, and they add up at different rates.
  //
  // A structural fact — the heel, the toe, the sole, the closure, the colour
  // of a part — is a physical claim about how the item is built, so two of
  // them disagreeing is a different product. That is the rule that keeps the
  // black block-heel square-toe boot apart from the black stiletto
  // pointed-toe one, and it is checked before the score because a long tail of
  // agreeing soft fields would otherwise out-vote it.
  //
  // A soft one — the material, the pattern, the texture — is a judgement, and
  // one of them is worth ignoring. But FOUR of them are not. Until this rule
  // existed a soft conflict could never split anything however many there
  // were, and two visibly different trainers sat in one group disagreeing
  // about their material, their pattern and their stitching all at once, each
  // disagreement individually forgivable and the pile of them ignored.
  if (structuralConflicts >= 2 || structuralConflicts + strongConflicts >= 3) {
    return {
      verdict: 'different', score, known, agreements, conflicts,
      structuralConflicts, softConflicts, decisive: 'structure',
    };
  }

  // THREE JUDGEMENTS DISAGREEING IS A DIFFERENT PRODUCT, even with nothing
  // structural to say so.
  //
  // A knit trainer and a mesh one, both black and white, both flat, round,
  // rubber-soled and laced: nothing structural disagrees, and they sat in one
  // group disagreeing about their material, their pattern and their texture
  // all at once. Each disagreement was individually forgivable and nothing
  // was counting them. One is noise, two is a coincidence, three is a
  // different shoe — and one structural disagreement makes two enough.
  if (softConflicts >= 3 || (structuralConflicts === 1 && softConflicts >= 2)) {
    return {
      verdict: 'different', score, known, agreements, conflicts,
      structuralConflicts, softConflicts,
      decisive: structuralConflicts ? 'structure' : 'accumulated difference',
    };
  }

  // Too little seen on both sides to say anything. Not a mismatch — a shrug.
  if (known < MIN_EVIDENCE) {
    return { verdict: 'uncertain', score, known, agreements, conflicts, structuralConflicts, softConflicts };
  }

  if (score <= DIFFERENT_SCORE) {
    return { verdict: 'different', score, known, agreements, conflicts, structuralConflicts, softConflicts };
  }

  // ONE structural disagreement with everything else agreeing is the genuinely
  // ambiguous case — a misread heel, or a real second product. It goes to a
  // person rather than being resolved by arithmetic in either direction.
  if (structuralConflicts === 1) {
    return {
      verdict: 'uncertain', score, known, agreements, conflicts,
      structuralConflicts, softConflicts, decisive: 'structure',
    };
  }

  if (score >= SAME_SCORE) {
    // Perfect agreement about nothing in particular is not a match. Two black
    // leather ankle boots agree on category, type, colour and material and are
    // routinely two different products, so a verdict of "same" has to rest on
    // either an identity mark — a distinctive detail both photographs show, a
    // logo, a brand — or on TWO agreeing structural facts. Without that the
    // honest answer is that nobody can tell yet, which sends the pair to
    // verification, or to a person.
    if (!identityMarks && structuralAgreements < 2) {
      return {
        verdict: 'uncertain', score, known, agreements, conflicts,
        structuralConflicts, softConflicts, decisive: 'generic',
      };
    }
    return { verdict: 'same', score, known, agreements, conflicts, structuralConflicts, softConflicts };
  }

  return { verdict: 'uncertain', score, known, agreements, conflicts, structuralConflicts, softConflicts };
};

// --- the product-level fingerprint ---------------------------------------

export interface ProductFingerprint extends ImageAttributes {
  /** How many photographs contributed the winning value of each field. */
  support: Partial<Record<keyof ImageAttributes, number>>;
  /** Photographs folded in. */
  imageCount: number;
  /** Every distinct size seen. A product may legitimately have several. */
  sizes: string[];
  /** Every distinct identifier seen. More than one is a warning sign. */
  skus: string[];
  /**
   * Fields whose photographs disagreed with each other. Not an error — a
   * misread happens — but the honest input to a confidence score.
   */
  internalConflicts: string[];
}

/**
 * Every photograph of one candidate product, folded into one identity.
 *
 * This is the step that makes the rest of the system work. The front shot
 * knows the toe, the profile knows the heel and the shaft, the sole shot knows
 * the tread, the box shot knows the SKU — and the comparison that decides
 * whether two candidates are one product gets all of it at once, instead of
 * comparing a front shot against a sole shot and finding nothing in common.
 *
 * Per field the majority reading wins. A minority reading is not discarded
 * silently: it is recorded as an internal conflict, which lowers confidence
 * and puts the product in front of a person.
 */
export const aggregateFingerprint = (readings: ImageAttributes[]): ProductFingerprint => {
  const fingerprint: ProductFingerprint = {
    support: {},
    imageCount: readings.length,
    sizes: [],
    skus: [],
    internalConflicts: [],
  };

  if (!readings.length) return fingerprint;

  ATTRIBUTE_KEYS.forEach((key) => {
    if (key === 'sku' || key === 'size') return;

    const votes = new Map<string, number>();
    readings.forEach((reading) => {
      const value = reading[key] as string | undefined;
      if (!value) return;
      votes.set(value, (votes.get(value) ?? 0) + 1);
    });

    if (!votes.size) return;

    // Most-supported wins; a tie goes to the first seen, which keeps the
    // result stable for a given folder rather than depending on Map order.
    let best = '';
    let bestCount = 0;
    votes.forEach((count, value) => {
      if (count > bestCount) {
        best = value;
        bestCount = count;
      }
    });

    (fingerprint as unknown as Record<string, unknown>)[key] = best;
    fingerprint.support[key] = bestCount;

    // A losing reading only counts as a conflict when it genuinely disagrees.
    // "block" and "block heel 7cm" are one reading told twice.
    const dissent = [...votes.keys()].filter(
      (value) => value !== best && attributeAgreement(key, value, best) === 'conflict'
    );
    if (dissent.length) {
      fingerprint.internalConflicts.push(`${key}: "${best}" vs "${dissent.join('", "')}"`);
    }
  });

  // Details accumulate rather than vote: a detail is evidence wherever it was
  // seen, and no angle shows all of them.
  const details = new Set<string>();
  readings.forEach((reading) => (reading.details ?? []).forEach((detail) => details.add(detail)));
  if (details.size) fingerprint.details = [...details];

  // Sizes accumulate. The same model in two sizes is one product; a size seen
  // once and not again is not a contradiction.
  const sizes = new Set<string>();
  readings.forEach((reading) => {
    if (reading.size) sizes.add(reading.size);
  });
  fingerprint.sizes = [...sizes];
  if (fingerprint.sizes.length) fingerprint.size = fingerprint.sizes[0];

  // Identifiers accumulate too, but two different ones inside one candidate
  // product mean the candidate is wrong, and that has to be visible.
  const skus = new Set<string>();
  readings.forEach((reading) => {
    const sku = normaliseSku(reading.sku);
    if (sku) skus.add(sku);
  });
  fingerprint.skus = [...skus];
  if (fingerprint.skus.length) {
    fingerprint.sku = fingerprint.skus[0];
    fingerprint.support.sku = readings.filter(
      (reading) => normaliseSku(reading.sku) === fingerprint.sku
    ).length;
    if (fingerprint.skus.length > 1) {
      fingerprint.internalConflicts.push(`sku: ${fingerprint.skus.join(' vs ')}`);
    }
  }

  return fingerprint;
};

/** The fields that actually say which product this is, for depth scoring. */
const IDENTITY_FIELDS: (keyof ImageAttributes)[] = [
  'type', 'silhouette', 'colour', 'material',
  'heelType', 'toeShape', 'soleType', 'shaftHeight', 'closure',
  'soleColour', 'heelColour', 'soleHeelColour', 'laceColour', 'logoColour',
  'logoPlacement', 'liningColour', 'collarColour', 'tongueColour',
  'logo', 'brand', 'sku',
];

export interface ConfidenceInput {
  fingerprint: ProductFingerprint;
  /** Pairwise verdicts between the photographs that were folded together. */
  agreed: number;
  uncertain: number;
  /** Pairs the evidence called different but that were grouped anyway. */
  contradicted: number;
  /** Photographs placed without the model naming a product for them. */
  fallbackPlacements: number;
  /**
   * Photographs of an angle the product already had.
   *
   * A shoot takes one sole photograph of a shoe, one from the back, one from
   * each side. A product holding five soles is not a product — it is several,
   * and no amount of agreement about "black" makes it one.
   */
  repeatedViews?: number;
}

/**
 * A confidence number that means something.
 *
 * Every term below is a count of something that actually happened during this
 * folder's run. Nothing is invented, nothing is a constant dressed up as a
 * measurement, and the result never reaches 1 — a grouping made from a model's
 * reading of photographs is never certain, and printing "100%" next to one
 * would be a claim the user has no way to check.
 */
export const confidenceOf = ({
  fingerprint,
  agreed,
  uncertain,
  contradicted,
  fallbackPlacements,
  repeatedViews = 0,
}: ConfidenceInput): number => {
  const pairs = agreed + uncertain + contradicted;

  // A product of one photograph has no internal agreement to measure. It is
  // neither trustworthy nor suspect on that basis alone, so it sits in the
  // middle and is moved only by the evidence its single photograph carries.
  const agreement = pairs ? (agreed + uncertain * 0.5) / (pairs + contradicted) : 0.5;

  // Agreement alone is capped well short of the top, and that is the point.
  // Two photographs that agree on "black footwear" agree perfectly and have
  // told you almost nothing; a group cannot reach a high number on internal
  // consistency without also carrying evidence that identifies the product.
  // Letting agreement saturate the scale made every clean group score the same
  // and hid the difference between a legible product code and a colour word.
  let score = 0.35 + 0.4 * agreement;

  const known = IDENTITY_FIELDS.filter((key) => fingerprint[key] !== undefined).length;
  score += 0.1 * (known / IDENTITY_FIELDS.length);

  // Corroboration, in descending order of how hard it is to get wrong.
  if (fingerprint.skus.length === 1) score += 0.09;
  if (fingerprint.brand || fingerprint.logo) score += 0.03;
  if ((fingerprint.details ?? []).length >= 2 && fingerprint.imageCount >= 2) score += 0.03;

  score -= 0.15 * fingerprint.internalConflicts.length;
  score -= Math.min(0.24, 0.08 * fallbackPlacements);

  // A repeated angle is close to proof that the group holds more than one
  // item, so it is weighted like one — heavily, and without a floor that lets
  // a group of five soles look respectable.
  score -= 0.2 * repeatedViews;

  return Math.max(0.05, Math.min(0.99, Number(score.toFixed(2))));
};

/** A one-line description of a product, for the review screen. */
export const describeFingerprint = (fingerprint: ProductFingerprint): string => {
  const head = [fingerprint.colour, fingerprint.material, fingerprint.type]
    .filter(Boolean)
    .join(' ');

  const traits = [
    fingerprint.heelType && `${fingerprint.heelType} heel`,
    fingerprint.toeShape && `${fingerprint.toeShape} toe`,
    fingerprint.closure,
    fingerprint.soleColour
      ? `${fingerprint.soleColour} sole`
      : fingerprint.soleType && `${fingerprint.soleType} sole`,
    fingerprint.laceColour && `${fingerprint.laceColour} laces`,
    fingerprint.logoColour && `${fingerprint.logoColour} logo`,
    fingerprint.liningColour && `${fingerprint.liningColour} lining`,
    fingerprint.shaftHeight,
  ].filter(Boolean);

  return [head, traits.join(' · ')].filter(Boolean).join(' — ');
};
