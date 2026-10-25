import { describe, it, expect } from 'vitest';
import { bindDirectiveReferences, type SlotRefs } from './directiveBinding';

const refs = (over: Partial<SlotRefs> = {}): SlotRefs => ({
  footwear: [2, 3, 4, 5],
  bottoms: [6],
  top: [],
  ...over,
});

describe('bindDirectiveReferences', () => {
  it('rewrites the legacy footwear reference to the photographs that ARE the footwear', () => {
    // The seen failure: the person first, so "Input Image 1" was them and the
    // directive asked for the OLD pair's colorway and logo placement.
    const out = bindDirectiveReferences(
      'Zoom in on the EXACT sneakers from Input Image 1, preserving 100% of their colorway.',
      refs()
    );
    expect(out).toBe(
      'Zoom in on the EXACT sneakers from Input Image 2 + Input Image 3 + Input Image 4 + Input Image 5, preserving 100% of their colorway.'
    );
    expect(out).not.toContain('Input Image 1');
  });

  it('rewrites the legacy bottoms and top references to their own slots', () => {
    const out = bindDirectiveReferences('pants from Input Image 2 and top from Input Image 3.', refs({ top: [7] }));
    expect(out).toBe('pants from Input Image 6 and top from Input Image 7.');
  });

  it('names a slot with no photographs by what it is, never by a stale number', () => {
    const out = bindDirectiveReferences('the exact sneakers from Input Image 1 and the top from Input Image 3.', refs());
    expect(out).toContain('from Input Image 2 + Input Image 3 + Input Image 4 + Input Image 5');
    expect(out).toContain('the top from the uploaded top photographs');
  });

  it('leaves numbers that were never slot references alone', () => {
    expect(bindDirectiveReferences('see Input Image 4 and Input Image 12.', refs())).toBe(
      'see Input Image 4 and Input Image 12.'
    );
  });

  it('is a no-op when the footwear really is Input Image 1', () => {
    const text = 'the exact sneakers from Input Image 1 styled on a shelf.';
    expect(bindDirectiveReferences(text, refs({ footwear: [1] }))).toBe(text);
  });

  it('touches nothing in a directive that names no image', () => {
    const text = 'FLAT LAY PRODUCT DISPLAY: show ONLY the products.';
    expect(bindDirectiveReferences(text, refs())).toBe(text);
  });
});
