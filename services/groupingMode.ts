/**
 * WHICH GROUPING PIPELINE RUNS.
 *
 * All three are present on this branch on purpose. Neither predecessor is
 * deleted until its successor has been run against real folders and beaten it
 * there — a synthetic oracle can show that the architecture is sound, and
 * cannot show that a real model reads a real contact sheet the way the prompt
 * expects.
 *
 *   ?grouping=v1   the attribute pipeline: each photograph read into ~35 text
 *                  fields, identity recovered by weighted comparison of those
 *                  fields against tuned thresholds and veto tiers.
 *
 *   ?grouping=v2   the visual pipeline: photographs embedded locally, laid out
 *                  on contact sheets, and judged as pictures.
 *
 *   ?grouping=v3   the angle-constrained pipeline (default): the same local
 *                  embedding, but candidates are stratified by angle first —
 *                  cannot-link is absolute rather than advisory — and the
 *                  model is only ever asked a targeted identity question about
 *                  a handful of disjoint anchors at a time.
 *
 * The choice is remembered, so a folder can be sorted one way, the page
 * reloaded with another, and the results compared on the same photographs
 * without re-uploading them.
 */

export type GroupingMode = 'v1' | 'v2' | 'v3';

export const DEFAULT_MODE: GroupingMode = 'v3';

const KEY = 'emtryon.groupingMode';
const EMBED_KEY = 'emtryon.embedding';
const SCHEMA_KEY = 'emtryon.structuredOutput';
const ANGLES_KEY = 'emtryon.oneShotPerAngle';

const isMode = (value: unknown): value is GroupingMode =>
  value === 'v1' || value === 'v2' || value === 'v3';

let active: GroupingMode | null = null;

/**
 * The mode in force, read once from the URL and then from storage.
 *
 * A `?grouping=` in the URL wins and is remembered, so the parameter can be
 * dropped from the address bar without the choice reverting.
 */
export const groupingMode = (): GroupingMode => {
  if (active) return active;

  if (typeof window === 'undefined') {
    active = DEFAULT_MODE;
    return active;
  }

  try {
    const asked = new URLSearchParams(window.location.search).get('grouping');
    if (isMode(asked)) {
      active = asked;
      window.localStorage.setItem(KEY, asked);
      return active;
    }

    const held = window.localStorage.getItem(KEY);
    if (isMode(held)) {
      active = held;
      return active;
    }
  } catch {
    /* a browser with storage blocked still gets the default */
  }

  active = DEFAULT_MODE;
  return active;
};

/**
 * Whether the local embedding stage runs at all.
 *
 * `?embed=off` skips the model download and falls back to the cheap thumbnail
 * signatures for deciding which photographs share a contact sheet.
 *
 * It is a real option rather than a debug flag, because of WHAT the embedding
 * decides: nothing. It proposes which photographs are worth putting in front of
 * the model together, and the model still judges every pair either way. Turning
 * it off costs recall — some products arrive split because their angles never
 * met on a sheet — and costs some extra requests, and cannot cause two products
 * to be merged.
 *
 * So it is the right switch for a first run on a slow connection, and the right
 * switch for finding out whether a disappointing folder is the recall stage's
 * fault or the judge's.
 */
export const embeddingEnabled = (): boolean => {
  if (typeof window === 'undefined') return true;
  try {
    const asked = new URLSearchParams(window.location.search).get('embed');
    if (asked === 'off' || asked === 'on') {
      window.localStorage.setItem(EMBED_KEY, asked);
      return asked === 'on';
    }
    return window.localStorage.getItem(EMBED_KEY) !== 'off';
  } catch {
    return true;
  }
};

/**
 * Whether requests carry a `responseSchema`.
 *
 * OFF by default, and that default is a retreat rather than a preference. A
 * schema is the better way to ask — it removes the whole class of failure where
 * a reply comes back as prose, a fenced block, or the right JSON under renamed
 * keys. But it is an OPTIMISATION, not a dependency: the prompt already states
 * the exact shape, and `extractArray` and `readVerdicts` are built and tested to
 * read a reply that does not follow it.
 *
 * Against that, a schema the configured model will not accept returns 400 on
 * EVERY request, which does not degrade the folder — it destroys it. A stage
 * that can only help must never be able to do that, so the version that can is
 * the one you opt into.
 *
 * `?schema=on` turns it on once it has been confirmed against the live model.
 */
export const structuredOutputEnabled = (): boolean => {
  if (typeof window === 'undefined') return false;
  try {
    const asked = new URLSearchParams(window.location.search).get('schema');
    if (asked === 'on' || asked === 'off') {
      window.localStorage.setItem(SCHEMA_KEY, asked);
      return asked === 'on';
    }
    return window.localStorage.getItem(SCHEMA_KEY) === 'on';
  } catch {
    return false;
  }
};

/**
 * Whether this folder is a ONE-PHOTOGRAPH-PER-ANGLE shoot.
 *
 * On by default, because it describes how these folders are actually produced:
 * each item is photographed once from the front, the back, each side, above and
 * below. Under that protocol a product holding two BACK views is holding two
 * products, and saying so catches the pair the judge is weakest on — two
 * heel-on shots of two grey trainers look far more like each other than either
 * looks like its own item's underside.
 *
 * It is a fact about the SHOOT and not about photographs in general, which is
 * why it is a switch rather than a law. `?angles=off` for a folder containing
 * bursts, re-shoots, or both shoes of a pair, where a product legitimately has
 * two photographs of one side.
 */
export const oneShotPerAngle = (): boolean => {
  if (typeof window === 'undefined') return true;
  try {
    const asked = new URLSearchParams(window.location.search).get('angles');
    if (asked === 'on' || asked === 'off') {
      window.localStorage.setItem(ANGLES_KEY, asked);
      return asked === 'on';
    }
    return window.localStorage.getItem(ANGLES_KEY) !== 'off';
  } catch {
    return true;
  }
};

export const setGroupingMode = (mode: GroupingMode): void => {
  active = mode;
  try {
    window.localStorage.setItem(KEY, mode);
  } catch {
    /* the choice still holds for this session */
  }
};

/** How the mode is named on screen and in the run log. */
export const describeMode = (mode: GroupingMode = groupingMode()): string =>
  mode === 'v3'
    ? 'angle-constrained grouping — cannot-link plus targeted identity questions'
    : mode === 'v2'
      ? 'visual grouping — photographs compared as pictures'
      : 'attribute grouping — photographs compared as descriptions';
