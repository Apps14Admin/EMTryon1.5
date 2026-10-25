import { describe, it, expect, beforeEach } from 'vitest';
import {
  contentKey,
  forgetProductBoxes,
  productBoxFor,
  readProductBox,
  rememberProductBox,
} from './productBoxCache';

describe('contentKey', () => {
  it('is stable for the same bytes and different for different bytes', () => {
    const a = 'ABC'.repeat(5000);
    const b = 'ABC'.repeat(4999) + 'ABD';
    expect(contentKey(a)).toBe(contentKey(a));
    expect(contentKey(a)).not.toBe(contentKey(b));
    expect(contentKey('x')).not.toBe(contentKey('xy'));
  });
});

describe('readProductBox', () => {
  it('reads [ymin, xmin, ymax, xmax] on a 0–1000 grid', () => {
    expect(readProductBox([100, 200, 900, 800])).toEqual({ ymin: 0.1, xmin: 0.2, ymax: 0.9, xmax: 0.8 });
  });

  it('rejects a sliver, the whole frame, and garbage', () => {
    expect(readProductBox([0, 0, 1000, 1000])).toBeNull();
    expect(readProductBox([500, 500, 510, 510])).toBeNull();
    expect(readProductBox([900, 800, 100, 200])).toBeNull();
    expect(readProductBox('no')).toBeNull();
    expect(readProductBox([1, 2, 3])).toBeNull();
  });
});

describe('the cache', () => {
  beforeEach(() => forgetProductBoxes());

  it('distinguishes never-asked from asked-and-unknown', () => {
    const photo = 'PHOTO'.repeat(100);
    expect(productBoxFor(photo)).toBeUndefined();
    rememberProductBox(photo, null);
    expect(productBoxFor(photo)).toBeNull();
    rememberProductBox(photo, { xmin: 0.1, ymin: 0.1, xmax: 0.9, ymax: 0.9 });
    expect(productBoxFor(photo)).toEqual({ xmin: 0.1, ymin: 0.1, xmax: 0.9, ymax: 0.9 });
  });
});
