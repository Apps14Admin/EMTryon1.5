import { describe, it, expect } from 'vitest';
import { resolveMaxEdge, MAX_EDGE, MIN_EDGE, THUMB_EDGE, formatBytes } from './imageUtils';

describe('resolveMaxEdge', () => {
  it('keeps a real size cap', () => {
    expect(resolveMaxEdge(THUMB_EDGE)).toBe(THUMB_EDGE);
    expect(resolveMaxEdge(1024)).toBe(1024);
  });

  it('falls back when nothing was passed', () => {
    expect(resolveMaxEdge(undefined)).toBe(MAX_EDGE);
  });

  it('refuses an array index arriving as a size cap', () => {
    // `files.map(prepareImageFile)` hands the index in as the cap. A cap of 1
    // produces a one-pixel photo that still renders and still uploads, so it
    // has to be rejected here rather than noticed later.
    [0, 1, 2, 3, 11].forEach((index) => {
      expect(resolveMaxEdge(index)).toBe(MAX_EDGE);
    });
  });

  it('refuses anything below the readable minimum', () => {
    expect(resolveMaxEdge(MIN_EDGE - 1)).toBe(MAX_EDGE);
    expect(resolveMaxEdge(MIN_EDGE)).toBe(MIN_EDGE);
  });

  it('refuses values that are not numbers at all', () => {
    expect(resolveMaxEdge(NaN)).toBe(MAX_EDGE);
    expect(resolveMaxEdge(Infinity)).toBe(MAX_EDGE);
    expect(resolveMaxEdge('768')).toBe(768);
    expect(resolveMaxEdge('big')).toBe(MAX_EDGE);
    expect(resolveMaxEdge(null)).toBe(MAX_EDGE);
  });
});

describe('formatBytes', () => {
  it('reads megabytes above a million', () => {
    expect(formatBytes(2_400_000)).toBe('2.4 MB');
  });

  it('reads kilobytes below that', () => {
    expect(formatBytes(240_000)).toBe('240 KB');
  });

  it('never reports zero for a file that exists', () => {
    expect(formatBytes(120)).toBe('1 KB');
  });
});
