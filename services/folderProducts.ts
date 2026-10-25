/**
 * PRODUCTS FROM FOLDER STRUCTURE.
 *
 * The uploaded folder holds one subfolder per product, and each subfolder holds
 * that product's photographs from its different angles:
 *
 *     shoot/
 *       red-runner/     front.jpg  back.jpg  left.jpg  sole.jpg
 *       black-boot/     front.jpg  side.jpg  top.jpg
 *
 * So identity is not a judgement here — the folder already says which photos
 * are one product. The only question left for a model is WHICH ANGLE each photo
 * shows, and that is asked exactly the way the manual angle strip asks it:
 * one request per product, the photos' small copies, and the same fixed slots
 * (`mapAnglesToSlots`). A photo the model cannot place keeps `OTHER` and is
 * marked `fallback`, which is what the manual strip calls an unconfirmed tile;
 * the review screen lets the user set it by hand.
 *
 * The automatic product grouping (v1/v2/v3) is not used on this path.
 */

import { mapAnglesToSlots, majorityCategory, MappingResult } from './angleMapper';
import { mapWithConcurrency } from './imageUtils';
import { rememberProductBox } from './productBoxCache';
import {
  FolderImage,
  GroupedImage,
  GroupingProgress,
  GroupingResult,
  ProductGroup,
  ViewName,
  renumber,
} from './productModel';

/**
 * The views a folder photograph can be named as. Slot name == view name. The
 * six the manual footwear strip has, plus CLOSEUP for a detail shot: the
 * render path treats a CLOSEUP as "a photograph of the item" (never trimmed,
 * never named as a face), and the review screen shows what it was read as.
 */
export const FOLDER_SLOTS: ViewName[] = ['FRONT', 'BACK', 'LEFT', 'RIGHT', 'SOLE', 'TOP', 'CLOSEUP'];

/** Products named at once. Each is one request, like one manual strip upload. */
export const NAMING_CONCURRENCY = 3;

export interface FolderKey {
  /** Stable key for grouping — the folder path from the uploaded root. */
  key: string;
  /** What the product is called on screen — the folder's own name. */
  name: string;
}

/** `"a\\b/c.jpg"` → `["a", "b"]`: the directories only, forward-slashed. */
const dirsOf = (path: string | undefined): string[] => {
  if (!path) return [];
  const parts = path.replace(/\\/g, '/').split('/').filter((p) => p && p !== '.');
  return parts.slice(0, -1);
};

/**
 * Which product folder each photo belongs to, or null for a loose photo.
 *
 * The rule follows how the folder was handed over:
 *
 *   - ONE root dropped, with subfolders inside it → each first-level subfolder
 *     is a product. A file sitting directly in the root is loose: it belongs to
 *     no subfolder, so it goes to the Uncertain tray to be placed by hand.
 *   - SEVERAL folders dropped at once (or one folder with no subfolders) → each
 *     dropped folder is itself a product.
 *
 * Deeper nesting rolls up: `root/product/closeups/a.jpg` still belongs to
 * `product`.
 */
export const folderKeys = (images: FolderImage[]): (FolderKey | null)[] => {
  const dirs = images.map((image) => dirsOf(image.path));
  const roots = new Set(dirs.filter((d) => d.length).map((d) => d[0]));
  const nested = roots.size === 1 && dirs.some((d) => d.length >= 2);

  return dirs.map((d) => {
    if (nested) {
      if (d.length < 2) return null;
      return { key: `${d[0]}/${d[1]}`, name: d[1] };
    }
    if (!d.length) return null;
    return { key: d[0], name: d[0] };
  });
};

const unnamed = (imageId: string): GroupedImage => ({
  imageId,
  view: 'OTHER',
  viewSource: 'fallback',
});

/**
 * One product per folder, photos in upload order, every view still unnamed.
 * Pure and instant, so the review screen can show the products before a
 * single request has been made.
 */
export const groupByFolder = (
  images: FolderImage[]
): { groups: ProductGroup[]; unassigned: string[] } => {
  const keys = folderKeys(images);
  const byKey = new Map<string, ProductGroup>();
  const unassigned: string[] = [];

  images.forEach((image, i) => {
    const key = keys[i];
    if (!key) {
      unassigned.push(image.id);
      return;
    }
    let group = byKey.get(key.key);
    if (!group) {
      group = {
        id: `product-${byKey.size + 1}`,
        name: key.name,
        // The folder says nothing about category. FOOTWEAR is only the
        // placeholder until the angle classifier has looked at the photos
        // (`applyAssignments` sets the majority category); the review
        // screen's dropdown can still overrule it.
        category: 'FOOTWEAR',
        images: [],
        confidence: 1,
        needsReview: false,
      };
      byKey.set(key.key, group);
    }
    group.images.push(unnamed(image.id));
  });

  return { groups: renumber([...byKey.values()]), unassigned };
};

export type MapAngles = (images: string[], slots: string[]) => Promise<MappingResult>;

export interface NameAnglesOptions {
  /** Test seam; production uses the real classifier. */
  mapAngles?: MapAngles;
  onProgress?: (progress: GroupingProgress) => void;
  /** Products already named keep their names; the rest stay unnamed. */
  shouldStop?: () => boolean;
  /** Fires after each product is named, so the screen fills in as it goes. */
  onGroups?: (groups: ProductGroup[]) => void;
  /** Loose photos from `groupByFolder`, carried through untouched. */
  unassigned?: string[];
  concurrency?: number;
}

/**
 * Applies one product's classification to its photos — the view of each, and
 * the product's category from the majority of what the photographs showed.
 * The folder itself says nothing about whether it holds shirts or shoes; the
 * model does, and the review screen's dropdown can still overrule it.
 */
const applyAssignments = (group: ProductGroup, result: MappingResult): ProductGroup => ({
  ...group,
  category: result.classified
    ? majorityCategory(result.assignments.map((a) => a.category)) ?? group.category
    : group.category,
  images: group.images.map((entry, i) => {
    const assignment = result.classified ? result.assignments[i] : undefined;
    // Only a placement the model made is a statement about the photo. A slot
    // filled in upload order (`fallback`) is not — the manual strip marks those
    // unconfirmed, and here they stay OTHER for the same reason.
    if (assignment && assignment.slot !== null && assignment.source === 'model') {
      const view = FOLDER_SLOTS[assignment.slot];
      if (view) return { ...entry, view, viewSource: 'model' };
    }
    return { ...entry, view: 'OTHER', viewSource: 'fallback' };
  }),
});

/**
 * Names every photo's angle, one request per product, then hands back the
 * finished grouping. Never throws for a product the model could not name:
 * that product's photos stay unnamed and the log says why.
 */
export const nameAngles = async (
  groups: ProductGroup[],
  images: FolderImage[],
  options: NameAnglesOptions = {}
): Promise<GroupingResult> => {
  const {
    mapAngles = mapAnglesToSlots,
    onProgress,
    shouldStop,
    onGroups,
    unassigned = [],
    concurrency = NAMING_CONCURRENCY,
  } = options;

  const byId = new Map(images.map((image) => [image.id, image]));
  const log: string[] = [];
  const named: ProductGroup[] = [...groups];
  let done = 0;
  let stopped = false;

  onProgress?.({ done: 0, total: groups.length, phase: 'angles' });

  await mapWithConcurrency(groups, concurrency, async (group, i) => {
    if (stopped || shouldStop?.()) {
      stopped = true;
      return;
    }

    // The small copies, as the manual strip sends them.
    const scouts = group.images.map((entry) => {
      const image = byId.get(entry.imageId);
      return image?.scout || image?.thumb || '';
    });

    let result: MappingResult;
    try {
      result = await mapAngles(scouts, [...FOLDER_SLOTS]);
    } catch (err) {
      result = {
        assignments: [],
        classified: false,
        reason: 'unreachable',
        detail: err instanceof Error ? err.message : String(err),
      };
    }

    named[i] = applyAssignments(group, result);

    // Where the product sits in each photograph, remembered against the
    // full-size copy the render path crops.
    group.images.forEach((entry, n) => {
      const image = byId.get(entry.imageId);
      if (image) rememberProductBox(image.full, result.assignments[n]?.box ?? null);
    });

    if (!result.classified) {
      log.push(
        `${group.name}: the views could not be named (${result.reason ?? 'unreadable'}` +
          `${result.detail ? ` — ${result.detail}` : ''}). Its photos are unlabelled; set them in review.`
      );
    } else {
      const unplaced = named[i].images.filter((entry) => entry.viewSource === 'fallback').length;
      if (unplaced) {
        log.push(
          `${group.name}: ${unplaced} photo(s) the model could not place in a view; set them in review.`
        );
      }
    }

    done += 1;
    onProgress?.({ done, total: groups.length, phase: 'angles' });
    onGroups?.(renumber([...named]));
  });

  const finished = renumber(named);
  const loose = images.length - groups.reduce((sum, g) => sum + g.images.length, 0);

  log.unshift(
    `${finished.length} product(s) from ${images.length - loose} photo(s), one per folder.` +
      (loose ? ` ${loose} photo(s) sat outside any product folder and are in Uncertain.` : '')
  );
  if (stopped) log.push('Stopped early: the remaining products keep their photos unnamed.');

  return {
    groups: finished,
    unassigned,
    classified: true,
    stopped: stopped || undefined,
    log,
  };
};
