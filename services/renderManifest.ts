/**
 * THE RENDER MANIFEST.
 *
 * Every render is an explicit instruction, not a request for the model's
 * judgement:
 *
 *     Outfit 1 → Shirt 1 + Pants 1 + Shoes 2 → FRONT CLOSE-UP
 *
 * The manifest names the person the render is of, every product being placed
 * and the exact photographs that ARE that product, and every slot no product
 * was supplied for. The model's job is to execute it. It never chooses,
 * substitutes, combines, re-pairs or infers a product.
 *
 * THE RULE THIS BLOCK EXISTS FOR: a product in the output is the product in
 * its photographs, down to the colourway, the panelling, the sole geometry and
 * the placement of every mark — and a detail no photograph shows is not
 * invented. That is the whole of the enforcement, and it does not depend on
 * anything being preserved from a base image.
 */

import type { ShotView } from './promptDeployed';

export type SlotName = 'footwear' | 'bottoms' | 'top';

/** The slot names as the prompt has always written them. */
export const SLOT_LABELS: Record<SlotName, string> = {
  footwear: 'FOOTWEAR / SHOES',
  bottoms: 'PANTS / BOTTOMS',
  top: 'TOP / SHIRT / JACKET',
};

/** The order slots are listed in, top to toe. */
export const SLOT_ORDER: SlotName[] = ['top', 'bottoms', 'footwear'];

/** The enforcement concept, spelled the way the prompt and the logs use it. */
export const EXACT_PRODUCT = 'THE EXACT PRODUCT, NOTHING INVENTED';

/** What part of the outfit each slot is, in words the model can act on. */
export const SLOT_REGIONS: Record<SlotName, string> = {
  footwear:
    'both shoes, the ankle line where they meet the trousers or socks, and the contact shadow on the floor directly under them',
  bottoms:
    'the trousers / shorts from the waistband to the hem, and the leg openings where they meet the shoes',
  top: 'the top from the collar to its hem, sleeves included, and the line where its hem meets the trousers',
};

export interface ManifestEdit {
  slot: SlotName;
  /** Product name from the folder, when the render came from one. */
  productName?: string;
  /** Every attached photograph of this product, by prompt index. */
  refIdx: number[];
  /** The named views those photographs show, in the same order ('' = unlabelled). */
  views: string[];
}

export interface RenderManifest {
  /** The photograph the render's person — or its environment — comes from. */
  base: {
    idx: number | null;
    /** person = the athlete photograph; environment = a background photograph for a product shot. */
    kind: 'person' | 'environment' | 'none';
  };
  shotView: ShotView;
  /** "Outfit 1", "Product 003" — the label the run gave this render, if any. */
  outfitLabel?: string;
  /** The shot's label ("FRONT SNEAKER CLOSE-UP"), if the caller knows it. */
  shotLabel?: string;
  edits: ManifestEdit[];
  /** Slots no product was supplied for. */
  locked: SlotName[];
  productOnly: boolean;
}

const refOf = (idx: number[]) => idx.map((i) => `Input Image ${i}`).join(' + ');

/** "Shoes 2 + Pants 1" — the human line of the manifest, for logs and the UI. */
export const manifestLine = (m: RenderManifest): string => {
  const products = SLOT_ORDER.filter((s) => m.edits.some((e) => e.slot === s))
    .map((s) => {
      const edit = m.edits.find((e) => e.slot === s)!;
      const name = edit.productName ? ` ${edit.productName}` : '';
      return `${SLOT_LABELS[s].split(' / ')[0]}${name}`;
    })
    .join(' + ');
  const outfit = m.outfitLabel ? `${m.outfitLabel} → ` : '';
  const shot = m.shotLabel ?? m.shotView;
  return `${outfit}${products || 'nothing supplied'} → ${shot}`;
};

/**
 * The manifest as prompt text. Emitted directly after the enforcement tokens
 * and before everything else, because these models weight the head of a
 * prompt hardest and this is the one block that must never be diluted.
 */
export function manifestBlock(m: RenderManifest): string {
  const lines: string[] = [];
  lines.push(
    `RENDER MANIFEST — EXECUTE EXACTLY. THIS IS A PRODUCT PHOTOGRAPHY TASK, NOT A CREATIVE GENERATION TASK. THE PRODUCTS ARE FIXED; ONLY THE PHOTOGRAPH AROUND THEM IS MADE.`
  );
  lines.push(`- JOB: ${manifestLine(m)}.`);

  if (m.productOnly) {
    lines.push(
      m.base.idx
        ? `- ENVIRONMENT: Input Image ${m.base.idx} is the exact setting — its surfaces, fixtures, materials and lighting. No person appears in the output.`
        : `- ENVIRONMENT: as directed below. No person appears in the output.`
    );
  } else if (m.base.idx) {
    lines.push(
      `- THE PERSON: Input Image ${m.base.idx}. The output shows THIS person and no one else — their face, facial geometry, eyes, nose, mouth, jaw, hairline, hair, facial hair, skin tone and texture, apparent age and build are reproduced exactly as that photograph shows them. The person is never replaced, restyled, aged, slimmed, or turned into a different face.`
    );
  }

  const edits = SLOT_ORDER.filter((s) => m.edits.some((e) => e.slot === s)).map(
    (s) => m.edits.find((e) => e.slot === s)!
  );
  edits.forEach((edit, n) => {
    const label = SLOT_LABELS[edit.slot];
    const named = edit.views.filter(Boolean);
    const viewsText =
      edit.refIdx.length > 1
        ? ` (${named.length ? named.join(', ') + ' views' : `${edit.refIdx.length} photographs`} of ONE physical product — never different products)`
        : '';
    lines.push(
      `- PRODUCT ${n + 1} — ${label}${edit.productName ? ` "${edit.productName}"` : ''}: ${
        m.productOnly ? 'show' : 'the person wears'
      } the EXACT product photographed in ${refOf(edit.refIdx)}${viewsText}.${
        m.productOnly ? '' : ` It occupies ${SLOT_REGIONS[edit.slot]}.`
      } Every visible property of it — colourway and colour boundaries, material and weave, panelling and overlays, seams and stitching, hardware, sole and hem geometry, and the position and size of every logo, wordmark or mark — is copied from those photographs and from nothing else.`
    );
  });

  if (!m.productOnly && edits.length) {
    lines.push(
      `- EVERY PRODUCT LISTED ABOVE IS WORN IN THE OUTPUT. The clothing the person happens to wear in their own photograph is NOT an alternative to any of them: a slot with a supplied product shows THAT product, never the garment they were photographed in. A render that returns the person in their own top, their own trousers or their own shoes where a product was supplied is a FAILED RENDER, whatever else it gets right.`
    );
  }

  if (!m.productOnly && m.locked.length) {
    lines.push(
      `- NOT SUPPLIED — ${m.locked
        .map((s) => SLOT_LABELS[s])
        .join(', ')}: no photograph of these was given, so they are rendered PLAIN and unbranded — a simple, neutral garment in a plain colour that suits the scene, carrying NO logo, wordmark, badge, stripe, tape or graphic of any kind. Never borrow a mark from another item in this render.`
    );
  }
  if (!m.productOnly && !edits.length) {
    lines.push(`- NO PRODUCT WAS SUPPLIED. Nothing in this render is a specific branded item.`);
  }

  lines.push(
    `- THE REFERENCE PRODUCT IS THE EXACT PRODUCT. DO NOT CREATE A SIMILAR PRODUCT. Same shape, silhouette, proportions, colour, material, texture, stitching, construction, branding, logo and logo placement, hardware, sole, heel, buckles, seams, pockets, hems and patterns. A detail no photograph shows is NOT invented — it is left plain.`
  );
  lines.push(
    `- NO CREATIVE INTERPRETATION OF THE PRODUCTS. NO INVENTED DETAILS. Recognising a product's brand grants nothing: no signature stripe, swoosh, formstrip, chevron, wordmark or any other mark is added to a surface the photographs show without it.`
  );
  lines.push(
    `- DO NOT choose, substitute, combine, re-pair, swap or infer products. Only the products listed above exist for this render; each one is used in its own listed slot and nowhere else. No product photograph contributes anything outside its slot.`
  );
  lines.push(
    `- OUTPUT = a single photorealistic photograph of the ${m.shotLabel ?? m.shotView} described below, in which every listed product is ${EXACT_PRODUCT}.`
  );
  return lines.join('\n');
}
