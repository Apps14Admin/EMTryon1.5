/**
 * BINDING A STYLE DIRECTIVE TO THE PHOTOGRAPHS ACTUALLY ATTACHED.
 *
 * The style directives were written for the deployed build's fixed
 * attachment order: the footwear photograph was always Input Image 1, the
 * bottoms Input Image 2, the top Input Image 3. The request assembler now
 * decides the order per render — in a camera-locked sneaker close-up the
 * PERSON is Input Image 1 — and a directive that still said "Zoom in on the
 * EXACT sneakers from Input Image 1, preserving 100% of their colorway … and
 * logo placement" was ordering the model to reproduce the OLD pair worn in
 * the wrong photograph. The strongest product instruction pointed at the
 * wrong photograph, and the renders did what it said.
 *
 * So the assembler binds every directive before it is emitted: "Input Image
 * N" for N in 1..3 is rewritten to the photographs that ARE that slot in this
 * request. A slot with no photographs is named by what it is — "the uploaded
 * footwear photographs" — never left as a number that now means something
 * else. Numbers above 3 were never slot references and pass through.
 */

import type { SlotName } from './renderManifest';

/** The attached photographs of each slot, by prompt index, originals only. */
export type SlotRefs = Record<SlotName, number[]>;

/** The deployed build's fixed order: shoes, then bottoms, then top. */
const LEGACY_SLOT_BY_NUMBER: Record<number, SlotName> = {
  1: 'footwear',
  2: 'bottoms',
  3: 'top',
};

const SLOT_NOUN: Record<SlotName, string> = {
  footwear: 'footwear',
  bottoms: 'bottoms',
  top: 'top',
};

/** "Input Image 2 + Input Image 5" */
export const refText = (idx: number[]): string => idx.map((i) => `Input Image ${i}`).join(' + ');

/**
 * The directive with every legacy slot reference bound to this request's
 * attachments. Pure: same directive and refs in, same text out.
 */
export function bindDirectiveReferences(directive: string, refs: SlotRefs): string {
  return directive.replace(/Input Image (\d+)\b/g, (whole, n: string) => {
    const slot = LEGACY_SLOT_BY_NUMBER[Number(n)];
    if (!slot) return whole;
    const idx = refs[slot] ?? [];
    return idx.length ? refText(idx) : `the uploaded ${SLOT_NOUN[slot]} photographs`;
  });
}
