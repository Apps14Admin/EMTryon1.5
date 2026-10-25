/**
 * PRE-GENERATION GUARD: a shot that looks at one face of a product needs a
 * photograph of THAT face.
 *
 * Some shots exist precisely to show a face the other shots cannot reach — the
 * outsole, the top of the shoe, the back of a shirt. Asked for one of those
 * with no photograph of that face, the model does not decline: it invents a
 * tread pattern, a lace layout, a back panel. That is the one failure the
 * enforcement layer cannot catch, because by the time the prompt is read the
 * evidence is already absent. So the run is stopped here, before a request is
 * built.
 *
 * WHAT THIS IS NOT. It is not a second opinion about which photographs the
 * renderer will send — `trimToShot` decides that and is untouched. This only
 * asks whether the evidence EXISTS. Two rules are copied from the renderer so
 * the guard can never be stricter than the pipeline it guards:
 *
 *   1. A photograph with NO view is admissible for any shot
 *      (`trimToShot`: `list.filter((p) => !p.view || keep.has(p.view))`).
 *      The primary upload never carries a view, and an angle photo the
 *      classifier could not name has its slot name withheld on purpose. Both
 *      still reach the model, so both count as evidence here.
 *
 *   2. LEFT and RIGHT are both side faces, as `SHOT_VIEW_ALIASES.SIDE` says.
 *      Either one satisfies a side requirement.
 *
 * An ABSENT garment is never a reason to block: a slot with no photographs is
 * rendered plain by design, so there is no product whose face could be wrong.
 */
import { SHOT_VIEW_ALIASES } from './promptDeployed';
import type { SlotName } from './renderManifest';
import type { OutfitSlots } from './batchRunner';

/** A photograph as the slots carry it: bytes, and a view name when one is known. */
interface ViewedPhoto {
  data: string;
  view?: string;
}

const SIDE = SHOT_VIEW_ALIASES.SIDE; // ['LEFT', 'RIGHT', 'SIDE']

/**
 * What each shot must be able to see, per garment.
 *
 * Read alongside `renderRequest.ts`, which decides the same thing for the
 * renderer. A shot appears here only when its whole purpose is a face that one
 * specific photograph is the sole source for:
 *
 *   the three SIDE shots  — a 90-degree camera sees only the side
 *   sole_detail           — the outsole, which no other photograph shows
 *   overhead_detail       — the top face, seen from directly above
 *   top_back_view         — the back panel of the shirt
 *
 * The sneaker close-ups omit `top` because `renderRequest.ts` drops it
 * (`topIdx = isSneakerCloseUp ? [] : ...`): the shirt is above the frame, so
 * demanding a photograph of it would block a render for no reason.
 */
const REQUIRED_VIEWS: Record<string, Partial<Record<SlotName, readonly string[]>>> = {
  // 90-degree shots: the side face.
  side: { footwear: SIDE, bottoms: SIDE, top: SIDE },
  side_detail: { footwear: SIDE, bottoms: SIDE },
  ground_side: { footwear: SIDE, bottoms: SIDE },
  // Faces only one photograph can answer for.
  sole_detail: { footwear: ['SOLE'] },
  overhead_detail: { footwear: ['TOP'] },
  top_back_view: { top: ['BACK'] },
};

/** The shots this guard has an opinion about. */
export const VIEW_DEPENDENT_STYLES: ReadonlySet<string> = new Set(Object.keys(REQUIRED_VIEWS));

/** Kept for the side-specific callers and tests that name it. */
export const SIDE_DEPENDENT_STYLES: ReadonlySet<string> = new Set([
  'side',
  'side_detail',
  'ground_side',
]);

/** How the requirement is named to the user, per accepted-view set. */
const NEED_LABEL: Record<string, string> = {
  'LEFT,RIGHT,SIDE': 'LEFT or RIGHT',
  SOLE: 'SOLE',
  TOP: 'TOP',
  BACK: 'BACK',
};

/** A garment that is present but cannot answer the camera this shot uses. */
export interface MissingView {
  styleId: string;
  slot: SlotName;
  /** The product's own name where one is known, else the slot's own word. */
  product: string;
  /** The photograph the user has to add, in the angle strip's own wording. */
  need: string;
}

/** The slot word shown when a manual upload has no product name. */
const SLOT_WORD: Record<SlotName, string> = {
  footwear: 'the footwear',
  bottoms: 'the trousers',
  top: 'the top',
};

/** True when this garment can answer the camera. See rules 1 and 2 above. */
const hasEvidence = (photos: ViewedPhoto[] | null | undefined, accepted: readonly string[]): boolean => {
  const want = new Set(accepted.map((v) => v.toUpperCase()));
  return !!photos?.some((p) => !p.view || want.has(p.view.toUpperCase()));
};

/**
 * Every garment a selected shot would render without a photograph of the face
 * that shot looks at.
 *
 * Empty means the run may proceed. The caller blocks the WHOLE run on any
 * entry: a multi-shot run is one user action, and quietly dropping the shot
 * that cannot be evidenced would hand back a gallery missing a view the user
 * asked for, with nothing said about why.
 */
export const missingViewEvidence = (
  slots: OutfitSlots,
  names: Partial<Record<SlotName, string>>,
  shots: readonly string[]
): MissingView[] => {
  const found: MissingView[] = [];

  for (const styleId of shots) {
    const required = REQUIRED_VIEWS[styleId];
    if (!required) continue;

    for (const [slot, accepted] of Object.entries(required) as [SlotName, readonly string[]][]) {
      const photos = slots[slot] as ViewedPhoto[] | null;
      // Absent garment: rendered plain, nothing to get wrong.
      if (!photos?.length) continue;
      if (hasEvidence(photos, accepted)) continue;
      found.push({
        styleId,
        slot,
        product: names[slot] || SLOT_WORD[slot],
        need: NEED_LABEL[accepted.join(',')] ?? accepted.join(' or '),
      });
    }
  }

  return found;
};
