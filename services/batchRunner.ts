import type { GarmentPhoto } from './renderRequest';
import { ProductGroup, FolderImage, Category } from './productGrouper';
import { SLOT_ORDER, type SlotName as ManifestSlot } from './renderManifest';

/**
 * Turns a confirmed product grouping into the per-product payloads the renderer
 * takes, and guarantees each one carries that product's photos and nothing else.
 *
 * The isolation guarantee is the reason this is a module rather than a loop
 * inside the component. A grouping is not a display concern: a product's group
 * IS the reference set its renders are generated from, so a photo of the wrong
 * shoe reaching a payload does not produce a visibly wrong render — it produces
 * a plausible render of a product that does not exist.
 */

export type SlotName = 'footwear' | 'top' | 'bottoms';

/**
 * Which garment slot a product is dressed in. OTHER falls to footwear because
 * that is this studio's hero item; the user can recategorise in review when it
 * is not.
 */
export const slotFor = (category: Category): SlotName =>
  category === 'TOP' ? 'top' : category === 'BOTTOMS' ? 'bottoms' : 'footwear';

/**
 * Shots that make sense for a product. The sneaker-only shots (sole close-ups,
 * shelf displays) would otherwise be rendered for a hoodie, which wastes a call
 * and produces a frame nobody asked for.
 */
export const shotsForProduct = (
  category: Category,
  selectedShots: string[],
  groupOfShot: (shotId: string) => string | undefined
): string[] =>
  category === 'FOOTWEAR' || category === 'OTHER'
    ? selectedShots
    : selectedShots.filter((id) => groupOfShot(id) !== 'sneaker');

/** What the run will cost, after per-category shot filtering. */
export const countRenders = (
  groups: ProductGroup[],
  selectedShots: string[],
  groupOfShot: (shotId: string) => string | undefined
): number =>
  groups.reduce(
    (sum, group) => sum + shotsForProduct(group.category, selectedShots, groupOfShot).length,
    0
  );

/** The views the render path can name. Anything else is "a photo of the item". */
const NAMED_VIEWS = new Set(['FRONT', 'BACK', 'LEFT', 'RIGHT', 'TOP', 'SOLE']);

/**
 * Builds one product's reference payload: every photograph with the view the
 * classifier (or the reviewer) gave it, FRONT first. Views the render path
 * cannot name (OTHER, CLOSEUP, DETAIL) travel unlabelled — a photograph of
 * the item, not a claim about which face it shows. The renderer's own
 * convention then applies: with no FRONT-labelled photo, the first unlabelled
 * one is the product's main photograph.
 */
export const buildProductPayload = (
  group: ProductGroup,
  byId: Map<string, FolderImage>
): GarmentPhoto[] => {
  const resolved = group.images
    .map((entry) => ({ entry, image: byId.get(entry.imageId) }))
    .filter((r): r is { entry: typeof r.entry; image: FolderImage } => !!r.image);

  if (!resolved.length) return [];

  const frontIndex = resolved.findIndex((r) => r.entry.view === 'FRONT');
  const ordered =
    frontIndex > 0
      ? [resolved[frontIndex], ...resolved.filter((_, i) => i !== frontIndex)]
      : resolved;

  return ordered.map(({ entry, image }) =>
    NAMED_VIEWS.has(entry.view) ? { data: image.full, view: entry.view } : { data: image.full }
  );
};

/**
 * Refuses to send a payload holding a photo that is not this product's.
 *
 * This throws rather than filtering: a foreign photo in a payload means the
 * grouping and the payload have gone out of step, and quietly dropping it would
 * hide that while still rendering from an incomplete reference set.
 */
export const assertProductIsolation = (
  payload: GarmentPhoto[],
  group: ProductGroup,
  byId: Map<string, FolderImage>
): void => {
  const allowed = new Set(
    group.images
      .map((entry) => byId.get(entry.imageId)?.full)
      .filter((data): data is string => !!data)
  );

  const foreign = payload.filter((photo) => {
    const data = typeof photo === 'string' ? photo : photo.data;
    return !allowed.has(data);
  });

  if (foreign.length) {
    throw new Error(
      `Reference isolation failed for ${group.name}: ${foreign.length} photo(s) do not belong to this product. Nothing was rendered.`
    );
  }
};

export interface ProductJob {
  group: ProductGroup;
  slot: SlotName;
  payload: GarmentPhoto[];
  shots: string[];
}

/**
 * The three garment slots a render request takes. `null` in a slot means no
 * photographs were supplied for that garment, so the person keeps what the
 * is rendered plain there.
 */
export interface OutfitSlots {
  footwear: GarmentPhoto[] | null;
  bottoms: GarmentPhoto[] | null;
  top: GarmentPhoto[] | null;
}

/**
 * The slots one product's INDIVIDUAL render is sent with: the product in
 * its own slot and NOTHING in the other two, so every other garment is
 * own garments there. Individual mode changes only the selected product —
 * a shirt or trousers uploaded by hand are worn only when an outfit names
 * them (`MANUAL_PRODUCT` in `buildOutfitRun`), never by default.
 */
export const individualSlotsFor = (job: ProductJob): OutfitSlots => ({
  footwear: job.slot === 'footwear' ? job.payload : null,
  bottoms: job.slot === 'bottoms' ? job.payload : null,
  top: job.slot === 'top' ? job.payload : null,
});

/**
 * The whole run, resolved up front so the total is known before the first call
 * and a broken group fails before any quota is spent. Products whose photos all
 * went missing, and products left with no applicable shot, are dropped rather
 * than queued as no-ops.
 */
export const buildRun = (
  groups: ProductGroup[],
  images: FolderImage[],
  selectedShots: string[],
  groupOfShot: (shotId: string) => string | undefined
): ProductJob[] => {
  const byId = new Map(images.map((img) => [img.id, img]));

  return groups
    .map((group) => {
      const payload = buildProductPayload(group, byId);
      assertProductIsolation(payload, group, byId);

      return {
        group,
        slot: slotFor(group.category),
        payload,
        shots: shotsForProduct(group.category, selectedShots, groupOfShot),
      };
    })
    .filter((job) => job.payload.length > 0 && job.shots.length > 0);
};

// ---------------------------------------------------------------------------
// OUTFIT MODE — explicit combinations, one render per outfit per shot.
// ---------------------------------------------------------------------------
//
// INDIVIDUAL mode renders each ticked product alone in its slot. OUTFIT mode
// renders combinations the user composed by hand: Outfit 1 = Shirt 1 + Pants
// 1 + Shoes 2, Outfit 2 = Shirt 2 + Pants 1 + Shoes 1, and so on. The same
// product may sit in several outfits; a slot left empty is rendered
// own garment. The system never decides which products go together — every
// outfit is an explicit manifest, executed as written.

/**
 * The one non-folder product an outfit slot may name: the garment uploaded
 * by hand in that slot's manual strip. Chosen explicitly like any product.
 */
export const MANUAL_PRODUCT = 'manual';

/**
 * One outfit as the user composed it: a product group id per slot,
 * `MANUAL_PRODUCT` for the manual upload in that slot, or null to keep the
 * plain and unbranded.
 */
export interface OutfitSpec {
  id: string;
  name: string;
  footwear: string | null;
  bottoms: string | null;
  top: string | null;
}

export interface OutfitJob {
  outfit: OutfitSpec;
  /** The reference photographs per slot; null renders that slot plain. */
  slots: OutfitSlots;
  /** The product groups behind those slots, for names and the compare popup. */
  groups: Partial<Record<ManifestSlot, ProductGroup>>;
  /** Product names per slot, for the manifest. */
  names: Partial<Record<ManifestSlot, string>>;
  shots: string[];
}

/** "Outfit 1 → Shirt A + Pants B + Shoes C" — the human line of an outfit. */
export const outfitLine = (outfit: OutfitSpec, groups: ProductGroup[]): string => {
  const nameOf = (id: string | null) =>
    id === MANUAL_PRODUCT ? 'manual upload' : groups.find((g) => g.id === id)?.name ?? null;
  const parts = [
    outfit.top ? `Shirt ${nameOf(outfit.top) ?? '?'}` : null,
    outfit.bottoms ? `Pants ${nameOf(outfit.bottoms) ?? '?'}` : null,
    outfit.footwear ? `Shoes ${nameOf(outfit.footwear) ?? '?'}` : null,
  ].filter((p): p is string => !!p);
  return `${outfit.name} → ${parts.length ? parts.join(' + ') : 'nothing supplied'}`;
};

/** Which slot a product group belongs in, by its category. */
export const slotOfGroup = (group: ProductGroup): SlotName => slotFor(group.category);

/**
 * The whole outfit run, resolved up front. Each slot's payload is built from
 * its own product group and vetted by `assertProductIsolation`, so no photo
 * of another product can reach a slot. An outfit naming a product that no
 * longer exists, or one placed in a slot its category does not fit, fails
 * loudly here — before any quota is spent — rather than rendering a
 * different outfit from the one on screen.
 */
export const buildOutfitRun = (
  outfits: OutfitSpec[],
  groups: ProductGroup[],
  images: FolderImage[],
  selectedShots: string[],
  groupOfShot: (shotId: string) => string | undefined,
  /** The manual strips' garments, for slots that name `MANUAL_PRODUCT`. */
  manual: OutfitSlots = { footwear: null, bottoms: null, top: null }
): OutfitJob[] => {
  const byId = new Map(images.map((img) => [img.id, img]));
  const groupById = new Map(groups.map((g) => [g.id, g]));

  return outfits
    .map((outfit): OutfitJob => {
      const slots: OutfitSlots = { footwear: null, bottoms: null, top: null };
      const used: Partial<Record<ManifestSlot, ProductGroup>> = {};
      const names: Partial<Record<ManifestSlot, string>> = {};

      SLOT_ORDER.forEach((slot) => {
        const id = outfit[slot];
        if (!id) return;
        if (id === MANUAL_PRODUCT) {
          const photos = manual[slot];
          if (!photos?.length) {
            throw new Error(`${outfit.name}: the ${slot} slot names the manual upload, but that strip is empty. Nothing was rendered.`);
          }
          slots[slot] = photos;
          names[slot] = 'manual upload';
          return;
        }
        const group = groupById.get(id);
        if (!group) {
          throw new Error(`${outfit.name}: the product chosen for ${slot} no longer exists. Nothing was rendered.`);
        }
        if (slotOfGroup(group) !== slot) {
          throw new Error(
            `${outfit.name}: ${group.name} is a ${group.category.toLowerCase()} product and cannot be worn as ${slot}. Nothing was rendered.`
          );
        }
        const payload = buildProductPayload(group, byId);
        assertProductIsolation(payload, group, byId);
        slots[slot] = payload.length ? payload : null;
        used[slot] = group;
        names[slot] = group.name;
      });

      // Sneaker shots need a shoe to look at: the outfit's own, or none.
      const shots = slots.footwear
        ? selectedShots
        : selectedShots.filter((id) => groupOfShot(id) !== 'sneaker');

      return { outfit, slots, groups: used, names, shots };
    })
    .filter((job) => job.shots.length > 0 && SLOT_ORDER.some((s) => job.slots[s]));
};

/** What an outfit run will cost. */
export const countOutfitRenders = (jobs: OutfitJob[]): number =>
  jobs.reduce((sum, job) => sum + job.shots.length, 0);

// ---------------------------------------------------------------------------
// Single Generation vs Batch Generation — the explicit architecture concept.
// ---------------------------------------------------------------------------
//
// SINGLE:  one product  -> one generation attempt per shot.
// BATCH:   many products -> one generation attempt per product per shot,
//                           tracked item by item.
//
// The difference is bookkeeping, NOT how many times a request is sent. Both
// modes send exactly one request per (product, shot), and neither ever sends a
// second one on its own.

/** What a batch item is doing right now. */
export type BatchItemState = 'pending' | 'processing' | 'completed' | 'failed';

/** How the run was performed, so a report can say which path produced it. */
export type GenerationMode = 'single' | 'batch';

/** One unit of billable work: one product, one shot, one attempt. */
export interface BatchItem {
  /** Unique across the run. Used as the batch key, so it also prevents duplicates. */
  key: string;
  productId: string;
  productName: string;
  styleId: string;
  styleLabel: string;
  state: BatchItemState;
  /** Set once the item completes. */
  url?: string;
  /** Set once the item fails. Shown verbatim; never a reason to try again. */
  error?: string;
  /**
   * How many times this item has actually been sent. Asserted in tests: it is
   * 1 after a run, whether the item succeeded or failed, and only a deliberate
   * user Retry can make it 2.
   */
  attempts: number;
}

/** Stable, collision-proof key for one unit of work. */
export const itemKey = (productId: string, styleId: string): string =>
  `${productId}::${styleId}`;

/**
 * Every item a run will attempt, all `pending`, resolved BEFORE the first
 * request goes out so the exact cost of the run is known in advance and can be
 * shown to the user for confirmation.
 */
export const buildRunItems = (
  units: { id: string; name: string; shots: string[] }[],
  labelOf: (styleId: string) => string
): BatchItem[] =>
  units.flatMap((unit) =>
    unit.shots.map((styleId) => ({
      key: itemKey(unit.id, styleId),
      productId: unit.id,
      productName: unit.name,
      styleId,
      styleLabel: labelOf(styleId),
      state: 'pending' as BatchItemState,
      attempts: 0,
    }))
  );

export const buildBatchItems = (
  jobs: ProductJob[],
  labelOf: (styleId: string) => string
): BatchItem[] =>
  buildRunItems(
    jobs.map((job) => ({ id: job.group.id, name: job.group.name, shots: job.shots })),
    labelOf
  );

/** The same, for an outfit run: one item per outfit per shot, keyed by the outfit. */
export const buildOutfitBatchItems = (
  jobs: OutfitJob[],
  labelOf: (styleId: string) => string
): BatchItem[] =>
  buildRunItems(
    jobs.map((job) => ({ id: job.outfit.id, name: job.outfit.name, shots: job.shots })),
    labelOf
  );

export interface BatchSummary {
  mode: GenerationMode;
  items: BatchItem[];
  completed: BatchItem[];
  failed: BatchItem[];
  /** Total requests actually sent. Must equal items.length for a clean run. */
  attempts: number;
}

export const summariseBatch = (
  items: BatchItem[],
  mode: GenerationMode = 'batch'
): BatchSummary => ({
  mode,
  items,
  completed: items.filter((i) => i.state === 'completed'),
  failed: items.filter((i) => i.state === 'failed'),
  attempts: items.reduce((sum, i) => sum + i.attempts, 0),
});

/**
 * Runs a batch, one intentional attempt per item, in order.
 *
 * THE RULES THIS FUNCTION ENFORCES, and the reason it is a module rather than
 * a loop in the component:
 *
 *   - Each item is sent EXACTLY ONCE. `attempts` is incremented before the
 *     call, so the count is honest even when the call throws.
 *   - A failed item is marked `failed` and the run MOVES ON. It is not
 *     retried, not re-queued, and not sent to another model or provider.
 *   - Items already `completed` or `failed` are skipped, so calling this again
 *     on the same array cannot re-bill work that has already been attempted.
 *     Only `retryBatchItem` can reopen one, and only a user action calls it.
 *   - `shouldStop` is checked between items, so cancelling stops spending.
 */
export const runBatchItems = async (
  items: BatchItem[],
  render: (item: BatchItem) => Promise<string>,
  hooks: {
    onItemChange?: (item: BatchItem, items: BatchItem[]) => void;
    shouldStop?: () => boolean;
  } = {}
): Promise<BatchSummary> => {
  for (const item of items) {
    if (hooks.shouldStop?.()) break;
    // Anything not pending has had its one attempt already.
    if (item.state !== 'pending') continue;

    item.state = 'processing';
    hooks.onItemChange?.(item, items);

    item.attempts += 1;
    try {
      item.url = await render(item);
      item.state = 'completed';
      item.error = undefined;
    } catch (err: any) {
      // Marked and left. No second attempt, no other model, no other provider.
      item.state = 'failed';
      item.error = err?.message ?? String(err);
      console.error(
        `[Batch] ${item.productName} · ${item.styleLabel} failed and was NOT retried:`,
        err
      );
    }

    hooks.onItemChange?.(item, items);
  }

  return summariseBatch(items);
};

/**
 * Reopens ONE failed item because the user pressed Retry on it.
 *
 * This is the only path back to `pending`, and it exists so that a second
 * attempt is always traceable to a person having asked for one. It does not
 * itself send anything — the caller runs the batch again, which will pick up
 * exactly the items this reopened and no others.
 */
export const retryBatchItem = (items: BatchItem[], key: string): BatchItem[] =>
  items.map((item) =>
    item.key === key && item.state === 'failed'
      ? { ...item, state: 'pending' as BatchItemState, error: undefined }
      : item
  );
