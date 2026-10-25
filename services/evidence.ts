/**
 * Render evidence preparation — the product photograph the render model sees.
 *
 * A product photographed on a shop counter is mostly counter. Sent as it is,
 * two thirds of the pixels the render model reads are a red table and a shelf
 * edge, and the sole shape and heel mark that make the product THAT product
 * are the first things lost when the model resolves the frame. So every
 * garment photograph is cropped to the product before it is attached, by the
 * first of two croppers that is confident:
 *
 *   1. the border-colour estimate (`isolateSubject`) — pixel-exact on a clean
 *      backdrop, and it refuses a busy one rather than guess;
 *   2. the box the angle classifier named when it looked at the photograph
 *      (`productBoxCache`) — the semantic answer for the busy backdrop.
 *
 * Neither confident → the photograph goes through untouched. There is no
 * input this refuses: an uncropped photograph is what it would have rendered
 * with anyway.
 *
 * Only product photographs go through here — the athlete photograph is not
 * must carry forward unchanged, and a crop of it would be a change. Only
 * garment photographs are evidence.
 */

import { cropToBox, isolateSubject } from './isolateSubject';
import { productBoxFor } from './productBoxCache';

/**
 * Longest edge of a cropped evidence photograph.
 *
 * A 1K render shows a shoe at 200–400px; evidence at 1024px is 2–5× that, so
 * every mark the output must carry is resolvable in the input. Bigger buys
 * dilution, not fidelity: these models render from the photograph they are
 * given, and a photograph three times the size of the subject it contains is
 * mostly a photograph of something else.
 */
export const EVIDENCE_MAX_EDGE = 1024;

/**
 * One garment photograph, prepared as render evidence. Returns the subject
 * crop when a cropper is confident, and the original otherwise.
 */
export const prepareProductEvidence = async (
  base64: string | null | undefined,
  maxEdge: number = EVIDENCE_MAX_EDGE
): Promise<string | null> => {
  if (!base64) return null;
  try {
    const byBorder = await isolateSubject(base64, maxEdge);
    if (byBorder) return byBorder;

    const box = productBoxFor(base64);
    if (box) {
      const byBox = await cropToBox(base64, box, maxEdge);
      if (byBox) return byBox;
    }
    return base64;
  } catch {
    return base64;
  }
};
