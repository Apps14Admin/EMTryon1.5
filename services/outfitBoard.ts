import type { ProductGroup } from './productModel';
import { MANUAL_PRODUCT, slotOfGroup, type OutfitSpec, type SlotName } from './batchRunner';

/**
 * OUTFIT BOARD — the rules behind the drag-and-drop outfit picker.
 *
 * A product is dragged from the shelf (or out of another outfit) and dropped
 * on an outfit row. Where it lands is decided by the product, not by where on
 * the row the cursor let go: a top always lands in the top slot, a shoe in the
 * shoes slot. Dropping onto a slot that is already filled replaces it. Dragging
 * out of one outfit into another moves it. The same product may sit in as many
 * outfits as the user likes — nothing here limits that.
 */

/** What a drag carries: which product, and the slot its category puts it in. */
export interface OutfitDrag {
  /** A product group id, or `MANUAL_PRODUCT` for the manual upload strip. */
  product: string;
  slot: SlotName;
  /** Set when dragged out of another outfit's slot, so the drop moves it. */
  from?: string;
}

/** The dataTransfer type the picker uses, so foreign drags are ignored. */
export const OUTFIT_DRAG_MIME = 'application/x-em-outfit';

/** The photo the shelf shows for a product: its FRONT view, else its first. */
export const frontImageOf = (group: ProductGroup): string | null =>
  (group.images.find((image) => image.view === 'FRONT') ?? group.images[0])?.imageId ?? null;

export const dragFor = (group: ProductGroup, from?: string): OutfitDrag => ({
  product: group.id,
  slot: slotOfGroup(group),
  ...(from ? { from } : {}),
});

export const manualDrag = (slot: SlotName, from?: string): OutfitDrag => ({
  product: MANUAL_PRODUCT,
  slot,
  ...(from ? { from } : {}),
});

/**
 * Drop onto an outfit. The product lands in its own slot, replacing whatever
 * was there. A drag that came out of another outfit empties that source slot.
 * An unknown target leaves everything as it was.
 */
export const placeInOutfit = (outfits: OutfitSpec[], targetId: string, drag: OutfitDrag): OutfitSpec[] => {
  if (!outfits.some((outfit) => outfit.id === targetId)) return outfits;
  return outfits.map((outfit) => {
    if (outfit.id === targetId) return { ...outfit, [drag.slot]: drag.product };
    if (drag.from && outfit.id === drag.from) return { ...outfit, [drag.slot]: null };
    return outfit;
  });
};

/** Empty one slot of one outfit — that slot is then rendered plain. */
export const clearSlot = (outfits: OutfitSpec[], outfitId: string, slot: SlotName): OutfitSpec[] =>
  outfits.map((outfit) => (outfit.id === outfitId ? { ...outfit, [slot]: null } : outfit));

/** Parse a drag off the clipboard; null for anything that is not ours. */
export const readDrag = (raw: string | null | undefined): OutfitDrag | null => {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed?.product !== 'string' || !['top', 'bottoms', 'footwear'].includes(parsed?.slot)) return null;
    return {
      product: parsed.product,
      slot: parsed.slot,
      ...(typeof parsed.from === 'string' ? { from: parsed.from } : {}),
    };
  } catch {
    return null;
  }
};
