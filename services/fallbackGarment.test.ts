import { describe, it, expect } from 'vitest';
import {
  fallbackFor,
  companionColourFor,
  dominantColourOf,
  type SuppliedSlots,
} from './fallbackGarment';

/** A 4x4x4 histogram whose heaviest bin is the given channel indices (0-3). */
const histWith = (ri: number, gi: number, bi: number): Float32Array => {
  const h = new Float32Array(64);
  h[ri * 16 + gi * 4 + bi] = 1;
  return h;
};

// Olive/green: mid green, low red, low blue — the PUMA product in the fixtures.
const OLIVE = histWith(1, 2, 0);
// A bright warm product.
const RUST = histWith(3, 1, 0);
// A cool light product.
const ICE = histWith(2, 3, 3);

const supplied = (o: Partial<SuppliedSlots> = {}): SuppliedSlots => ({
  footwear: true,
  bottoms: false,
  top: false,
  ...o,
});

describe('dominantColourOf', () => {
  it('inverts the bin index back to a colour', () => {
    expect(dominantColourOf(histWith(0, 0, 0))).toEqual({ r: 32, g: 32, b: 32 });
    expect(dominantColourOf(histWith(3, 3, 3))).toEqual({ r: 224, g: 224, b: 224 });
    expect(dominantColourOf(histWith(1, 2, 0))).toEqual({ r: 96, g: 160, b: 32 });
  });

  it('has no opinion without a histogram', () => {
    // signatureOf returns null wherever there is no canvas.
    expect(dominantColourOf(null)).toBeNull();
    expect(dominantColourOf(undefined)).toBeNull();
    expect(dominantColourOf(new Float32Array(64))).toBeNull();
    expect(dominantColourOf(new Float32Array(10))).toBeNull();
  });
});

describe('companionColourFor', () => {
  it('leans warm for a warm product and cool for a cool one', () => {
    expect(companionColourFor({ r: 200, g: 120, b: 40 })).toMatch(/warm|sand/);
    expect(companionColourFor({ r: 40, g: 90, b: 200 })).toMatch(/slate|stone/);
  });

  it('lightens against a dark product and darkens against a light one', () => {
    const againstDark = companionColourFor({ r: 30, g: 30, b: 30 });
    const againstLight = companionColourFor({ r: 230, g: 230, b: 230 });
    expect(againstDark).toMatch(/light|pale|sand/);
    expect(againstLight).toMatch(/charcoal|slate|deep/);
    expect(againstDark).not.toBe(againstLight);
  });

  it('falls back to a neutral when there is no local opinion', () => {
    expect(companionColourFor(null)).toBe('charcoal grey');
  });

  it('is deterministic - the same product always gives the same companion', () => {
    const a = companionColourFor({ r: 96, g: 160, b: 32 });
    const b = companionColourFor({ r: 96, g: 160, b: 32 });
    expect(a).toBe(b);
  });
});

/* ── the hard rule: a supplied garment is never touched ──────────────────── */

describe('a supplied garment never receives a fallback', () => {
  it('supplied blue pants with a green shoe: no pants decision at all', () => {
    const d = fallbackFor(supplied({ bottoms: true }), OLIVE);
    expect(d.bottoms).toBeNull();
  });

  it('supplied shirt with a green shoe: no top decision at all', () => {
    const d = fallbackFor(supplied({ top: true }), OLIVE);
    expect(d.top).toBeNull();
  });

  it('a full outfit produces no fallback decisions whatsoever', () => {
    const d = fallbackFor(supplied({ bottoms: true, top: true }), OLIVE);
    expect(d).toEqual({ bottoms: null, top: null });
  });

  it('mixed case: only the missing slot is decided, the supplied one is not', () => {
    const d = fallbackFor(supplied({ top: true, bottoms: false }), OLIVE);
    expect(d.top).toBeNull();
    expect(d.bottoms).not.toBeNull();
  });

  it('the reverse mixed case behaves the same way', () => {
    const d = fallbackFor(supplied({ bottoms: true, top: false }), OLIVE);
    expect(d.bottoms).toBeNull();
    expect(d.top).not.toBeNull();
  });
});

/* ── what a missing garment gets ─────────────────────────────────────────── */

describe('a missing garment gets a coordinated, plain description', () => {
  it('names a colour derived from the supplied product', () => {
    const d = fallbackFor(supplied(), OLIVE);
    expect(d.bottoms?.colour).toBeTruthy();
    expect(d.bottoms?.description).toContain(d.bottoms!.colour);
  });

  it('forbids every kind of branding and pattern', () => {
    const d = fallbackFor(supplied(), OLIVE);
    for (const banned of ['logo', 'wordmark', 'badge', 'stripe', 'tape', 'panel', 'print', 'pattern']) {
      expect(d.bottoms!.description).toContain(banned);
    }
    expect(d.bottoms!.description).toMatch(/NO logo/);
  });

  it('says the colour is fixed for the run, so the model does not re-pick it', () => {
    const d = fallbackFor(supplied(), OLIVE);
    expect(d.bottoms!.description).toMatch(/fixed for every shot in this run/);
  });

  it('gives both missing slots the same colour, so the outfit coordinates', () => {
    const d = fallbackFor(supplied(), OLIVE);
    expect(d.bottoms!.colour).toBe(d.top!.colour);
  });

  it('produces nothing when there is no supplied product to coordinate with', () => {
    // Nothing was supplied, so there is nothing to harmonise against; the
    // existing plain/unbranded wording stands on its own.
    expect(fallbackFor(supplied({ footwear: false }), OLIVE)).toEqual({ bottoms: null, top: null });
  });

  it('still decides a colour when the histogram is unavailable', () => {
    const d = fallbackFor(supplied(), null);
    expect(d.bottoms?.colour).toBe('charcoal grey');
  });
});

/* ── sequential runs ─────────────────────────────────────────────────────── */

describe('the decision is stable and run-scoped', () => {
  it('recomputing for the same product gives an identical decision', () => {
    // The caller computes this ONCE per run, but even recomputed it cannot
    // drift: the function is pure and the histogram is the only input.
    const a = fallbackFor(supplied(), OLIVE);
    const b = fallbackFor(supplied(), OLIVE);
    expect(a).toEqual(b);
  });

  it('different products reach different decisions', () => {
    const olive = fallbackFor(supplied(), OLIVE);
    const ice = fallbackFor(supplied(), ICE);
    expect(olive.bottoms!.colour).not.toBe(ice.bottoms!.colour);
  });

  it('holds no state between calls', () => {
    // A previous run's product cannot leak into the next: there is nothing to
    // leak through. The module keeps no module-level cache at all.
    const first = fallbackFor(supplied(), RUST);
    const second = fallbackFor(supplied(), ICE);
    const firstAgain = fallbackFor(supplied(), RUST);
    expect(firstAgain).toEqual(first);
    expect(second.bottoms!.colour).not.toBe(first.bottoms!.colour);
  });
});
