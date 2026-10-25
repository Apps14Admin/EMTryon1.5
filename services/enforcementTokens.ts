/**
 * The enforcement contract: the mandatory literal tokens that open every final
 * prompt, and the scope block that tells the model what those tokens mean for
 * THIS render.
 *
 * WHAT THIS ENFORCES. Every render is a generated photograph — there is no
 * base image being edited. So the contract is entirely about the one thing
 * that must not be generated: the PRODUCTS. What appears on a garment in the
 * output is what a photograph of that garment shows, and nothing else. No
 * invented logo, no remembered brand signature, no detail filled in because
 * that kind of product usually has one.
 *
 * TWO RULES GOVERN THIS FILE:
 *
 * 1. The token strings are VERBATIM contract text and are never reworded,
 *    re-punctuated or re-spaced by anything downstream. promptDeployed.ts and
 *    the tests compare against them, and a reworded token silently voids the
 *    guarantee every downstream check relies on.
 *
 * 2. Injection happens in exactly one place: `withEnforcementTokens`, called
 *    by `buildDeployedPrompt`, which every final-prompt path already flows
 *    through (the Gemini engine, the provider-neutral render request that
 *    OpenAI consumes, the batch runner). A prompt exit that does not pass
 *    through it is a bug — add the path to the tests, not a second injection
 *    site.
 */

/** The mode tag. Also the idempotence marker: a prompt carrying it is final. */
export const MODE_TAG = '[MODE: EXACT PRODUCT REPRODUCTION]';

/**
 * The non-generative stance toward the product: it is a thing being
 * photographed, not a subject being designed.
 */
export const TOKEN_BLENDING_ENGINE =
  'Act strictly as a non-generative reproduction engine. Treat each uploaded product as a locked texture map to be wrapped onto the body exactly as photographed, never redesigned.';

/** The cloning mandate: the product's own surface, copied. */
export const TOKEN_GARMENT_CLONING =
  'Exact garment cloning: match color hex, fabric texture, weave, and cuts pixel-for-pixel.';

/** The anti-hallucination mandate: nothing exists in output that no source shows. */
export const TOKEN_ANTI_HALLUCINATION =
  'Strict anti-hallucination constraints: absolutely prohibit inventing, adding, or modifying any logos, branding, text, buckles, hems, or pockets that do not exist in the source product images.';

/** Brand memory is not a source. The single most common way a product comes back wrong. */
export const TOKEN_BRAND_MEMORY =
  'Brand memory is NOT a source: recognising a product\'s brand grants nothing. No signature stripe, swoosh, formstrip, three stripes, chevron, cat, wordmark or any other brand mark is added to a surface the product photographs show without it, and no mark is enlarged, moved, mirrored or completed the way that brand usually does it.';

/**
 * Mark containment. A footwear close-up came back with a PUMA tab on the
 * adidas trousers, and a full-body render added an 'adidas' wordmark beside
 * the 3-bar mark the trousers actually carry. Neither is invention from
 * memory and neither is a brand signature recalled — both are marks MOVING
 * between the products of one render, which the other tokens do not name.
 */
export const TOKEN_MARK_CONTAINMENT =
  'Marks never migrate between products: a logo, wordmark, tab, badge, label or patch belongs ONLY to the supplied product whose own photograph shows it, at that photograph\'s position and size. Never move a mark from one supplied product onto another, never add a second mark beside a real one, and never put one brand\'s mark on another brand\'s garment.';

/** The edge constraint: a product stays on its own silhouette and off the face. */
export const TOKEN_EDGE_BOUNDARY =
  'Hard boundary constraint on garment edges to prevent colour or material bleeding between garments, into the background, or onto the face.';

/**
 * The clothing-boundary correction, from the 2026-09-02 critical correction: a
 * footwear shot came back with the person's trousers repainted, cropped and
 * given invented drawcord cuffs. These three rules keep each product inside
 * its own silhouette.
 *
 * Emitted verbatim only when the render supplies footwear alone — their
 * "trousers untouched" claim would be false the moment a bottom (or top) IS a
 * supplied product, and a false mandate is latitude. `boundaryTokensFor`
 * serves the adapted variant for those renders.
 */
export const TOKEN_STRICT_BOUNDARY_LOCK =
  'STRICT BOUNDARY LOCK: The uploaded footwear must be strictly restricted to the target object\'s own bounding box (the shoes area). Do not let it bleed into, overlap, or modify the pants, socks, or lower legs.';

export const TOKEN_ZERO_CLOTHING_BLENDING =
  'ZERO CLOTHING BLENDING: Never merge, wrap, or graft edges of the uploaded product onto any other clothing (pants/shirt). No part of the footwear\'s material, colour or branding appears above the ankle line.';

export const TOKEN_ISOLATED_REPLACEMENT =
  'ISOLATED REPLACEMENT: Treat the shoes/product as an independent layer placed strictly at the floor contact point, without altering any fabric above the ankle line.';

/** The universal tokens, in emission order. Tests assert each one verbatim. */
export const ENFORCEMENT_TOKENS: string[] = [
  TOKEN_BLENDING_ENGINE,
  TOKEN_GARMENT_CLONING,
  TOKEN_ANTI_HALLUCINATION,
  TOKEN_BRAND_MEMORY,
  TOKEN_MARK_CONTAINMENT,
  TOKEN_EDGE_BOUNDARY,
];

/** The clothing-boundary correction tokens, in emission order. */
export const CLOTHING_BOUNDARY_TOKENS: string[] = [
  TOKEN_STRICT_BOUNDARY_LOCK,
  TOKEN_ZERO_CLOTHING_BLENDING,
  TOKEN_ISOLATED_REPLACEMENT,
];

const FOOTWEAR_SLOT = 'FOOTWEAR / SHOES';

/**
 * The clothing-boundary rules for one render.
 *
 * Verbatim when nothing but (or less than) the footwear is supplied — the
 * correction's exact scenario. When a top or bottom IS a supplied product,
 * the same three rules are re-targeted at every supplied garment's own
 * silhouette, because telling the model the trousers stay untouched while the
 * trousers ARE the product hands it a contradiction, and a contradiction is
 * latitude.
 */
export function boundaryTokensFor(productSlots: string[]): string[] {
  const footwearOnly = productSlots.every((slot) => slot === FOOTWEAR_SLOT);
  if (footwearOnly) return [...CLOTHING_BOUNDARY_TOKENS];

  const target = productSlots.map((slot) => slot.toLowerCase()).join(' + ');
  return [
    `STRICT BOUNDARY LOCK: Each uploaded product must be strictly restricted to its own garment silhouette (${target}). Do not let one product's material, colour or branding bleed into, overlap, or modify another garment, socks, or skin.`,
    'ZERO CLOTHING BLENDING: Never merge, wrap, or graft edges of one uploaded product onto another garment. Every garment keeps its own material, its own colour and its own marks.',
    'ISOLATED REPLACEMENT: Treat each supplied garment as an independent layer seated exactly where it is worn, without altering any fabric outside its own boundary.',
  ];
}

/** What the products of one render are, and what answers the requested view. */
export interface EnforcementScope {
  /**
   * The garment slots this render supplies a product for, by the names the
   * mandate uses ('FOOTWEAR / SHOES', 'PANTS / BOTTOMS', 'TOP / SHIRT /
   * JACKET'). Empty means no product was supplied at all.
   */
  productSlots: string[];
  /** True for shots with no person (shelf, flat lay). */
  productOnly: boolean;
  /** The requested view passed from the matched angle: 'FRONT' | 'BACK' | 'SIDE'. */
  shotView: string;
  /**
   * "Input Image 4 + Input Image 8" — the attached photographs that show the
   * requested face, or '' when none does. Empty names no evidence and the
   * scope says the face is rendered plain instead.
   */
  alignmentEvidence?: string;
}

/**
 * The scope block: the tokens' meaning for one render.
 *
 * Deliberately short. The deployed prompt earns its adherence by being brief;
 * this block binds the tokens to this render and names the one photograph the
 * requested view aligns to — nothing more.
 */
export function buildEnforcementBlock(scope: EnforcementScope): string {
  const productText = scope.productSlots.length
    ? scope.productSlots.join(' + ')
    : 'NO product photograph was supplied — nothing in this render is a specific branded item';

  // What is fixed, and what the render is free to make. Everything that is not
  // a supplied product is a photograph being composed; every supplied product
  // is a fact being reproduced.
  const fixed = scope.productOnly
    ? 'no person appears in the output; the products themselves are fixed and are copied from their photographs, while the surface, staging and lighting around them follow the directives below'
    : 'the person\'s face, identity, build and skin are the athlete photograph\'s own and are never replaced; the supplied products are fixed and are copied from their photographs; the pose, camera and scene follow the directives below';

  const alignment = scope.productOnly
    ? scope.alignmentEvidence
      ? `the attached product photographs (${scope.alignmentEvidence}) are the whole truth of each product; each product is shown from whichever of them matches the view its place in the picture calls for, and no face of it is invented`
      : 'no product photograph was attached — nothing is shown that no photograph supports'
    : scope.alignmentEvidence
      ? `the attached photograph(s) that show this exact face (${scope.alignmentEvidence}) govern how the garment texture wraps onto the body`
      : 'no attached photograph shows this face — it is rendered plain, in the material of the photographed faces, never invented';
  const alignmentLabel = scope.productOnly
    ? 'STRUCTURAL ALIGNMENT — product-only shot'
    : `STRUCTURAL ALIGNMENT — requested view ${scope.shotView}`;

  // A product-only shot has no dressed body for one garment to bleed onto.
  const boundary = scope.productOnly ? [] : boundaryTokensFor(scope.productSlots);

  return [
    MODE_TAG,
    `- ${TOKEN_BLENDING_ENGINE}`,
    `- ${TOKEN_GARMENT_CLONING}`,
    `- ${TOKEN_ANTI_HALLUCINATION}`,
    `- ${TOKEN_BRAND_MEMORY}`,
    `- ${TOKEN_MARK_CONTAINMENT}`,
    `- ${TOKEN_EDGE_BOUNDARY}`,
    ...boundary.map((token) => `- ${token}`),
    '',
    'ENFORCEMENT SCOPE (HOW THESE RULES APPLY TO THIS RENDER):',
    `- THE SUPPLIED PRODUCTS — reproduced exactly, never redesigned: ${productText}.`,
    `- WHAT IS FIXED: ${fixed}.`,
    `- ${alignmentLabel}: ${alignment}.`,
  ].join('\n');
}

/**
 * Prepends the enforcement block to a finished prompt.
 *
 * Idempotent: a prompt already carrying the mode tag comes back unchanged, so
 * a caller that injects twice (a direct build plus a wrapped re-export)
 * cannot ship a doubled contract.
 */
export function withEnforcementTokens(prompt: string, scope: EnforcementScope): string {
  if (prompt.includes(MODE_TAG)) return prompt;
  return `${buildEnforcementBlock(scope)}\n\n${prompt.trimStart()}`;
}
