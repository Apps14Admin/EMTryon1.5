/**
 * WHERE THE PRODUCT IS IN EACH REFERENCE PHOTOGRAPH.
 *
 * A product photograph taken on a shop counter is mostly counter. The
 * border-colour cropper in `isolateSubject.ts` handles the clean-backdrop
 * case and refuses the busy one — and the busy one is what real shop
 * photographs are. So the angle classifier, which already looks at every
 * reference photograph once to name its view, is also asked where the product
 * sits in the frame. The answer is remembered here, keyed by the photograph's
 * content, and `evidence.ts` uses it to crop the photograph to the product
 * before it is sent to the render model.
 *
 * Memory only. Photographs live for a session; a box is a few numbers; and a
 * key derived from a megabyte of base64 has no business in local storage.
 */

import type { NormBox } from './box';

/**
 * A cheap, stable key for a base64 payload: FNV-1a over its length, its head,
 * its tail and a stride through the middle. Not cryptographic — it only has
 * to tell one photograph from another within a session, and two different
 * photographs of the same length agreeing on every sampled character is not a
 * case worth defending against.
 */
export const contentKey = (base64: string): string => {
  let hash = 0x811c9dc5;
  const mix = (code: number) => {
    hash ^= code;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  };
  const len = base64.length;
  mix(len & 0xffff);
  mix(len >>> 16);
  const head = Math.min(len, 128);
  for (let i = 0; i < head; i += 1) mix(base64.charCodeAt(i));
  for (let i = Math.max(0, len - 128); i < len; i += 1) mix(base64.charCodeAt(i));
  const stride = Math.max(1, Math.floor(len / 4096));
  for (let i = 128; i < len - 128; i += stride) mix(base64.charCodeAt(i));
  return `${len.toString(36)}-${hash.toString(36)}`;
};

const boxes = new Map<string, NormBox | null>();

/** Records where the product sits in a photograph. `null` records that the model could not say. */
export const rememberProductBox = (fullBase64: string, box: NormBox | null): void => {
  boxes.set(contentKey(fullBase64), box);
};

/** The remembered box, `null` when asked and unknown, `undefined` when never asked. */
export const productBoxFor = (fullBase64: string): NormBox | null | undefined =>
  boxes.get(contentKey(fullBase64));

/** Turns the classifier's [ymin, xmin, ymax, xmax] (0..1000) into a NormBox, or null. */
export const readProductBox = (raw: unknown): NormBox | null => {
  if (!Array.isArray(raw) || raw.length !== 4) return null;
  const nums = raw.map(Number);
  if (nums.some((n) => !Number.isFinite(n))) return null;
  const clamp = (v: number) => Math.min(1, Math.max(0, v / 1000));
  const [ymin, xmin, ymax, xmax] = nums.map(clamp);
  if (xmax <= xmin || ymax <= ymin) return null;
  const area = (xmax - xmin) * (ymax - ymin);
  // A box that is nearly the whole frame crops nothing; one that is a sliver
  // is a tag, not a product.
  if (area < 0.03 || area > 0.92) return null;
  return { xmin, ymin, xmax, ymax };
};

/** Test seam. */
export const forgetProductBoxes = (): void => boxes.clear();
