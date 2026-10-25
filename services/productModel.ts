import {
  Category,
  CATEGORIES,
  ImageAttributes,
  ProductFingerprint,
  aggregateFingerprint,
  compare,
  confidenceOf,
  describeFingerprint,
} from './productFingerprint';

// The identity model lives in `productFingerprint.ts`; these are re-exported so
// the many callers that already import them from here keep working, and so
// there is still one import for "everything about a product group".
export type { Category, ImageAttributes, ProductFingerprint };
export { CATEGORIES };

/** A group below this is put in front of the user rather than presented as settled. */
export const REVIEW_CONFIDENCE = 0.7;

export type ViewName =
  | 'FRONT' | 'BACK' | 'LEFT' | 'RIGHT' | 'TOP' | 'SOLE'
  | 'CLOSEUP' | 'DETAIL' | 'OTHER';

export const VIEW_NAMES: ViewName[] = [
  'FRONT', 'BACK', 'LEFT', 'RIGHT', 'TOP', 'SOLE', 'CLOSEUP', 'DETAIL', 'OTHER',
];

/**
 * ANGLES A PRODUCT HAS AT MOST ONE OF.
 *
 * A shoot photographs a shoe once from each side, once from the back, once
 * from above and once from underneath. So a candidate product holding two SOLE
 * photographs is not one product — it is two, and this is by some distance the
 * cheapest and most reliable signal in the whole system: it needs no model, no
 * request and no arithmetic, and it is nearly impossible to satisfy by
 * accident.
 *
 * It caught what everything else missed. Seven photographs sat in one group,
 * five of them soles of visibly different trainers — different treads,
 * different colours — and every attribute agreed, because a sole photograph of
 * a black trainer describes a black trainer whichever black trainer it is.
 *
 * CLOSEUP, DETAIL and OTHER are deliberately absent: a product may have any
 * number of those and frequently does.
 *
 * SO ARE FRONT, BACK, LEFT AND RIGHT, and taking them out is the single largest
 * correction this file has had.
 *
 * The premise above — "a shoot photographs a shoe once from each side" — is
 * true of the sole and the top and false of everything else. A real shoot takes
 * several profiles of one shoe: closer, further, rotated a few degrees, in
 * better light, with the laces retied. All of them are honestly LEFT. On a
 * folder of a hundred and ten trainers this rule fired about ninety times, and
 * almost every one of those was a refusal to join two candidates whose
 * evidence had ALREADY been compared and found to describe one product. The
 * folder came out as seventy-two products.
 *
 * The rule earns its place on SOLE and TOP, which is where it caught the case
 * it was written for: five soles of visibly different trainers in one group,
 * every attribute agreeing, because a sole photograph of a black trainer
 * describes a black trainer whichever black trainer it is. That case is
 * untouched.
 *
 * A profile is not that case. Two profiles of two different trainers disagree
 * about the upper, the panel, the lacing and the collar, so the ordinary
 * evidence separates them without help — and where it cannot, two profiles in
 * one group still mark it for review through `repeatedViews`.
 */
export const UNIQUE_VIEWS: ViewName[] = ['TOP', 'SOLE'];

const holdsOnlyOne = (view: ViewName | undefined): view is ViewName =>
  !!view && UNIQUE_VIEWS.includes(view);

/** Angles both sides hold, and which therefore cannot be one product. */
export const clashingViews = (
  left: Iterable<ViewName | undefined>,
  right: Iterable<ViewName | undefined>
): ViewName[] => {
  const held = new Set<ViewName>();
  for (const view of left) if (holdsOnlyOne(view)) held.add(view);

  const clashes = new Set<ViewName>();
  for (const view of right) if (holdsOnlyOne(view) && held.has(view)) clashes.add(view);

  return [...clashes];
};

/** Angles a group already holds more than one of. */
export const repeatedViews = (views: Iterable<ViewName | undefined>): ViewName[] => {
  const seen = new Set<ViewName>();
  const twice = new Set<ViewName>();

  for (const view of views) {
    if (!holdsOnlyOne(view)) continue;
    if (seen.has(view)) twice.add(view);
    seen.add(view);
  }

  return [...twice];
};

export interface FolderImage {
  /** Stable for the lifetime of the upload; how groups refer to photos. */
  id: string;
  fileName: string;
  /** Full-size base64 (no data: prefix) — what renders are built from. */
  full: string;
  /** Downscaled base64 shown to the model and used in the review grid. */
  thumb: string;
  /** Smaller still, produced alongside `thumb`. */
  scout?: string;
  /**
   * Where the file sat inside the uploaded folder, forward-slashed and relative
   * to it — `"shoes/red-runner/front.jpg"`. The subfolder is what decides which
   * product a photo belongs to (see `folderProducts.ts`). Absent for a photo
   * that arrived without a folder.
   */
  path?: string;
}

export interface GroupedImage {
  imageId: string;
  view: ViewName;
  /** Whether the model named this view or it was filled in for lack of one. */
  viewSource: 'model' | 'fallback';
  /** The product's colours as read from this photo. Shown to the user. */
  colour?: string;
  /** Everything this photograph showed. Absent fields were not visible. */
  attributes?: ImageAttributes;
  /** Why this photo is in this group, in a few words, for the review screen. */
  reason?: string;
  /** How this photograph came to be in its group. v3 only. */
  joinedVia?: {
    to: string;                    // imageId it attached to
    kind: 'direct' | 'indirect';
    because?: string;              // present only when kind === 'direct'
    hops?: number;                 // chain length when indirect
  };
}

export interface ProductGroup {
  id: string;
  /** Editable label. Defaults to "Product 001". */
  name: string;
  category: Category;
  images: GroupedImage[];
  confidence: number;
  needsReview: boolean;
  /** Set when something other than the photos' own certainty flags this group. */
  flagged?: boolean;
  /** The colours the first photo of this product established, if any. */
  colour?: string;
  /** Every photograph's reading, folded into one product identity. */
  fingerprint?: ProductFingerprint;
  /** The brand, when a photograph showed one legibly. */
  brand?: string;
  /** "black leather ankle_boot — block heel · square toe · zipper". */
  description?: string;
}

export interface GroupingResult {
  groups: ProductGroup[];
  /**
   * Photos no product could claim on the evidence available — the UNCERTAIN
   * tray. A photo lands here because placing it would have been a guess, which
   * is the outcome the review screen exists to catch.
   */
  unassigned: string[];
  /** False when the analysis failed. `groups` is then empty. */
  classified: boolean;
  /**
   * What went wrong, in words, when `classified` is false.
   *
   * A failure is never turned into one product per photo: that hides the real
   * problem behind a grouping that is confidently wrong.
   */
  error?: string;
  /** The model's actual reply when it could not be read, for diagnosis. */
  rawReply?: string;
  /** One line per photo saying where it landed. */
  log: string[];
  /** True when the user stopped the run before every photo was placed. */
  stopped?: boolean;
  /** v3: why each unassigned photograph is in the tray. Keyed by imageId. */
  uncertainReasons?: Record<string, string>;
  /** v3: estimated AI spend for the run, in USD. Null when rates are unconfigured. */
  spendUsd?: number | null;
}

export interface GroupingProgress {
  /**
   * How far through THIS PHASE the run is — not through the whole run.
   *
   * Phase-local on purpose. Blending stages that work at wildly different rates
   * into one number produces an estimate taken from whichever stage happens to
   * be slowest, applied to all of them: a folder that had cropped nine
   * photographs locally reported "about 15 minutes left" for work that was
   * mostly seconds of requests. A bar that restarts and says what it is doing is
   * honest; one that runs smoothly and lies is not.
   */
  done: number;
  total: number;
  /**
   * 'preparing'  — cropping the backgrounds off, locally.
   * 'loading'    — the one-time download of the local image model.
   * 'reading'    — computing the local embeddings.
   * 'assigning'  — asking the model about the contact sheets.
   * 'verifying'  — the few pairs that came back judged both ways.
   */
  phase: 'preparing' | 'loading' | 'reading' | 'assigning' | 'verifying' | 'angles';
  /** Megabytes, when the phase is a download rather than a count of photos. */
  unit?: 'photos' | 'mb';
  /** First photo of the request in flight, 1-based. */
  from?: number;
  /** Last photo of the request in flight, 1-based. */
  to?: number;
}

// --- group bookkeeping ---------------------------------------------------

export const groupLabel = (index: number): string =>
  `Product ${String(index + 1).padStart(3, '0')}`;

/**
 * Recomputes everything that DESCRIBES a group from the photos that DEFINE it.
 *
 * Membership is the input; the fingerprint, the one-line description, the
 * brand and the confidence are all outputs. That direction matters because the
 * review screen lets a person add and remove photographs, and a fingerprint
 * that still described the automatic grouping after a person corrected it
 * would be worse than none at all.
 *
 * Confidence is recomputed only from photographs that carry a reading. A group
 * assembled by hand, or by an older run, has no evidence to score and keeps
 * whatever confidence it arrived with rather than being assigned an invented
 * one.
 */
export const summarise = (group: ProductGroup): ProductGroup => {
  const readings = group.images
    .map((image) => image.attributes)
    .filter((attributes): attributes is ImageAttributes => !!attributes);

  const measured = readings.length > 0;
  const fingerprint = measured ? aggregateFingerprint(readings) : group.fingerprint;

  let confidence = group.confidence;

  if (measured && fingerprint) {
    // Every pair of photographs inside the group, judged on identity. This is
    // the group's own evidence about itself: six photographs that all agree is
    // a different thing from six photographs joined by one weak link.
    let agreed = 0;
    let uncertain = 0;
    let contradicted = 0;

    for (let i = 0; i < readings.length; i += 1) {
      for (let j = i + 1; j < readings.length; j += 1) {
        const verdict = compare(readings[i], readings[j]).verdict;
        if (verdict === 'same') agreed += 1;
        else if (verdict === 'uncertain') uncertain += 1;
        else contradicted += 1;
      }
    }

    confidence = confidenceOf({
      fingerprint,
      agreed,
      uncertain,
      contradicted,
      fallbackPlacements: group.images.filter((image) => image.viewSource === 'fallback').length,
      repeatedViews: repeatedViews(
        group.images.filter((image) => image.viewSource === 'model').map((image) => image.view)
      ).length,
    });
  }

  return {
    ...group,
    fingerprint,
    brand: fingerprint?.brand ?? group.brand,
    colour: fingerprint?.colour ?? group.colour,
    description: fingerprint ? describeFingerprint(fingerprint) : group.description,
    confidence,
    needsReview:
      group.flagged === true ||
      group.images.some((image) => image.viewSource === 'fallback') ||
      // Two photographs of one angle. Whatever else is true of this group, a
      // person has to look at it.
      repeatedViews(
        group.images.filter((image) => image.viewSource === 'model').map((image) => image.view)
      ).length > 0 ||
      (measured && confidence < REVIEW_CONFIDENCE),
  };
};

/** Renumbers ids and default names so the list reads 001, 002, 003 after edits. */
export const renumber = (groups: ProductGroup[]): ProductGroup[] =>
  groups.map((group, i) => {
    const wasDefault = /^Product \d{3}$/.test(group.name);
    return summarise({
      ...group,
      id: `product-${i + 1}`,
      name: wasDefault ? groupLabel(i) : group.name,
    });
  });

/** Folds one group into another, dropping any photo the target already holds. */
export const mergeGroups = (
  groups: ProductGroup[],
  fromId: string,
  intoId: string
): ProductGroup[] => {
  if (fromId === intoId) return groups;
  const from = groups.find((g) => g.id === fromId);
  const into = groups.find((g) => g.id === intoId);
  if (!from || !into) return groups;

  const held = new Set(into.images.map((i) => i.imageId));
  const merged = summarise({
    ...into,
    images: [...into.images, ...from.images.filter((i) => !held.has(i.imageId))],
  });

  return renumber(
    groups.filter((g) => g.id !== fromId).map((g) => (g.id === intoId ? merged : g))
  );
};

/**
 * Moves one photo between groups. `toId` of null drops it into the unassigned
 * tray. A group emptied by the move disappears.
 */
export const moveImage = (
  groups: ProductGroup[],
  imageId: string,
  toId: string | null
): ProductGroup[] => {
  const source = groups.find((g) => g.images.some((i) => i.imageId === imageId));
  if (!source) return groups;
  const moving = source.images.find((i) => i.imageId === imageId)!;
  if (source.id === toId) return groups;

  const next = groups
    .map((g) => {
      if (g.id === source.id) {
        return summarise({ ...g, images: g.images.filter((i) => i.imageId !== imageId) });
      }
      if (g.id === toId) return summarise({ ...g, images: [...g.images, moving] });
      return g;
    })
    .filter((g) => g.images.length > 0);

  return renumber(next);
};

/**
 * Splits the named photographs out of a group into a new one.
 *
 * The review screen's answer to a group that merged two products: rather than
 * moving photographs out one at a time into a tray and back, the photographs a
 * person picks become a product of their own, and both halves are rescored
 * from the readings they end up holding.
 */
export const splitGroup = (
  groups: ProductGroup[],
  groupId: string,
  imageIds: string[]
): ProductGroup[] => {
  const source = groups.find((g) => g.id === groupId);
  if (!source) return groups;

  const moving = new Set(imageIds);
  const taken = source.images.filter((image) => moving.has(image.imageId));
  const left = source.images.filter((image) => !moving.has(image.imageId));

  // A split that would empty one side is not a split.
  if (!taken.length || !left.length) return groups;

  const index = groups.indexOf(source);

  const next = [
    ...groups.slice(0, index),
    summarise({ ...source, images: left }),
    summarise({
      ...source,
      id: `${source.id}-split`,
      name: `${source.name} (split)`,
      images: taken,
      // A group a person had to split is a group whose automatic reading was
      // wrong somewhere, so both halves stay flagged until they are looked at.
      flagged: true,
    }),
    ...groups.slice(index + 1),
  ];

  return renumber(next);
};
