// The shared model types (FolderImage, GroupedImage, ProductGroup, GroupingResult,
// GroupingProgress, the Category/attribute re-exports, and the group bookkeeping
// helpers) and the analysis-model client (askAnalysisModel and friends) now live
// in their own files. Re-exported here so every existing import of this module
// keeps working unchanged.
export * from './productModel';
export {
  askAnalysisModel, analysisModel, ANALYSIS_MODEL, ANALYSIS_TIMEOUT_MS,
  isModelUnavailable, isRateLimited, analysisTimeoutMs,
} from './analysisClient';

import { GoogleGenAI } from '@google/genai';
import { mapWithConcurrency } from './imageUtils';
import { signatureOf, visualDistance } from './imageSignature';
import {
  bundleDuplicates,
  chainBundles,
  cutBatches,
  lookalikeLimit,
  nearestGroup,
} from './photoClustering';
import {
  Category,
  Comparison,
  FolderVocabulary,
  ImageAttributes,
  ProductFingerprint,
  aggregateFingerprint,
  asCategory,
  buildVocabulary,
  colourAllows,
  colourFamilies,
  compare,
  describeFingerprint,
  normaliseAttribute,
  parseAttributes,
} from './productFingerprint';
import {
  ViewName,
  VIEW_NAMES,
  clashingViews,
  FolderImage,
  GroupedImage,
  ProductGroup,
  GroupingResult,
  GroupingProgress,
  groupLabel,
  summarise,
  renumber,
  splitGroup,
} from './productModel';
import { askAnalysisModel, analysisModel, analysisTimeoutMs } from './analysisClient';

/**
 * Sorts a folder of mixed product photographs into one group per PRODUCT, and
 * labels each photo with the angle it shows.
 *
 * The whole design follows from one sentence: the folder is unordered, and the
 * six photographs of one boot may be images 2, 17, 54, 71, 89 and 106. Nothing
 * about where a file sits, what it is called, or when it was uploaded is
 * evidence of anything, and none of it is read here.
 *
 * The pipeline, and what each stage costs:
 *
 *   1. FINGERPRINTS OF THE SMALL COPIES — free, local, no request. Repeated
 *      frames are collapsed and the folder is ordered so photographs that look
 *      alike sit together, purely so the requests that follow are well-packed.
 *      This stage never decides that two photographs are one product.
 *   2. ATTRIBUTE EXTRACTION — one request per batch of a dozen photographs,
 *      several batches in flight at once. Each photograph comes back with a
 *      structured reading: category, type, colour, material, heel, sole, toe,
 *      shaft, closure, logo, brand, SKU, size, distinctive details, and the
 *      camera angle. Anything not visible comes back UNKNOWN rather than
 *      guessed. Consecutive batches repeat a couple of photographs, and those
 *      overlaps stitch a product that falls across a boundary.
 *   3. FINGERPRINTS PER CANDIDATE PRODUCT — free. The readings of every
 *      photograph of one candidate are folded into a single identity, so the
 *      front shot's toe and the profile's heel and the box shot's SKU are all
 *      available to the same comparison.
 *   4. MULTI-FACTOR MATCHING — free. Candidates are compared on that identity,
 *      weighted, with distinctive structure outweighing "black". Missing
 *      attributes never count against a match; two disagreeing structural
 *      facts split a product regardless of how alike the rest looks.
 *   5. AI VERIFICATION, ONLY WHERE THE EVIDENCE IS GENUINELY UNDECIDED — at
 *      most ONE further request for the whole folder, carrying only the pairs
 *      arithmetic could not settle. Never a request per pair, never a pass
 *      over the folder.
 *   6. CONFIDENCE, then the review screen, which is the gate.
 *
 * Filenames never reach the model and are never read on this side either. What
 * the model sees is pixels, in a batch of a dozen, and nothing else.
 */

/** Photos sent for identification in one request. */
export const BATCH_SIZE = 12;

/** Requests in flight at once. */
export const CONCURRENCY = 4;

/** Photos a request repeats from the one before it, to stitch the two together. */
export const OVERLAP = 2;

/** Folder cap. Beyond this the run is refused rather than silently truncated. */
export const MAX_FOLDER_IMAGES = 110;

/**
 * Verification requests for a whole folder. ONE.
 *
 * Verification exists because arithmetic on partial evidence genuinely cannot
 * settle every pair, not because a second opinion is nice to have. Its budget
 * is therefore a constant and not a function of folder size: a hundred and ten
 * photographs cost the same one request here as twelve do, and if the budget
 * is spent the remaining undecided pairs go to the review screen — which is
 * where an undecided pair belongs anyway.
 */
export const MAX_VERIFY_REQUESTS = 1;

/**
 * Candidate products the consolidation request may carry.
 *
 * ONE photograph each, so this is also the number of images in that request —
 * about two batches' worth, in a single call.
 *
 * This replaced a pairwise check that spent the same one request asking eight
 * separate yes/no questions. Pairwise was the wrong shape: it can only confirm
 * pairs somebody already suspected, and in a folder where every candidate
 * looks like every other one there is no shortlist worth drawing up. Showing
 * the model the candidates side by side and asking it to sort them uses the
 * identical budget and answers the question that is actually being asked.
 */
export const MAX_CONSOLIDATE_GROUPS = 24;

/**
 * Groups the audit may re-examine.
 *
 * The audit is the opposite of consolidation. Consolidation shows ONE
 * photograph of each candidate and looks for products that should JOIN; the
 * audit shows ALL of one candidate's photographs and asks whether they are
 * really one item — it looks for products that should SPLIT.
 *
 * Nothing before it has ever seen a group's photographs together. Every
 * decision that built the group was taken on written descriptions, one
 * photograph at a time, against a fingerprint of words. This is the first and
 * only point where the thing that gets to say "these are one shoe" is looking
 * at the shoe.
 *
 * One request per group, because a request that mixes two groups asks a
 * different and much harder question. Budget is a folder-wide ceiling and the
 * groups are spent on in order of merge risk.
 */
export const MAX_AUDIT_REQUESTS = 12;

/**
 * Photographs of one group carried into its audit request.
 *
 * A group larger than this is already being reviewed by a person, and the
 * marginal photograph past the eighth adds far less than it costs. The ones
 * sent are chosen for spread of view rather than order, so the request holds
 * the angles that actually disagree.
 */
export const MAX_AUDIT_IMAGES = 8;

/** Below this many photographs there is nothing to audit — one photo is one item. */
export const MIN_AUDIT_IMAGES = 2;

// The identity model lives in `productFingerprint.ts`; these are re-exported so
// the many callers that already import them from here keep working, and so
// there is still one import for "everything about a product group".
export type { Comparison, FolderVocabulary };
export {
  colourFamilies, colourAllows, compare, aggregateFingerprint, buildVocabulary,
};

// --- the attribute cache -------------------------------------------------

/**
 * One photograph's reading, kept so it is never paid for twice.
 *
 * Keyed by the CONTENT of the small copy, not by the image id, because the id
 * is minted fresh on every upload: a user who re-uploads the same folder after
 * a failed run, or who uploads a folder overlapping one already seen, would
 * otherwise pay for every photograph again. Content-keyed, the second run over
 * an unchanged folder sends nothing at all.
 *
 * Module-level and unbounded within a session, which is the right trade for
 * something holding at most a few hundred small objects: an eviction policy
 * here would exist only to throw away answers that have already been paid for.
 *
 * The camera angle is cached with the attributes rather than separately. It
 * came back in the same answer and was paid for at the same time, and a cached
 * run that produced products with no angles on them would be a saving that
 * cost the user the thing they were buying.
 */
interface CachedReading {
  attributes: ImageAttributes;
  view?: ViewName;
}

const attributeCache = new Map<string, CachedReading>();

/** FNV-1a over the base64. Cheap, and collisions here cost a re-read, not a bug. */
export const contentKey = (base64: string): string => {
  let hash = 0x811c9dc5;
  for (let i = 0; i < base64.length; i += 1) {
    hash ^= base64.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${base64.length}:${(hash >>> 0).toString(36)}`;
};

/**
 * Audit verdicts, kept so a re-run of the same folder is still free.
 *
 * Keyed by the CONTENTS OF THE SET, not by the group id — the ids are minted
 * fresh every run, and the question the audit asked was about the photographs.
 * The same photographs shown together get the same answer, so asking twice
 * buys nothing.
 *
 * Sorted before joining, because the order photographs are sent in is chosen by
 * `auditSelection` from views that may themselves have been re-read; the set is
 * what the question was about.
 */
const auditCache = new Map<string, AuditClaim[]>();

const auditKey = (photos: string[]): string =>
  photos.map(contentKey).sort().join('|');

/**
 * Empties every cached answer. For tests, and for a user who wants a genuinely
 * fresh read — which means fresh readings AND a fresh audit, since a stale
 * verdict on a group is exactly as unwanted as a stale reading of a photo.
 */
export const clearAttributeCache = (): void => {
  attributeCache.clear();
  auditCache.clear();
};

export const cachedAttributeCount = (): number => attributeCache.size;

// --- parsing -------------------------------------------------------------

/** Pulls the first complete JSON array out of a reply, fences and prose aside. */
export const extractJsonArray = (text: string): unknown[] | null => {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end <= start) return null;

  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

const asView = (value: unknown): ViewName | undefined => {
  if (typeof value !== 'string') return undefined;
  const upper = value.trim().toUpperCase().replace(/[\s_-]+/g, '');
  const direct = VIEW_NAMES.find((v) => v === upper);
  if (direct) return direct;
  if (upper === 'BOTTOM' || upper === 'OUTSOLE') return 'SOLE';
  if (upper === 'SIDE' || upper === 'PROFILE') return 'LEFT';
  if (upper === 'REAR' || upper === 'HEEL') return 'BACK';
  if (upper === 'MACRO' || upper === 'CLOSE') return 'CLOSEUP';
  return undefined;
};

/** One photo's answer: which product it shows, from what angle, and what it shows. */
export interface Placement {
  image: number;
  /** The model's key for the product — its own short label, reused per product. */
  product: string;
  view?: ViewName;
  colour?: string;
  category?: Category;
  /** The structured reading. Absent fields were not visible from this angle. */
  attributes: ImageAttributes;
}

/**
 * Reads the model's reply, dropping only what cannot describe a photo that was
 * sent. A photo the model said nothing about is left for the caller to notice.
 */
export const toPlacements = (entries: unknown[], batchSize: number): Placement[] => {
  const out: Placement[] = [];
  const seen = new Set<number>();

  entries.forEach((entry, position) => {
    if (!entry || typeof entry !== 'object') return;
    const record = entry as Record<string, unknown>;

    let image = position;
    const declared = Number(record.image ?? record.photo ?? record.index);
    if (Number.isInteger(declared)) image = declared;
    if (image < 0 || image >= batchSize || seen.has(image)) return;

    const rawProduct = record.product ?? record.group ?? record.shoe ?? record.item;
    const product = String(rawProduct ?? '').trim();
    if (!product) return;

    const attributes = parseAttributes(record);

    seen.add(image);
    out.push({
      image,
      product: product.toUpperCase(),
      view: asView(record.angle ?? record.view),
      colour: attributes.colour,
      category: attributes.category,
      attributes,
    });
  });

  return out;
};

/**
 * Two readings of one photograph, folded.
 *
 * A photograph in an overlap is asked about in two requests, and the two
 * answers are rarely identical — one may see the SKU, the other may not.
 * Keeping the union rather than picking a winner is the same principle as the
 * fingerprint itself: an absent field is not a contradicting field.
 */
export const mergeReadings = (a: ImageAttributes, b: ImageAttributes): ImageAttributes => {
  const merged: ImageAttributes = { ...b, ...a };

  const details = [...new Set([...(a.details ?? []), ...(b.details ?? [])])];
  if (details.length) merged.details = details;
  else delete merged.details;

  return merged;
};

// --- group bookkeeping ---------------------------------------------------

/** Every image id a grouping currently accounts for. */
export const assignedIds = (groups: ProductGroup[]): Set<string> =>
  new Set(groups.flatMap((g) => g.images.map((i) => i.imageId)));

// --- structured output ---------------------------------------------------

export interface ReportProduct {
  id: string;
  name: string;
  confidence: number;
  needsReview: boolean;
  images: string[];
  fingerprint: ProductFingerprint | null;
}

export interface ClusteringReport {
  totalImages: number;
  totalProducts: number;
  products: ReportProduct[];
  unassignedImages: string[];
}

/**
 * The grouping as data rather than as a screen.
 *
 * The review component reads the live objects; this is for everything else —
 * a log line, a support ticket, a diff between two runs over one folder. It
 * carries the fingerprint each product was actually grouped on, because
 * "product 7 has three photographs" is not reviewable and "product 7 has three
 * photographs, all black leather ankle boots with a block heel and a side
 * zipper" is.
 */
export const toClusteringReport = (
  images: FolderImage[],
  groups: ProductGroup[],
  unassigned: string[]
): ClusteringReport => ({
  totalImages: images.length,
  totalProducts: groups.length,
  products: groups.map((group) => ({
    id: group.id,
    name: group.name,
    confidence: group.confidence,
    needsReview: group.needsReview,
    images: group.images.map((image) => image.imageId),
    fingerprint: group.fingerprint ?? null,
  })),
  unassignedImages: [...unassigned],
});

// --- the prompts ---------------------------------------------------------

/**
 * What is asked of every photograph.
 *
 * Two things about this prompt are load-bearing rather than stylistic.
 *
 * FIRST, it asks for a READING, not a decision. The model says what it can see
 * — heel, sole, toe, material, marks, code — and gives its own short label for
 * which photographs it thinks show one item. The label is a hypothesis that the
 * fingerprint arithmetic can overrule; the reading is the evidence, and the
 * evidence is worth more than the hypothesis because it survives being carried
 * into another request.
 *
 * SECOND, it insists on "unknown". A model asked for twenty fields will fill
 * twenty fields, and a guessed heel type is worse than no heel type: it is a
 * confident wrong signal in the field weighted most heavily. Every instance of
 * "unknown" in an answer is the system working.
 */
const prompt = (batchCount: number): string =>
  `You are cataloguing photographs of products so that photographs of the SAME PHYSICAL ITEM can be grouped.

There are ${batchCount} photograph(s), numbered 0 to ${batchCount - 1} in the order given.

FOR EACH PHOTOGRAPH, REPORT WHAT YOU CAN SEE OF THE WHOLE ITEM.

Different angles show different things, and that is expected. A front view shows the toe and not the heel. A sole view shows the tread and not the toe. A photograph of a label or box shows a code and no product at all. Report what the photograph shows and write "unknown" for everything else.

NEVER GUESS. "unknown" is always a correct answer. A guessed heel type, material or code is worse than no answer, because it will be used as evidence.

DESCRIBE THE ITEM, NOT THE PART FILLING THE FRAME. This matters more than anything else here, because two photographs of one item are matched by comparing these answers, and an answer about the underside will not match an answer about the upper. Three fields where this goes wrong constantly:

- "colour" is the WHOLE ITEM's colourway, MOST DOMINANT FIRST, INCLUDING a contrasting sole or panel. Looking at the underside of a black shoe with a white outsole, the colour is still "black white" — not "white". Never the background, never the surface it is standing on.
  THE ORDER MATTERS AND IS COMPARED. Put first the colour that covers most of the ITEM overall — not the colour that fills most of this particular photograph. A mostly-white trainer is "white black" from every angle, including the one that happens to show its black sole; a mostly-black trainer with a white sole is "black white" from every angle, including the one that happens to show the sole. Two items whose first colour differs are two different products, so getting this order right, and the SAME from every angle, decides whether photographs of one shoe find each other.
- "material" is the material of the UPPER only — the part that covers the foot. NOT the sole. If the photograph cannot see the upper, write "unknown" rather than describing the sole here.
- "soleType" is the OUTSOLE, the part that touches the ground. Judge the whole sole unit consistently: do not call it "foam" from one angle and "rubber" from another.

FIELDS (write "unknown" wherever the photograph does not show it):
- "product": your own short label for the item — "A", "B", "C" — REUSED for every photograph of that same physical item.
- "angle": FRONT, BACK, LEFT, RIGHT, TOP or SOLE; CLOSEUP when the frame is filled by part of the item; OTHER when none fits.
- "category": FOOTWEAR, TOP, BOTTOMS or OTHER.
- "type": what the item is — "ankle_boot", "sneaker", "loafer", "sandal", "knee_boot".
- "colour": as above — the whole item's colourway.
- "secondaryColours": colours present on the item beyond the dominant one.
- "material": as above — the upper. leather, suede, patent, canvas, mesh, knit, synthetic.
- "texture", "finish", "pattern": e.g. "smooth", "matte", "croc-embossed".
- "silhouette": the overall shape — "slim ankle boot", "bulky trainer", "low-top sneaker".
- "heelType": block, stiletto, wedge, kitten, platform, cone, flat.
- "heelHeight": as seen — "7cm", "low", "high".
- "soleType": as above. "soleThickness": thin, medium, thick.
- "toeShape": round, square, pointed, almond, open.
- "shaftHeight": ankle, mid-calf, knee, over-knee — footwear with a shaft only.
- "closure": zipper, laces, buckle, velcro, elastic, slipon.
- "straps": describe them, or "none" if the item plainly has none.
- "stitching": visible stitching that distinguishes the item.

THE COLOUR OF EACH PART — read these carefully, they matter more than any other field:

Two items of the same brand and the same style are usually both "black". What separates them is the colour of their PARTS. Answer each of these with a plain colour word for that part alone, or "unknown" if the photograph does not show that part:

- "soleColour": the colour of the sole unit overall — "white", "gum", "black", "off-white".
- "heelColour": the colour of the UPPER's heel — the back of the shoe ABOVE the sole. Not the sole. A photograph of the underside cannot see this: answer "unknown".
- "soleHeelColour": the colour of the HEEL END OF THE SOLE — the part of the sole unit under the heel. A sole unit is frequently two-tone, black at the front and white at the back or the reverse, and this is one of the most reliable ways to tell two otherwise identical trainers apart. Both the underside AND a side-on photograph can see it, so answer it from either.
- "laceColour": the colour of the laces, or "none" if the item has no laces.
- "logoColour": the colour of the logo or branding.
- "logoPlacement": WHERE the logo sits — "side panel", "heel counter", "tongue", "toe cap", "back of collar".

NOW LOOK INSIDE THE OPENING. From the side or from above you can usually see straight into the shoe, and the inside is very often the only difference between two colourways of one model:

- "liningColour": the colour of the lining — the material you can see INSIDE the shoe through the opening.
- "collarColour": the colour of the padded collar or cuff that runs around the ankle opening.
- "tongueColour": the colour of the tongue.

These are the fields that tell two black trainers apart, so answer them whenever the part is visible and answer "unknown" whenever it is not. Do not repeat the item's overall colour here: if the shoe is black and its sole is white, "soleColour" is "white". Two otherwise identical grey trainers, one lined in white and one lined in black, are TWO DIFFERENT PRODUCTS.
- "logo", "brand": only if legibly visible. NEVER infer a brand from the style.
- "sku": a product code, model number or barcode number, ONLY if you can actually read the characters. Copy them exactly. Do not invent, complete or correct one.
- "size": a size marking, only if legible.
- "details": see below. This is the most important field in the answer.

"details" — WHAT ACTUALLY TELLS TWO ITEMS APART:

An array of the features that would let somebody pick THIS item out of a rack of similar ones from the same brand. Two rules:

  1. BE SPECIFIC. Useless: "black", "leather", "rubber sole", "laces", "stylish", "sporty". Every item in the folder answers to those, so they identify nothing.
     Useful: "white outsole with hexagonal tread", "three white stripes across the side panel", "cat logo low on the heel counter", "red pull tab at the back of the collar", "gum-coloured toe bumper", "perforated toe cap".
  2. BE CONSISTENT. Describe the same feature with the same words whichever angle you see it from, so that two photographs of one item produce matching text. "white outsole with hexagonal tread" seen from the side and from underneath should be written the same way both times.

For footwear the features that separate two models OF THE SAME BRAND are, in order: the COLOUR OF THE SOLE AND OF ITS HEEL END, THE UPPER'S HEEL, THE LACES, THE LOGO AND THE LINING as reported above, the OUTSOLE TREAD PATTERN, the shape and colour of any side stripe or panel, WHERE the logo sits and how big it is, the tongue and heel-tab shape and colour, and any contrast panel or overlay.

WHAT DOES NOT SEPARATE TWO ITEMS: almost every sneaker has a flat heel, a round toe, a rubber sole and laces; almost every dress boot is leather. Report those fields honestly, but never treat them as a reason to call two photographs the same item.

ABOUT THE "product" LABEL:
- A DIFFERENT CAMERA ANGLE IS NOT A DIFFERENT PRODUCT. The front, the back and the underside of one boot look very different and are one product.
- Different lighting, background, distance or rotation is NOT a different product.
- A DIFFERENT COLOURWAY IS A DIFFERENT PRODUCT.
- Two items that differ in heel, toe, sole tread, panelling or construction are DIFFERENT PRODUCTS even if both are black leather from the same brand.
- A product may have any number of photographs. Never aim for a set number.
- You have no filenames and no ordering, and neither would be evidence.

Reply with ONLY a JSON array, one object per photograph, in the order given:
[{"image":0,"product":"A","angle":"SOLE","category":"FOOTWEAR","type":"sneaker","colour":"black white","secondaryColours":"white","material":"unknown","texture":"unknown","finish":"unknown","pattern":"unknown","silhouette":"low-top sneaker","heelType":"flat","heelHeight":"unknown","soleType":"rubber","soleThickness":"medium","toeShape":"unknown","shaftHeight":"unknown","closure":"unknown","straps":"none","stitching":"unknown","soleColour":"white","heelColour":"unknown","soleHeelColour":"white","laceColour":"unknown","logoColour":"unknown","logoPlacement":"unknown","liningColour":"unknown","collarColour":"unknown","tongueColour":"unknown","logo":"unknown","brand":"unknown","sku":"unknown","size":"unknown","details":["white outsole with hexagonal tread","black forefoot flex grooves"]}]
No prose, no code fences.`;

/**
 * The verification prompt: the undecided pairs, and nothing else.
 *
 * It is deliberately not another grouping prompt. Grouping asks an open
 * question over a dozen photographs; this asks a closed one about two items
 * whose readings have already been compared and found neither clearly the same
 * nor clearly different. Asking the narrow question is what makes one request
 * enough for a folder.
 *
 * "unsure" is offered on purpose, and is not a wasted answer: an unsure pair
 * stays two products and goes to the review screen, which is the correct
 * outcome for a pair that neither the arithmetic nor the model can settle.
 */
const consolidatePrompt = (count: number): string =>
  `You are looking at ${count} photographs. Each one represents a DIFFERENT CANDIDATE PRODUCT that has been picked out of one folder — one photograph standing in for each candidate.

The folder was sorted by comparing written descriptions of the photographs, and that has gone as far as it can. Some of these candidates are the SAME PHYSICAL ITEM photographed from another angle, and only looking at them together can say which.

SORT THEM. Give every photograph a letter, and give TWO PHOTOGRAPHS THE SAME LETTER when they show the same physical item.

HOW TO DECIDE:
- A different camera angle, distance, rotation, background or lighting is NOT a different item. The side of a shoe and the underside of the same shoe belong together.
- A different colourway IS a different item.
- A different sole tread, panel shape, stripe, logo placement or construction IS a different item, however alike the rest looks — most of these will be the same brand and the same general style, so those are the things to look at.
- LOOK INSIDE THE OPENING. Two otherwise identical trainers, one lined in white and one lined in black, are two different items. The lining, the padded collar and the tongue are often the whole difference.
- MOST OF THESE ARE GENUINELY DIFFERENT ITEMS. Do not sort them into a handful of large piles. If you are not sure two belong together, give them different letters.
- A letter used by only one photograph is a perfectly good answer, and will be the commonest one.

Reply with ONLY a JSON array, one object per photograph, in the order given:
[{"photo":0,"item":"A"},{"photo":1,"item":"B"},{"photo":2,"item":"A"},{"photo":3,"item":"C"}]
No prose, no code fences.`;

/**
 * The audit prompt: one group's photographs, and the question the rules could
 * not actually answer.
 *
 * Everything upstream compared WORDS. A group arrives here because a chain of
 * arithmetic on written descriptions said its photographs belong together, and
 * that arithmetic has a known failure: in a folder of near-identical items the
 * descriptions converge, the vocabulary weighting runs out of distinctive
 * words, and two different shoes read the same. No further rule fixes that,
 * because the information needed to separate them was discarded at the moment
 * the photograph became a paragraph.
 *
 * So this prompt does the one thing no rule can. It puts the photographs back
 * in front of the model, together, and tells it plainly that what grouped them
 * was mechanical and is allowed to be wrong.
 *
 * It asks for a LETTER PER PHOTOGRAPH rather than a yes/no, because "no" is not
 * an actionable answer: a group holding two products has to say WHICH
 * photographs are the second one before anything can be done about it. All-"A"
 * is the confirmation, and is expected to be the commonest reply.
 *
 * It also asks what settled it. That sentence goes on the review screen next to
 * the photograph, which is the difference between "this was split" and "this
 * was split because the outsole tread is different".
 */
const auditPrompt = (count: number): string =>
  `These ${count} photographs were pre-grouped by deterministic visual rules as ONE product. Those rules compared written descriptions of each photograph separately and never saw the photographs together, so they can be wrong.

RE-EXAMINE THEM TOGETHER AND DETERMINE WHETHER THEY DEPICT THE SAME PHYSICAL PRODUCT FROM DIFFERENT VIEWPOINTS.

The photographs are numbered 0 to ${count - 1} in the order given.

WHAT IS THE SAME ITEM:
- A different camera angle, distance, rotation, crop, background or lighting is NOT a different product. The side of a shoe, its back and its underside are one shoe and look nothing alike.
- A close-up of part of an item belongs with the item it is part of.
- Wear, dust, creasing or a different surface underneath does not make a second item.

WHAT IS A DIFFERENT ITEM — these are the pairs the rules get wrong, so look at them first:
- A different COLOURWAY is a different product, even in the same model and the same size.
- A different SOLE TREAD, or a sole unit coloured differently at the heel end.
- A different STRIPE, PANEL or OVERLAY shape.
- A different LOGO, or the same logo in a different place or a different size.
- LOOK INSIDE THE OPENING. Two otherwise identical trainers, one lined in white and one lined in black, are two different items. The lining, the padded collar and the tongue are frequently the whole difference.
- A different lace colour, heel tab, eyelet count or toe bumper.

Most of these groups really are one product. Do not go looking for a split that is not there. But where two items have been put together, say so — a group that is quietly wrong is worse than one that is marked.

GIVE EVERY PHOTOGRAPH A LETTER. Two photographs get the SAME letter when they show the same physical item. If all of them are one item, every photograph gets "A".

For each photograph also give "because": the FEATURE you actually looked at, in a few words. Not "same shoe" — name the thing: "white outsole, black heel tab", "grey lining, others are black", "logo on the side panel not the tongue".

Reply with ONLY a JSON array, one object per photograph, in the order given:
[{"photo":0,"item":"A","because":"black upper, white outsole with hexagonal tread"},{"photo":1,"item":"A","because":"same hexagonal tread from underneath"},{"photo":2,"item":"B","because":"gum sole, not white"}]
No prose, no code fences.`;

/** One photograph's place in an audit's answer. */
export interface AuditClaim {
  /** Position in the order the photographs were sent. */
  photo: number;
  /** The model's letter for the item it shows. */
  item: string;
  /** The feature it says settled that, for the review screen. */
  because?: string;
}

/**
 * Reads an audit reply, keeping only claims that name a photograph that was
 * actually sent.
 *
 * Deliberately strict about the key. `product` and `group` are what the BATCH
 * prompt answers with and `item` is what this one asks for; accepting all three
 * means a reply meant for another question can be read as an answer to this
 * one, and here that would split a group on a misrouted response.
 */
export const readAudit = (entries: unknown[], count: number): AuditClaim[] => {
  const claims: AuditClaim[] = [];
  const seen = new Set<number>();

  entries.forEach((entry, position) => {
    if (!entry || typeof entry !== 'object') return;
    const record = entry as Record<string, unknown>;

    const declared = Number(record.photo ?? record.image ?? record.index);
    const photo = Number.isInteger(declared) ? declared : position;
    if (photo < 0 || photo >= count || seen.has(photo)) return;

    const item = String(record.item ?? '').trim().toUpperCase();
    if (!item) return;

    const because = normaliseAttribute(record.because ?? record.reason ?? record.why);

    seen.add(photo);
    claims.push({ photo, item, because });
  });

  return claims;
};

/**
 * Turns an audit's letters into groups.
 *
 * THE MODEL'S ANSWER IS FINAL HERE, and that asymmetry is the point rather than
 * an oversight. Consolidation lets the fingerprint arithmetic overrule a merge,
 * because a wrong merge renders one shoe wearing another shoe's sole and
 * nothing downstream catches it. A wrong SPLIT costs one click on the review
 * screen. So the vetoes that guard merges are not applied to splits: the model
 * looked at the photographs, the arithmetic looked at words about them, and on
 * the cheap side of the trade the eyes win.
 *
 * The largest letter keeps the original group, so a group the model confirms —
 * or one where it peels off a single stray — is not renamed out from under a
 * user who has already labelled it.
 *
 * Photographs the model skipped stay where they are. A missing answer is not a
 * verdict, and moving a photograph on the strength of one would be inventing
 * evidence at exactly the point this pass exists to stop that.
 */
export const applyAudit = (
  groups: ProductGroup[],
  claims: AuditClaim[],
  /** Image ids in the order they were sent, so a claim's number means something. */
  order: string[]
): { groups: ProductGroup[]; splits: number; reasons: Map<string, string> } => {
  const reasons = new Map<string, string>();

  claims.forEach((claim) => {
    const imageId = order[claim.photo];
    if (imageId && claim.because) reasons.set(imageId, claim.because);
  });

  /** Letter -> the photographs the model gave it. */
  const byLetter = new Map<string, string[]>();
  claims.forEach((claim) => {
    const imageId = order[claim.photo];
    if (!imageId) return;
    const held = byLetter.get(claim.item);
    if (held) held.push(imageId);
    else byLetter.set(claim.item, [imageId]);
  });

  // One letter — or none read — is the model confirming the group. That is the
  // expected answer and it changes nothing but the reasons.
  if (byLetter.size < 2) return { groups, splits: 0, reasons };

  // Biggest first: it keeps the original group's id and name.
  const letters = [...byLetter.entries()].sort((a, b) => b[1].length - a[1].length);

  let next = groups;
  let splits = 0;

  letters.slice(1).forEach(([, imageIds]) => {
    // The group has been renumbered by every split before this one, so it is
    // found again by a photograph it still holds rather than by the id it had.
    const anchor = imageIds.find((imageId) =>
      next.some((group) => group.images.some((image) => image.imageId === imageId))
    );
    if (!anchor) return;

    const source = next.find((group) => group.images.some((image) => image.imageId === anchor));
    if (!source) return;

    const after = splitGroup(next, source.id, imageIds);
    if (after !== next) {
      next = after;
      splits += 1;
    }
  });

  return { groups: next, splits, reasons };
};

/**
 * The photographs of a group to put in its audit request.
 *
 * One per view first, so a group of eight photographs where six are near-
 * identical profiles does not spend its whole request on the profiles and
 * arrive without the sole — which is the photograph most likely to be the
 * second product. Only then the remainder, in order.
 */
export const auditSelection = (
  images: GroupedImage[],
  limit: number = MAX_AUDIT_IMAGES
): GroupedImage[] => {
  const chosen: GroupedImage[] = [];
  const takenViews = new Set<ViewName>();

  images.forEach((image) => {
    if (chosen.length >= limit || takenViews.has(image.view)) return;
    takenViews.add(image.view);
    chosen.push(image);
  });

  images.forEach((image) => {
    if (chosen.length >= limit || chosen.includes(image)) return;
    chosen.push(image);
  });

  return chosen;
};

// --- the run -------------------------------------------------------------

const describeError = (err: unknown): string => {
  const message = String((err as any)?.message ?? err);
  const lower = message.toLowerCase();

  if (lower.includes('429') || lower.includes('resource_exhausted') || lower.includes('quota')) {
    return `The quota is exhausted. (${message})`;
  }
  if (lower.includes('403') || lower.includes('permission') || lower.includes('api key')) {
    return `The API key was refused. (${message})`;
  }
  // A 400 from Gemini is almost always the SHAPE of the request rather than
  // anything about the photographs, and its message — "Request contains an
  // invalid argument" — names nothing at all. The candidates are short and
  // worth listing, because without them this is untraceable from the screen.
  if (lower.includes('400') || lower.includes('invalid_argument')) {
    return (
      `'${analysisModel()}' refused the request as malformed. This is the shape of the ` +
      `request, not the photos. The usual cause is an option the configured model does ` +
      `not accept: add ?schema=off to the address to send without a response schema, ` +
      `which is the most common one. (${message})`
    );
  }
  if (lower.includes('404') || lower.includes('not found')) {
    return (
      `The analysis model '${analysisModel()}' was not available. Nothing else was tried — ` +
      `there is no fallback model by design. The photos are unsorted. (${message})`
    );
  }
  // An abort is this app's own ceiling firing, and the browser words it as
  // 'signal is aborted without reason' — which reads like a defect rather than
  // a timeout, and names neither the model that was too slow nor the limit it
  // passed. All three belong in the sentence.
  if (lower.includes('abort') || lower.includes('timed out') || lower.includes('timeout')) {
    return (
      `'${analysisModel()}' did not answer within ` +
      `${Math.round(analysisTimeoutMs() / 1000)}s, so the request was stopped. ` +
      `The photos are unsorted; no render quota was spent. ` +
      `A smaller folder, or the other provider, will usually go through.`
    );
  }
  return message;
};

/** One request's answer, kept per bundle rather than per position. */
interface BatchOutcome {
  /** Position of this request in the chain, so results stay in a stable order. */
  index: number;
  /** Bundles this request asked about, in the order they were sent. */
  bundles: number[];
  /** What the model said about each of them. Missing means it skipped one. */
  answers: Map<number, Placement>;
  /** Set when the reply could not be used at all. */
  failure?: { error: string; rawReply?: string };
  /** True when this outcome came out of the cache and cost no request. */
  fromCache?: boolean;
}

/** A product as it stands within one request, before requests are joined. */
interface LocalGroup {
  bundles: number[];
  readings: ImageAttributes[];
  views: (ViewName | undefined)[];
  colour?: string;
  category?: Category;
  flagged: boolean;
}

/**
 * Turns one request's answer into products.
 *
 * The model's label is taken as a hypothesis and checked against the group it
 * would join. Where the accumulated fingerprint says the two are DIFFERENT
 * products — two disagreeing structural facts, a colourway that cannot be the
 * same one, two different codes — the label is overruled and the photograph
 * starts a product of its own, flagged.
 *
 * The asymmetry is on purpose: only "different" overrules the model. An
 * "uncertain" comparison lets the label stand, because the model looked at the
 * photographs and the arithmetic only looked at words about them.
 */
const localGroupsOf = (
  outcome: BatchOutcome,
  fileNameOf: (bundle: number) => string,
  log: string[],
  vocabulary?: FolderVocabulary
): LocalGroup[] => {
  const groups: LocalGroup[] = [];
  const labelToGroup = new Map<string, number>();

  outcome.bundles.forEach((bundle) => {
    const answer = outcome.answers.get(bundle);

    const start = (label: string, flagged: boolean) => {
      groups.push({
        bundles: [bundle],
        readings: answer ? [answer.attributes] : [],
        views: [answer?.view],
        colour: answer?.colour,
        category: answer?.category,
        flagged,
      });
      if (label) labelToGroup.set(label, groups.length - 1);
    };

    // The model skipped this photo. Its own product is the honest answer, and
    // the review screen flags it.
    if (!answer) {
      start('', true);
      return;
    }

    const index = labelToGroup.get(answer.product);

    if (index !== undefined) {
      const soFar = aggregateFingerprint(groups[index].readings);
      const verdict = compare(soFar, answer.attributes, vocabulary);

      // A verdict of "different" is the obvious refusal. A SINGLE structural
      // disagreement is the less obvious one, and it is the one that matters:
      // asked to compare two candidate products, one disagreeing physical fact
      // is honestly ambiguous, but here the group is being BUILT, and the
      // fingerprint it produces is what every later comparison reads. A block
      // heel absorbed into a stiletto's group does not just misplace one
      // photograph — it poisons the identity of the product, and the next
      // photograph is measured against the corruption.
      //
      // Nothing is lost by refusing. The photograph starts its own candidate,
      // flagged; if the two really are one product, the identity join or the
      // verification request puts them back together on better evidence than
      // "the model used the same letter for both".
      //
      // The third refusal is the angle, and it does most of the work.
      //
      // A shoot takes ONE sole photograph per shoe, one from the back, one
      // from each side. So a second sole is a second shoe however completely
      // the two readings agree — and two sole photographs of two black
      // trainers agree completely, because a sole photograph of a black
      // trainer describes a black trainer whichever black trainer it is.
      //
      // This replaced a heuristic that refused when the photograph and the
      // group had each named distinctive marks and none of them matched. That
      // rule existed for one case — a top-down photograph of a stiletto boot
      // absorbed into a block-heeled boot's group — and the angle test catches
      // that case directly, because the group already had a top-down
      // photograph. The heuristic meanwhile split legitimate products, since
      // three close-ups of one shoe name three different things and are still
      // one shoe. A rule that follows from how the photographs were taken
      // beats a rule inferred from how they were described.
      const clash = clashingViews(groups[index].views, [answer.view]);

      if (clash.length) {
        log.push(
          `${fileNameOf(bundle)}: the product already has a ${clash[0]} photograph, ` +
            `and a product has only one — kept separate.`
        );
        start('', true);
        return;
      }

      // THREE judgements disagreeing, not two.
      //
      // Two was the rule, on the reasoning that a group being BUILT should be
      // protected more than two finished candidates being compared, because a
      // photograph absorbed wrongly poisons the fingerprint every later
      // comparison reads. That reasoning still holds. What was wrong was the
      // number, because `pattern` and `texture` reach it BETWEEN TWO HONEST
      // READINGS OF ONE SHOE: neither field is anchored to a part, so a profile
      // describes the upper ("mesh-textured", "textured") and a sole shot
      // describes the outsole ("cat-shaped traction lugs", "treaded"), and
      // those two count as the two conflicts that refuse the photograph.
      //
      // On a folder of a hundred and ten trainers that pair alone split
      // products repeatedly. At three, the fields that disagree because they
      // describe different PARTS can no longer refuse on their own, while a
      // knit upper against a mesh one — which disagrees on material, pattern
      // and texture together — still does.
      if (
        verdict.verdict === 'different' ||
        verdict.structuralConflicts > 0 ||
        verdict.softConflicts >= 3
      ) {
        log.push(
          verdict.decisive === 'colour'
            ? `${fileNameOf(bundle)}: kept out of a product of another colour — "${answer.colour}" vs "${groups[index].colour}"`
            : `${fileNameOf(bundle)}: the model called it one product with the others, but ` +
              `${verdict.conflicts.slice(0, 2).join('; ')} — kept separate.`
        );
        start('', true);
        return;
      }

      groups[index].bundles.push(bundle);
      groups[index].readings.push(answer.attributes);
      groups[index].views.push(answer.view);
      groups[index].colour = groups[index].colour ?? answer.colour;
      if (!groups[index].category || groups[index].category === 'OTHER') {
        groups[index].category = answer.category ?? groups[index].category;
      }
      return;
    }

    start(answer.product, false);
  });

  return groups;
};

/** Union-find over `${request}:${localGroup}` keys. */
const joiner = () => {
  const parent = new Map<string, string>();

  const find = (key: string): string => {
    let root = parent.get(key) ?? key;
    if (!parent.has(key)) parent.set(key, key);
    while (root !== parent.get(root)) root = parent.get(root)!;
    parent.set(key, root);
    return root;
  };

  return {
    find,
    union: (a: string, b: string) => {
      const rootA = find(a);
      const rootB = find(b);
      if (rootA !== rootB) parent.set(rootB, rootA);
    },
  };
};

export async function groupFolder(
  images: FolderImage[],
  onProgress?: (progress: GroupingProgress) => void,
  shouldStop?: () => boolean,
  /** Called with the products found so far, after every request that lands. */
  onGroups?: (groups: ProductGroup[]) => void
): Promise<GroupingResult> {
  const log: string[] = [];

  if (!images.length) return { groups: [], unassigned: [], classified: true, log };

  const ai = new GoogleGenAI({
    apiKey: 'proxied',
    httpOptions: { baseUrl: `${window.location.origin}/api/gemini` },
  });

  const textOf = (res: any): string =>
    (res?.candidates?.[0]?.content?.parts ?? [])
      .map((part: any) => part.text ?? '')
      .join('');

  let requestsSent = 0;

  const ask = async (parts: any[]): Promise<string> => {
    requestsSent += 1;
    const text = textOf(await askAnalysisModel(ai, parts));

    if (!text.trim()) throw new Error(`'${analysisModel()}' answered with no text`);
    return text;
  };

  // --- the local pass, before anything is sent ---------------------------
  //
  // Fingerprints cost no request and no quota. They collapse repeated frames,
  // and they order the folder so each request holds photos that plausibly
  // belong together — which is what lets the requests run at the same time
  // instead of each waiting to be told what the one before it found.
  //
  // Nothing decided here survives into the grouping. The order affects only
  // which photographs share a request; identity is decided from the readings.

  const signatures = await mapWithConcurrency(images, 6, (image) =>
    signatureOf(image.scout || image.thumb)
  );
  const bundles = bundleDuplicates(signatures);
  const chain = chainBundles(bundles, signatures);
  const runs = cutBatches(chain, BATCH_SIZE);

  const collapsed = images.length - bundles.length;
  if (collapsed > 0) log.push(`${collapsed} repeated frame(s) collapsed before asking.`);

  /** Chain position of each bundle, so photos come out in a sensible order. */
  const chainPosition = new Map(chain.order.map((bundle, i) => [bundle, i]));
  const repOf = (bundle: number) => images[bundles[bundle][0]];
  const keyOf = (bundle: number) => contentKey(repOf(bundle).scout || repOf(bundle).thumb);

  // Each request repeats the last few bundles of the one before it. Those
  // overlaps are what joins products that fall across a boundary, and they
  // cost two photographs rather than a second pass over the folder.
  const requests = runs.map((run, i) =>
    i === 0 ? run : [...runs[i - 1].slice(-OVERLAP), ...run]
  );

  /**
   * A request answered entirely out of the cache.
   *
   * Every photograph in it has been read before, so there is nothing to ask.
   * The product labels are rebuilt locally by comparing the cached readings
   * against each other — the same arithmetic that adjudicates everywhere else,
   * so a cached batch and a fresh one are grouped by the same rules.
   */
  const fromCache = (index: number): BatchOutcome | null => {
    const asked = requests[index];
    const readings = asked.map((bundle) => attributeCache.get(keyOf(bundle)));
    if (readings.some((reading) => !reading)) return null;

    const answers = new Map<number, Placement>();
    const labelled: { label: string; readings: ImageAttributes[] }[] = [];

    asked.forEach((bundle, position) => {
      const { attributes, view } = readings[position]!;

      let label = '';
      for (const candidate of labelled) {
        if (compare(aggregateFingerprint(candidate.readings), attributes).verdict === 'same') {
          label = candidate.label;
          candidate.readings.push(attributes);
          break;
        }
      }
      if (!label) {
        label = String.fromCharCode(65 + labelled.length);
        labelled.push({ label, readings: [attributes] });
      }

      answers.set(bundle, {
        image: position,
        product: label,
        view,
        colour: attributes.colour,
        category: attributes.category,
        attributes,
      });
    });

    return { index, bundles: asked, answers, fromCache: true };
  };

  const send = async (index: number): Promise<BatchOutcome> => {
    const cached = fromCache(index);
    if (cached) return cached;

    const asked = requests[index];
    const parts: any[] = [];

    asked.forEach((bundle) => {
      const image = repOf(bundle);
      // The scout copy, not the thumbnail: half the bytes on the wire for a
      // judgement that is about construction and colourway.
      parts.push({ inlineData: { mimeType: 'image/jpeg', data: image.scout || image.thumb } });
    });
    parts.push({ text: prompt(asked.length) });

    const reply = await ask(parts);
    const entries = extractJsonArray(reply);

    if (!entries) {
      return {
        index,
        bundles: asked,
        answers: new Map(),
        failure: {
          error: 'The model did not answer with a grouping.',
          rawReply: reply.slice(0, 1500) || '(the reply contained no text at all)',
        },
      };
    }

    const placements = toPlacements(entries, asked.length);

    if (!placements.length) {
      return {
        index,
        bundles: asked,
        answers: new Map(),
        failure: {
          error: 'The model answered, but named no products.',
          rawReply: reply.slice(0, 1500),
        },
      };
    }

    // Paid for once. A photograph in an overlap is read twice by design, and
    // the two readings are folded rather than one replacing the other.
    placements.forEach((placement) => {
      const bundle = asked[placement.image];
      const key = keyOf(bundle);
      const held = attributeCache.get(key);
      attributeCache.set(key, {
        attributes: held
          ? mergeReadings(held.attributes, placement.attributes)
          : placement.attributes,
        view: placement.view ?? held?.view,
      });
    });

    return {
      index,
      bundles: asked,
      answers: new Map(placements.map((p) => [asked[p.image], p])),
    };
  };

  // --- joining the answers ------------------------------------------------

  const photosOf = (bundle: number) => bundles[bundle];
  const fileNameOf = (bundle: number) => repOf(bundle).fileName;

  /**
   * Builds the products from whatever requests have landed.
   *
   * Called after every request so the screen fills in as the folder is read,
   * and once more at the end. It is a pure fold over the outcomes, so a later
   * request never has to undo what an earlier one decided.
   *
   * `forcedMerges` carries the pairs a verification request confirmed, as
   * image-id pairs rather than internal keys, because the internal keys are
   * rebuilt on every call and only the photographs are stable.
   */
  const assemble = (
    outcomes: BatchOutcome[],
    into: string[],
    forcedMerges: [string, string][] = []
  ): ProductGroup[] => {
    const usable = outcomes.filter((outcome) => !outcome.failure);
    const link = joiner();

    // What this folder looks like, measured before anything is decided about
    // it. Every judgement below about whether an agreement IDENTIFIES anything
    // is made against this: "PUMA" is worthless in a folder of PUMA, "flat
    // heel" is worthless in a folder of trainers, and a word only two readings
    // used is worth more than any of them.
    const vocabulary = buildVocabulary(
      usable.flatMap((outcome) =>
        [...outcome.answers.values()].map((placement) => placement.attributes)
      )
    );

    const perRequest = usable.map((outcome) =>
      localGroupsOf(outcome, fileNameOf, into, vocabulary)
    );

    /** Which key each bundle landed in, per request. */
    const keysOfBundle = new Map<number, string[]>();

    usable.forEach((outcome, r) => {
      perRequest[r].forEach((group, g) => {
        const key = `${outcome.index}:${g}`;
        link.find(key);
        group.bundles.forEach((bundle) => {
          const keys = keysOfBundle.get(bundle);
          if (keys) keys.push(key);
          else keysOfBundle.set(bundle, [key]);
        });
      });
    });

    const colourOfKey = new Map<string, string | undefined>();
    const categoryOfKey = new Map<string, Category | undefined>();
    const flaggedKeys = new Set<string>();

    usable.forEach((outcome, r) => {
      perRequest[r].forEach((group, g) => {
        const key = `${outcome.index}:${g}`;
        colourOfKey.set(key, group.colour);
        categoryOfKey.set(key, group.category);
        if (group.flagged) flaggedKeys.add(key);
      });
    });

    // A bundle two requests both saw is the same product in both of them. This
    // is the strongest join there is — the same photograph, not a judgement
    // about two of them — so it runs before anything else.
    keysOfBundle.forEach((keys) => {
      for (let i = 1; i < keys.length; i += 1) link.union(keys[0], keys[i]);
    });

    /** Every reading a bundle has, from every request that saw it. */
    const readingOf = (bundle: number): ImageAttributes => {
      const seen = usable
        .map((outcome) => outcome.answers.get(bundle)?.attributes)
        .filter((attributes): attributes is ImageAttributes => !!attributes);
      return seen.reduce<ImageAttributes>((acc, attributes) => mergeReadings(acc, attributes), {});
    };

    /**
     * Which bundles sit under each root, and the identity they add up to,
     * maintained AS THE JOINS HAPPEN rather than rebuilt for every candidate.
     *
     * Each join below re-checks its candidate against what the two sides have
     * GROWN into, because an earlier merge can change the answer. Rebuilding
     * the whole map to answer that turns a quadratic pass into a cubic one,
     * which on a folder of a hundred and ten photographs is the difference
     * between imperceptible and a visible stall — and this runs again on every
     * request that lands, not once at the end.
     */
    const membersOfRoot = new Map<string, number[]>();
    keysOfBundle.forEach((keys, bundle) => {
      const root = link.find(keys[0]);
      const list = membersOfRoot.get(root);
      if (list) list.push(bundle);
      else membersOfRoot.set(root, [bundle]);
    });

    /**
     * The angle each bundle shows, so a merge can be refused for holding two
     * of one. Read from whichever request named an angle for it.
     */
    const viewOfBundle = (bundle: number): ViewName | undefined =>
      usable.map((outcome) => outcome.answers.get(bundle)?.view).find(Boolean);

    /** True when joining these two would give one product two of an angle. */
    const anglesClash = (rootA: string, rootB: string): ViewName[] =>
      clashingViews(
        (membersOfRoot.get(rootA) ?? []).map(viewOfBundle),
        (membersOfRoot.get(rootB) ?? []).map(viewOfBundle)
      );

    const fingerprints = new Map<string, ProductFingerprint>();

    /** The identity of everything currently joined under one root. */
    const fingerprintOf = (root: string): ProductFingerprint => {
      const held = fingerprints.get(root);
      if (held) return held;
      const built = aggregateFingerprint((membersOfRoot.get(root) ?? []).map(readingOf));
      fingerprints.set(root, built);
      return built;
    };

    /** Joins two roots, keeping the membership and the identities in step. */
    const join = (a: string, b: string): boolean => {
      const rootA = link.find(a);
      const rootB = link.find(b);
      if (rootA === rootB) return false;

      link.union(rootA, rootB);

      const winner = link.find(rootA);
      const loser = winner === rootA ? rootB : rootA;

      membersOfRoot.set(winner, [
        ...(membersOfRoot.get(winner) ?? []),
        ...(membersOfRoot.get(loser) ?? []),
      ]);
      membersOfRoot.delete(loser);
      fingerprints.delete(winner);
      fingerprints.delete(loser);
      return true;
    };

    // --- join 1: identity ------------------------------------------------
    //
    // The join that makes different angles work. Two candidates whose folded
    // readings say the same physical item ARE the same physical item, however
    // far apart their pixels are — a front shot and a sole shot of one boot
    // share almost no pixels and every structural fact.
    //
    // Free: it compares words already paid for, and never sends anything. The
    // pair count is quadratic in the number of candidates, which for a folder
    // of a hundred and ten photographs is a few thousand comparisons of small
    // objects — microseconds, and no request at any size.
    {
      const keys = [...membersOfRoot.keys()];
      const pairs: { a: string; b: string; score: number; decisive?: string }[] = [];

      for (let i = 0; i < keys.length; i += 1) {
        for (let j = i + 1; j < keys.length; j += 1) {
          const verdict = compare(fingerprintOf(keys[i]), fingerprintOf(keys[j]), vocabulary);
          if (verdict.verdict === 'same') {
            pairs.push({ a: keys[i], b: keys[j], score: verdict.score, decisive: verdict.decisive });
          }
        }
      }

      // A matching code first, then the best-evidenced matches, so a chain of
      // merges cannot start from its weakest link.
      pairs.sort((x, y) => {
        if ((x.decisive === 'sku') !== (y.decisive === 'sku')) return x.decisive === 'sku' ? -1 : 1;
        return y.score - x.score;
      });

      pairs.forEach(({ a, b, decisive }) => {
        const rootA = link.find(a);
        const rootB = link.find(b);
        if (rootA === rootB) return;
        // Re-checked against what the two roots have GROWN into: an earlier
        // merge may have added a photograph that changes the answer.
        const settled = compare(fingerprintOf(rootA), fingerprintOf(rootB), vocabulary);
        if (settled.verdict !== 'same') return;

        // Two photographs of one angle are two items, and NOTHING overrides
        // that — a matching product code included.
        //
        // The code used to be allowed to win, on the reasoning that an
        // identifier outranks an inference. It does not, here: the angle rule
        // follows from how the photographs were taken and is near-certain,
        // while a code is a model READING of a few characters and can be
        // wrong. Two units of one model photographed separately are still two
        // sets of photographs, and merging them on a shared code produces a
        // product with two soles — which is exactly the shape of the mistake
        // this rule exists to catch.
        const clash = anglesClash(rootA, rootB);
        if (clash.length) {
          into.push(
            `Two groups describe one product but both hold a ${clash[0]} photograph, ` +
              `and a product has only one — left apart.`
          );
          return;
        }

        if (!join(rootA, rootB)) return;

        into.push(
          decisive === 'sku'
            ? 'Joined two groups by a matching product code.'
            : 'Joined two groups whose visible attributes describe one product.'
        );
      });
    }

    // --- join 2: a verified pair -----------------------------------------
    //
    // Pairs a verification request confirmed. Applied by photograph, because
    // the roots these were computed against no longer exist by name.
    forcedMerges.forEach(([leftImage, rightImage]) => {
      const bundleOf = (imageId: string) =>
        [...keysOfBundle.keys()].find((bundle) =>
          photosOf(bundle).some((photo) => images[photo].id === imageId)
        );

      const left = bundleOf(leftImage);
      const right = bundleOf(rightImage);
      if (left === undefined || right === undefined) return;

      const a = keysOfBundle.get(left)![0];
      const b = keysOfBundle.get(right)![0];

      const rootA = link.find(a);
      const rootB = link.find(b);
      if (rootA === rootB) return;

      // The model sorted these together looking at them side by side, and it
      // is still not allowed to give one product two soles.
      const clash = anglesClash(rootA, rootB);
      if (clash.length) {
        into.push(
          `The model sorted two groups together, but both hold a ${clash[0]} photograph — left apart.`
        );
        return;
      }

      if (!join(rootA, rootB)) return;

      into.push('Joined two groups the model confirmed are one product when asked directly.');
    });

    // --- join 3: appearance ----------------------------------------------
    //
    // Pixels rejoin what is left, for the case the readings could not settle:
    // the model split a product across requests, and neither an overlap nor
    // the attributes said so. The bar is read off this folder's own groups,
    // and the identity comparison still holds the veto — a split is cheap to
    // fix by hand, a merge of two products poisons every render made from it.
    {
      const distanceOf = (a: number, b: number) =>
        visualDistance(signatures[photosOf(a)[0]], signatures[photosOf(b)[0]]);

      const within: number[] = [];
      membersOfRoot.forEach((list) => {
        for (let i = 0; i < list.length; i += 1) {
          for (let j = i + 1; j < list.length; j += 1) within.push(distanceOf(list[i], list[j]));
        }
      });

      const limit = lookalikeLimit(within);
      const keys = [...membersOfRoot.keys()];
      const candidates: { a: string; b: string; distance: number }[] = [];

      for (let i = 0; i < keys.length; i += 1) {
        for (let j = i + 1; j < keys.length; j += 1) {
          const left = membersOfRoot.get(keys[i])!;
          const right = membersOfRoot.get(keys[j])!;

          let closest = Infinity;
          left.forEach((a) => right.forEach((b) => {
            const d = distanceOf(a, b);
            if (d < closest) closest = d;
          }));

          if (closest <= limit) candidates.push({ a: keys[i], b: keys[j], distance: closest });
        }
      }

      candidates.sort((x, y) => x.distance - y.distance);

      candidates.forEach(({ a, b, distance }) => {
        const rootA = link.find(a);
        const rootB = link.find(b);
        if (rootA === rootB) return;

        // Looking alike is never enough on its own. The identity comparison
        // has to actively not object — this is what stops two black boots with
        // different heels from being merged because they photograph similarly.
        // One disagreeing physical fact is an objection: two products that
        // look this alike are exactly the pair a heel or a toe tells apart.
        const verdict = compare(fingerprintOf(rootA), fingerprintOf(rootB), vocabulary);
        if (verdict.verdict === 'different' || verdict.structuralConflicts > 0) return;
        if (anglesClash(rootA, rootB).length) return;
        if (!join(rootA, rootB)) return;

        into.push(
          `Rejoined two groups that look like one product (${distance.toFixed(2)} apart, limit ${limit.toFixed(2)}).`
        );
      });
    }

    // --- components, in chain order ---------------------------------------

    const members = new Map<string, Set<number>>();
    keysOfBundle.forEach((keys, bundle) => {
      const root = link.find(keys[0]);
      const set = members.get(root);
      if (set) set.add(bundle);
      else members.set(root, new Set([bundle]));
    });

    const componentRoots = [...members.keys()].sort((a, b) => {
      const first = (root: string) =>
        Math.min(...[...members.get(root)!].map((bundle) => chainPosition.get(bundle) ?? 0));
      return first(a) - first(b);
    });

    const answerFor = (bundle: number): Placement | undefined => {
      // A bundle in an overlap was asked about twice; the answer that names an
      // angle is the more useful of the two.
      const seen = usable
        .map((outcome) => outcome.answers.get(bundle))
        .filter((p): p is Placement => !!p);
      return seen.find((p) => p.view) ?? seen[0];
    };

    return renumber(
      componentRoots.map((root, i) => {
        const owned = [...members.get(root)!].sort(
          (a, b) => (chainPosition.get(a) ?? 0) - (chainPosition.get(b) ?? 0)
        );

        const keys = new Set<string>();
        owned.forEach((bundle) =>
          (keysOfBundle.get(bundle) ?? []).forEach((key) => keys.add(key))
        );

        const entries: GroupedImage[] = [];
        owned.forEach((bundle) => {
          const answer = answerFor(bundle);
          const attributes = readingOf(bundle);
          photosOf(bundle).forEach((photo) => {
            entries.push({
              imageId: images[photo].id,
              view: answer?.view ?? 'OTHER',
              viewSource: answer?.view ? 'model' : 'fallback',
              colour: attributes.colour,
              attributes,
              reason: describeFingerprint(aggregateFingerprint([attributes])) || undefined,
            });
          });
        });

        const category =
          [...keys].map((key) => categoryOfKey.get(key)).find((c) => c && c !== 'OTHER') ??
          'OTHER';

        return summarise({
          id: `product-${i + 1}`,
          name: groupLabel(i),
          category,
          colour: [...keys].map((key) => colourOfKey.get(key)).find(Boolean),
          images: entries,
          confidence: 0.5,
          needsReview: false,
          flagged: [...keys].some((key) => flaggedKeys.has(key)),
        });
      })
    );
  };

  // --- running the requests, several at a time ----------------------------

  const outcomes: BatchOutcome[] = [];
  const skipped: number[] = [];
  let stopped = false;
  let fatal = false;
  let hardError: string | null = null;
  let next = 0;

  const photosIn = (index: number) =>
    runs[index].reduce((sum, bundle) => sum + photosOf(bundle).length, 0);

  let sorted = 0;

  const report = () => {
    onProgress?.({
      done: Math.min(sorted, images.length),
      total: images.length,
      phase: 'assigning',
    });
    // A throwaway log: the run's own log is written once, at the end, so a
    // line is not repeated every time the screen is refreshed.
    onGroups?.(assemble(outcomes, []));
  };

  const runOne = async (index: number) => {
    try {
      const outcome = await send(index);
      outcomes.push(outcome);
      sorted += photosIn(index);
      report();
    } catch (err) {
      // A spent quota or a refused key fails every other request too; the
      // workers stop rather than spending the rest of the folder proving it.
      fatal = true;
      throw err;
    }
  };

  try {
    onProgress?.({ done: 0, total: images.length, phase: 'assigning' });

    // The first request goes alone, so the others do not each rediscover which
    // model answers. After that they overlap, which is the whole point.
    if (!shouldStop?.()) {
      next = 1;
      await runOne(0);
    } else {
      stopped = true;
    }

    const worker = async () => {
      for (;;) {
        if (stopped || fatal) return;
        if (shouldStop?.()) {
          stopped = true;
          return;
        }
        const index = next;
        next += 1;
        if (index >= requests.length) return;
        await runOne(index);
      }
    };

    // Settled rather than raced, so a second failure cannot surface as an
    // unhandled rejection after the first has already been reported.
    const settled = await Promise.allSettled(
      Array.from({ length: Math.min(CONCURRENCY, Math.max(1, requests.length - 1)) }, worker)
    );
    const broke = settled.find((result) => result.status === 'rejected');
    if (broke) throw (broke as PromiseRejectedResult).reason;

    if (stopped) {
      for (let index = 0; index < requests.length; index += 1) {
        if (!outcomes.some((outcome) => outcome.index === index)) skipped.push(index);
      }
    }
  } catch (err) {
    hardError = describeError(err);
  }

  const failures = outcomes.filter((outcome) => outcome.failure);

  // A spent quota halfway through does not undo the requests that already
  // answered: those products are real, and the rest of the photos are handed
  // back rather than guessed at.
  if (hardError && outcomes.some((outcome) => !outcome.failure)) {
    log.push(`Stopped early: ${hardError}`);
  } else if (hardError) {
    // Never turned into one product per photo: that would hide the real failure
    // behind a grouping that is confidently wrong.
    return {
      groups: [],
      unassigned: [],
      classified: false,
      error: hardError,
      log,
    };
  }

  // Stopped before a single request went out. Nothing failed — there is just
  // nothing to show, and every photo is still waiting.
  if (stopped && !outcomes.length) {
    log.push(`Stopped before any of ${images.length} photos were sorted.`);
    return {
      groups: [],
      unassigned: images.map((image) => image.id),
      classified: true,
      stopped: true,
      log,
    };
  }

  // Nothing came back that could be read. Say so, rather than inventing a
  // grouping out of the requests that failed.
  if (!outcomes.some((outcome) => !outcome.failure)) {
    const first = failures[0]?.failure;
    return {
      groups: [],
      unassigned: [],
      classified: false,
      error: first?.error ?? 'The photos could not be sorted.',
      rawReply: first?.rawReply,
      log,
    };
  }

  let groups = assemble(outcomes, log);

  // --- consolidation: one request, looking at the candidates together -----
  //
  // Everything above compares WORDS about photographs. That is cheap, it scales,
  // and it has a floor: in a folder of a hundred and ten trainers of one brand
  // and one style, the words are nearly identical by the time they are honest,
  // and no amount of arithmetic on them can say which photographs are one shoe.
  //
  // So the last step shows the model what it has never been shown — one
  // photograph from each candidate product, side by side — and asks it to sort
  // them. ONE request for the whole folder, about two batches' worth of images,
  // and the identity vetoes still hold over its answer: it can join what the
  // evidence merely could not settle, and it cannot join two colourways.
  //
  // A failure here loses nothing. The candidates stay as they are and the
  // review screen shows them.
  if (!stopped && !hardError && groups.length > 1 && MAX_CONSOLIDATE_GROUPS > 1) {
    const indexOfImage = new Map(images.map((image, i) => [image.id, i]));

    const vocabulary = buildVocabulary(
      groups.flatMap((group) =>
        group.images
          .map((image) => image.attributes)
          .filter((attributes): attributes is ImageAttributes => !!attributes)
      )
    );

    // Fragments first. A candidate of one or two photographs is the one that
    // has probably been split off something, and is what the budget is for; a
    // candidate that already holds six is the one least in need of an opinion.
    const shortlist = [...groups]
      .sort((a, b) => a.images.length - b.images.length)
      .slice(0, MAX_CONSOLIDATE_GROUPS);

    if (shortlist.length > 1) {
      onProgress?.({ done: images.length, total: images.length, phase: 'verifying' });

      // A profile shows more of a shoe than any other single view, so it is the
      // photograph most likely to be recognisable beside another candidate's.
      const representativeOf = (group: ProductGroup) =>
        group.images.find((image) => image.view === 'LEFT' || image.view === 'RIGHT') ??
        group.images.find((image) => image.view === 'FRONT') ??
        group.images[0];

      const parts: any[] = [];
      const shown: { group: ProductGroup; imageId: string }[] = [];

      shortlist.forEach((group) => {
        const entry = representativeOf(group);
        const image = images[indexOfImage.get(entry.imageId)!];
        if (!image) return;
        parts.push({ inlineData: { mimeType: 'image/jpeg', data: image.scout || image.thumb } });
        shown.push({ group, imageId: entry.imageId });
      });

      parts.push({ text: consolidatePrompt(shown.length) });

      try {
        const entries = extractJsonArray(await ask(parts));

        /** Photographs the model gave each letter. */
        const byLetter = new Map<string, number[]>();

        (entries ?? []).forEach((entry, position) => {
          if (!entry || typeof entry !== 'object') return;
          const record = entry as Record<string, unknown>;

          const declared = Number(record.photo ?? record.image ?? record.index);
          const slot = Number.isInteger(declared) ? declared : position;
          if (slot < 0 || slot >= shown.length) return;

          // Only the key this prompt asked for. `product` and `group` are what
          // the BATCH prompt answers with, and accepting them here means a
          // reply meant for one question can be read as an answer to the
          // other — which merges a whole folder on a misrouted response.
          const letter = String(record.item ?? record.label ?? '').trim().toUpperCase();
          if (!letter) return;

          const held = byLetter.get(letter);
          if (held) held.push(slot);
          else byLetter.set(letter, [slot]);
        });

        const confirmed: [string, string][] = [];
        let refused = 0;

        byLetter.forEach((slots) => {
          if (slots.length < 2) return;

          // Chained to the first, so a letter covering three candidates costs
          // two joins rather than three, and every join is checked.
          const anchor = shown[slots[0]];

          slots.slice(1).forEach((slot) => {
            const other = shown[slot];

            // The model's answer does not override a SETTLED verdict. Two
            // colourways, two categories, two codes or an accumulated weight of
            // disagreement stay two products whatever it says — this is the one
            // place a single reply could otherwise merge half a folder.
            //
            // A SINGLE structural conflict no longer refuses, and that was the
            // wrong half of the rule. This model has just been shown the two
            // candidates side by side, which is more than any other step in the
            // system gets; the fingerprint it is being overruled by is a fold of
            // words about photographs taken from different angles, and one of
            // those words disagreeing is exactly the ambiguous case. On a folder
            // of a hundred and ten trainers this refused ten of the model's
            // joins and let none through.
            //
            // `verdict === 'different'` still holds, so nothing decisive is
            // overturned — only the single ambiguous fact, and only when
            // something that looked at both pictures says otherwise.
            const left = anchor.group.fingerprint;
            const right = other.group.fingerprint;
            if (left && right) {
              const verdict = compare(left, right, vocabulary);
              if (verdict.verdict === 'different') {
                refused += 1;
                return;
              }
            }

            confirmed.push([anchor.imageId, other.imageId]);
          });
        });

        if (confirmed.length) groups = assemble(outcomes, log, confirmed);

        log.push(
          `Showed ${shown.length} candidate product(s) side by side in one request; ` +
            `${confirmed.length} were joined` +
            (refused ? `, and ${refused} were refused because the evidence contradicts it` : '') +
            '.'
        );
      } catch (err) {
        // An improvement, never a dependency.
        log.push(
          `The side-by-side check on ${shown.length} candidate(s) did not go through, so they ` +
            `remain separate products. (${describeError(err)})`
        );
      }
    }
  }

  // Photos from a request that failed, or one never sent, are handed back
  // rather than guessed at — the review screen has a tray for them.
  const placed = assignedIds(groups);
  let leftOver = images.filter((image) => !placed.has(image.id)).map((image) => image.id);

  // Before they go in the tray, the obvious ones go home. An orphan whose
  // photograph looks like one product's and not like any other's is that
  // product's — no request needed. Both tests in `nearestGroup` apply: close
  // enough, AND decisively closer than the runner-up. Anything ambiguous stays
  // in the tray, which is the safe half of this trade.
  if (leftOver.length && groups.length) {
    const indexOfImage = new Map(images.map((image, i) => [image.id, i]));

    const within: number[] = [];
    groups.forEach((group) => {
      const idx = group.images.map((i) => indexOfImage.get(i.imageId)!).filter((i) => i !== undefined);
      for (let a = 0; a < idx.length; a += 1) {
        for (let b = a + 1; b < idx.length; b += 1) {
          within.push(visualDistance(signatures[idx[a]], signatures[idx[b]]));
        }
      }
    });

    const limit = lookalikeLimit(within);
    const stillLoose: string[] = [];
    let rescued = 0;

    leftOver.forEach((imageId) => {
      const orphan = signatures[indexOfImage.get(imageId)!];
      if (!orphan) {
        stillLoose.push(imageId);
        return;
      }

      // Distance to a group is the distance to its closest photograph: one
      // matching view is what identifies a product, not the average of them.
      const distances = groups.map((group) =>
        Math.min(
          ...group.images.map((i) =>
            visualDistance(orphan, signatures[indexOfImage.get(i.imageId)!])
          )
        )
      );

      const target = nearestGroup(distances, limit);
      if (target === null) {
        stillLoose.push(imageId);
        return;
      }

      // A loose photograph placed by appearance alone is the weakest placement
      // there is, so the angle rule certainly applies to it.
      const orphanView = groups
        .flatMap((group) => group.images)
        .find((entry) => entry.imageId === imageId)?.view;
      if (clashingViews(groups[target].images.map((entry) => entry.view), [orphanView]).length) {
        stillLoose.push(imageId);
        return;
      }

      groups[target] = summarise({
        ...groups[target],
        // Marked as a fallback placement on purpose: `summarise` turns that
        // into needsReview, so the review screen still puts this product in
        // front of the user rather than presenting the guess as settled.
        images: [
          ...groups[target].images,
          {
            imageId,
            view: 'OTHER',
            viewSource: 'fallback',
            reason: 'matched this product by appearance only',
          },
        ],
      });
      rescued += 1;
    });

    if (rescued) {
      log.push(
        `${rescued} loose photo(s) matched a product by appearance and were placed there for review.`
      );
    }
    leftOver = stillLoose;
  }

  // --- the audit: each product's photographs, together, judged by the model -
  //
  // Everything above this line built products out of WORDS. The readings, the
  // fingerprints, the weighted comparisons, the vocabulary, the vetoes, the
  // appearance rescue — every one of them decided on a description of a
  // photograph rather than on the photograph, and none of them ever saw a
  // group's photographs side by side.
  //
  // That is the ceiling those rules have, and it is not a tuning problem. In a
  // folder of near-identical items the honest descriptions converge, the
  // distinctive words run out, and no further arithmetic on the text can
  // recover a difference the text does not contain. The information needed to
  // separate two black trainers was thrown away when the photograph became a
  // paragraph.
  //
  // So the rules are treated as what they are — a fast, cheap, fallible
  // pre-grouping — and the last word goes to the model, looking at the actual
  // photographs of one product at a time and told plainly that what grouped
  // them was mechanical.
  //
  // It runs LAST, after consolidation and after the appearance rescue, so it
  // judges the group as it will actually be shown, including the photographs
  // those two steps added — which are the weakest placements in the folder and
  // the ones most worth a second look.
  //
  // A failure loses nothing. The group stands as the rules left it.
  if (!stopped && !hardError && !shouldStop?.() && MAX_AUDIT_REQUESTS > 0) {
    const indexOfImage = new Map(images.map((image, i) => [image.id, i]));

    // Biggest first. A group of one photograph cannot be wrong in the way this
    // catches, and the chance that a group holds two products rises with every
    // photograph the rules absorbed into it.
    const shortlist = groups
      .filter((group) => group.images.length >= MIN_AUDIT_IMAGES)
      .sort((a, b) => b.images.length - a.images.length)
      .slice(0, MAX_AUDIT_REQUESTS);

    if (shortlist.length) {
      onProgress?.({ done: images.length, total: images.length, phase: 'verifying' });

      // Every request is built and sent BEFORE anything is applied. Applying a
      // split renumbers every group, so a shortlist captured up front and
      // applied afterwards is the only version of this that stays coherent.
      const audits = await mapWithConcurrency(
        shortlist,
        CONCURRENCY,
        async (group): Promise<{ order: string[]; claims: AuditClaim[]; error?: string }> => {
          const selection = auditSelection(group.images);
          const order: string[] = [];
          const photos: string[] = [];
          const parts: any[] = [];

          selection.forEach((entry) => {
            const image = images[indexOfImage.get(entry.imageId)!];
            if (!image) return;
            const data = image.thumb || image.scout;
            if (!data) return;
            parts.push({ inlineData: { mimeType: 'image/jpeg', data } });
            order.push(entry.imageId);
            photos.push(data);
          });

          if (order.length < MIN_AUDIT_IMAGES) return { order, claims: [] };

          // These same photographs have been ruled on before. The verdict was
          // about them, not about the ids they carry this time.
          const key = auditKey(photos);
          const remembered = auditCache.get(key);
          if (remembered) {
            return { order, claims: remembered.map((claim) => ({ ...claim })) };
          }

          parts.push({ text: auditPrompt(order.length) });

          try {
            if (shouldStop?.()) return { order, claims: [] };
            const entries = extractJsonArray(await ask(parts));
            const claims = readAudit(entries ?? [], order.length);
            // Only a reply that could be read is remembered. Caching an empty
            // verdict would turn one unreadable answer into a permanent one.
            if (claims.length) auditCache.set(key, claims);
            return { order, claims };
          } catch (err) {
            return { order, claims: [], error: describeError(err) };
          }
        }
      );

      const reasons = new Map<string, string>();
      let split = 0;
      let confirmed = 0;
      let failed = 0;

      audits.forEach((audit) => {
        if (audit.error) {
          failed += 1;
          return;
        }
        if (!audit.claims.length) return;

        const applied = applyAudit(groups, audit.claims, audit.order);
        applied.reasons.forEach((why, imageId) => reasons.set(imageId, why));

        if (applied.splits) split += applied.splits;
        else confirmed += 1;

        groups = applied.groups;
      });

      // The model's sentence about a photograph is worth more on the review
      // screen than the rule that first placed it, because it is the only line
      // in the system written by something that looked at the picture.
      if (reasons.size) {
        groups = groups.map((group) => ({
          ...group,
          images: group.images.map((image) =>
            reasons.has(image.imageId)
              ? { ...image, reason: reasons.get(image.imageId) }
              : image
          ),
        }));
      }

      log.push(
        `Re-examined ${shortlist.length} product(s) with their photos shown together: ` +
          `${confirmed} confirmed as one product` +
          (split ? `, ${split} split apart` : '') +
          (failed ? `, ${failed} could not be checked and stand as grouped` : '') +
          '.'
      );

      onGroups?.(groups);
    }
  }

  if (failures.length) {
    log.push(`${failures.length} request(s) could not be read; their photos are unassigned.`);
  }
  if (skipped.length) {
    log.push(`Stopped with ${skipped.length} request(s) unsent.`);
  }

  const uncertainGroups = groups.filter((group) => group.needsReview).length;

  log.push(
    `Finished: ${groups.length} product(s) from ${images.length - leftOver.length} photos, ` +
      `in ${requestsSent} request(s).` +
      (uncertainGroups ? ` ${uncertainGroups} need a look.` : '') +
      (leftOver.length ? ` ${leftOver.length} photo(s) could not be placed with confidence.` : '')
  );

  return {
    groups,
    unassigned: leftOver,
    classified: true,
    stopped: stopped || undefined,
    log,
  };
}
