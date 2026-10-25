/**
 * LIBRARY UNITS — what a render "belongs to", as the Library numbers it.
 *
 * Every render is of one UNIT: an individual product (from the folder scan or
 * the manual strip) or one composed outfit. The Library hands each unit the
 * next number of its kind the first time one of its renders is saved —
 * "Product 12", "Outfit 3" — from counters that live with the records, so
 * they never reset the way the session's `product-N` ids do.
 *
 * The number is allocated by the server. The browser's job is to say WHICH
 * unit a render is of (`unitKey`), what KIND it is, and where its garments
 * came from (`source`). This module builds that, pure and testable.
 */

export type UnitKind = 'product' | 'outfit';

/** Where the unit's garments came from. `mixed`: an outfit with both. */
export type UnitSource = 'folder' | 'manual' | 'mixed';

export type GarmentOrigin = 'folder' | 'manual';

export interface UnitMeta {
  /** Identifies the unit within its run; the server numbers it once. */
  unitKey: string;
  kind: UnitKind;
  source: UnitSource;
}

const SLOT_NAMES = ['top', 'bottoms', 'footwear'] as const;
type SlotName = (typeof SLOT_NAMES)[number];

/** One unit = one product or one outfit within one run. */
export const unitKeyOf = (runKey: string, unitId: string): string => `${runKey}::${unitId}`;

/** All folder → folder; all manual → manual; anything else (or nothing) → mixed. */
export const sourceOf = (origins: readonly GarmentOrigin[]): UnitSource => {
  const folder = origins.includes('folder');
  const manual = origins.includes('manual');
  if (folder && !manual) return 'folder';
  if (manual && !folder) return 'manual';
  return 'mixed';
};

/**
 * Where each filled slot of a render unit came from: a product group behind
 * the slot means the folder; reference photos with no group mean the manual
 * strip; an empty slot is rendered plain and says nothing.
 */
export const originsOfUnit = (unit: {
  groups: Partial<Record<SlotName, unknown>>;
  slots: Partial<Record<SlotName, unknown>>;
}): GarmentOrigin[] =>
  SLOT_NAMES.flatMap((slot) => {
    if (unit.groups[slot]) return ['folder' as const];
    if (unit.slots[slot] != null) return ['manual' as const];
    return [];
  });

export const unitMetaFor = (origin: {
  runKey: string;
  unitId: string;
  kind: UnitKind;
  origins: readonly GarmentOrigin[];
}): UnitMeta => ({
  unitKey: unitKeyOf(origin.runKey, origin.unitId),
  kind: origin.kind,
  source: sourceOf(origin.origins),
});

/** "Shirt A + Pants B + Shoes C" — the garments of an outfit, top to toe. */
export const garmentLine = (names: Partial<Record<string, string>>): string =>
  SLOT_NAMES.map((slot) => names[slot])
    .filter((name): name is string => !!name)
    .join(' + ');

/** The Library's name for a numbered unit. Mirrors the server's labelling. */
export const unitLabelOf = (kind: UnitKind, serial: number): string =>
  kind === 'outfit' ? `Outfit ${serial}` : `Product ${serial}`;
