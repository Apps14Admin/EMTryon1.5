/**
 * THE COLOUR OF A GARMENT NOBODY PHOTOGRAPHED.
 *
 * A footwear close-up shows a few inches of trouser whether or not a trouser
 * was supplied. With no trouser photograph the model is already told to render
 * that slot PLAIN — but "plain" says nothing about colour, so it picks one
 * afresh every request, and a five-shot run of the same shoe comes back with
 * black, then beige, then grey legs.
 *
 * This module decides that colour ONCE, from the product that WAS supplied, so
 * the invented garment sits with the real one instead of fighting it.
 *
 * ── THE HARD RULE ─────────────────────────────────────────────────────────
 * A fallback is only ever produced for a slot with NO supplied reference.
 * `fallbackFor` takes the supplied/missing state of every slot and returns
 * `null` for any slot that has a photograph. A supplied garment cannot be
 * recoloured by this module because no value is ever produced for it — the
 * guard is the return type, not a line of prompt text.
 *
 * ── HOW THE COLOUR IS CHOSEN ──────────────────────────────────────────────
 * From the supplied product's own pixels, not a lookup table. `signatureOf`
 * already computes a 4x4x4 RGB histogram of every product photo for the
 * grouper; the heaviest bin of the footwear's histogram is the product's
 * dominant colour. Two properties of that colour drive the choice:
 *
 *   WARMTH    — whether the product leans warm (red/yellow) or cool
 *               (blue/green). The companion leans the same way, which is what
 *               makes a pairing read as coordinated rather than accidental.
 *   LIGHTNESS — the companion moves the other way. A dark product against a
 *               dark trouser loses its silhouette; a light one against light
 *               washes out. Opposing lightness keeps the product readable,
 *               which is the whole point of the picture.
 *
 * The vocabulary is deliberately small and deliberately neutral: these are
 * companion colours, and a companion that competes with the product has
 * failed. No pattern, no branding, no distinctive styling is ever named — the
 * existing plain/unbranded rules still do that work and are not touched.
 */

/** One slot's invented garment, or nothing when the slot has a photograph. */
export interface GarmentFallback {
  /** The colour phrase the prompt uses, e.g. 'warm charcoal'. */
  colour: string;
  /** The full clause dropped into the prompt for this slot. */
  description: string;
}

export interface FallbackDecision {
  bottoms: GarmentFallback | null;
  top: GarmentFallback | null;
}

/** Which slots have a supplied photograph. Mirrors cleanCloth1/2/3. */
export interface SuppliedSlots {
  footwear: boolean;
  bottoms: boolean;
  top: boolean;
}

/** A dominant colour, 0-255 per channel. */
export interface Rgb {
  r: number;
  g: number;
  b: number;
}

/**
 * The heaviest bin of a 4x4x4 RGB histogram, as a colour.
 *
 * The bin index is built in imageSignature.ts as
 * `(r >> 6) * 16 + (g >> 6) * 4 + (b >> 6)`, so each channel keeps its top two
 * bits. Inverting it gives the centre of that bin's range.
 */
export const dominantColourOf = (hist: Float32Array | null | undefined): Rgb | null => {
  if (!hist || hist.length !== 64) return null;

  let best = -1;
  let bestWeight = 0;
  for (let i = 0; i < 64; i += 1) {
    if (hist[i] > bestWeight) {
      bestWeight = hist[i];
      best = i;
    }
  }
  if (best < 0 || bestWeight <= 0) return null;

  const centre = (index: number) => index * 64 + 32;
  return {
    r: centre(Math.floor(best / 16)),
    g: centre(Math.floor((best % 16) / 4)),
    b: centre(best % 4),
  };
};

/** Perceived lightness, 0-1. The same luma weights the difference hash uses. */
const lightnessOf = ({ r, g, b }: Rgb): number => (r * 0.299 + g * 0.587 + b * 0.114) / 255;

/** Positive when the colour leans warm (red/yellow), negative when cool. */
const warmthOf = ({ r, g, b }: Rgb): number => (r - b) / 255;

/**
 * The companion vocabulary: neutral sportswear colours, by warmth and by
 * whether they sit light or dark. Every one of these is a colour a real
 * tracksuit is made in — the fallback has to look like clothing, not like a
 * colour swatch.
 */
const COMPANIONS = {
  warmDark: 'warm charcoal',
  warmLight: 'soft sand',
  coolDark: 'deep slate grey',
  coolLight: 'pale stone grey',
  neutralDark: 'charcoal grey',
  neutralLight: 'light heather grey',
} as const;

/** Picks the companion colour for a product colour. */
export const companionColourFor = (product: Rgb | null): string => {
  // No local opinion — signatureOf returns null without a canvas. A plain
  // mid-grey is the honest answer: neutral, never clashing, and stable.
  if (!product) return COMPANIONS.neutralDark;

  const warmth = warmthOf(product);
  const light = lightnessOf(product);
  // A dark product takes a lighter companion and the reverse, so the product
  // keeps its silhouette against the garment behind it.
  const wantLight = light < 0.45;

  if (warmth > 0.08) return wantLight ? COMPANIONS.warmLight : COMPANIONS.warmDark;
  if (warmth < -0.08) return wantLight ? COMPANIONS.coolLight : COMPANIONS.coolDark;
  return wantLight ? COMPANIONS.neutralLight : COMPANIONS.neutralDark;
};

const CLAUSE: Record<'bottoms' | 'top', (colour: string) => string> = {
  bottoms: (colour) =>
    `No trouser photograph was supplied, so the trousers are plain ${colour} athletic trousers — a single flat colour chosen to sit with the supplied product, with NO logo, wordmark, badge, stripe, tape, panel, print or pattern of any kind. This colour is fixed for every shot in this run.`,
  top: (colour) =>
    `No top photograph was supplied, so the top is a plain ${colour} athletic top — a single flat colour chosen to sit with the supplied product, with NO logo, wordmark, badge, stripe, tape, panel, print or pattern of any kind. This colour is fixed for every shot in this run.`,
};

/**
 * The run's fallback decision.
 *
 * Returns `null` for any slot that HAS a photograph — that is the code-level
 * guard, and it is why a supplied garment can never be recoloured here. Called
 * once per run; the caller holds the result and passes the same one to every
 * shot, which is what stops the colour drifting between angles.
 */
export const fallbackFor = (
  supplied: SuppliedSlots,
  productHist: Float32Array | null | undefined
): FallbackDecision => {
  // Nothing was supplied to coordinate WITH, so there is no coordination to
  // do. The existing plain/unbranded wording still applies on its own.
  if (!supplied.footwear) return { bottoms: null, top: null };

  const colour = companionColourFor(dominantColourOf(productHist));
  const made = (slot: 'bottoms' | 'top'): GarmentFallback => ({
    colour,
    description: CLAUSE[slot](colour),
  });

  return {
    bottoms: supplied.bottoms ? null : made('bottoms'),
    top: supplied.top ? null : made('top'),
  };
};
