import { describe, it, expect } from 'vitest';
import {
  MIN_KEEP_PCT, NO_TRIM, describeTrim, hasTrim, moveTrimHandle, pointerPercent, trimRows,
} from './trimCrop';

/**
 * The cutting edge: two lines the reviewer drags in from the top and bottom
 * of a render. The arithmetic here is what both the studio panel and the
 * Library detail view rely on.
 */

const box = { top: 100, height: 400 };

describe('pointerPercent', () => {
  it('maps a pointer inside the box to a percent of its height', () => {
    expect(pointerPercent(100, box)).toBe(0);
    expect(pointerPercent(300, box)).toBe(50);
    expect(pointerPercent(500, box)).toBe(100);
  });

  it('clamps a pointer that leaves the box', () => {
    expect(pointerPercent(-50, box)).toBe(0);
    expect(pointerPercent(900, box)).toBe(100);
  });

  it('is 0 for a box with no height rather than NaN', () => {
    expect(pointerPercent(120, { top: 100, height: 0 })).toBe(0);
  });
});

describe('moveTrimHandle', () => {
  it('drags the top line down to the pointer', () => {
    expect(moveTrimHandle(NO_TRIM, 'top', 25)).toEqual({ top: 25, bottom: 0 });
  });

  it('measures the bottom line from the bottom edge', () => {
    // Pointer at 80% from the top = 20% cut off the bottom.
    expect(moveTrimHandle(NO_TRIM, 'bottom', 80)).toEqual({ top: 0, bottom: 20 });
  });

  it('never lets the two lines close within MIN_KEEP_PCT of each other', () => {
    const withBottom = { top: 0, bottom: 30 };
    expect(moveTrimHandle(withBottom, 'top', 95).top).toBe(100 - 30 - MIN_KEEP_PCT);

    const withTop = { top: 40, bottom: 0 };
    expect(moveTrimHandle(withTop, 'bottom', 5).bottom).toBe(100 - 40 - MIN_KEEP_PCT);
  });

  it('never goes negative or past the edge', () => {
    expect(moveTrimHandle(NO_TRIM, 'top', -20).top).toBe(0);
    expect(moveTrimHandle(NO_TRIM, 'bottom', 140).bottom).toBe(0);
    expect(moveTrimHandle(NO_TRIM, 'bottom', -20).bottom).toBe(100 - MIN_KEEP_PCT);
  });

  it('leaves the other line where it was', () => {
    const trim = { top: 12, bottom: 8 };
    expect(moveTrimHandle(trim, 'top', 20).bottom).toBe(8);
    expect(moveTrimHandle(trim, 'bottom', 70).top).toBe(12);
  });
});

describe('trimRows', () => {
  it('keeps every row when nothing is trimmed', () => {
    expect(trimRows(1600, NO_TRIM)).toEqual({ y: 0, height: 1600 });
  });

  it('cuts whole pixel rows off each edge', () => {
    expect(trimRows(1000, { top: 10, bottom: 20 })).toEqual({ y: 100, height: 700 });
  });

  it('rounds to whole rows', () => {
    expect(trimRows(333, { top: 10, bottom: 0 })).toEqual({ y: 33, height: 300 });
  });

  it('always keeps at least one row', () => {
    expect(trimRows(10, { top: 100, bottom: 100 }).height).toBe(1);
  });
});

describe('hasTrim / describeTrim', () => {
  it('knows an untouched picture from a trimmed one', () => {
    expect(hasTrim(NO_TRIM)).toBe(false);
    expect(hasTrim({ top: 0, bottom: 1 })).toBe(true);
    expect(hasTrim({ top: 3, bottom: 0 })).toBe(true);
  });

  it('describes only the edges that were cut', () => {
    expect(describeTrim(NO_TRIM)).toBe('');
    expect(describeTrim({ top: 12.4, bottom: 0 })).toBe('12% off the top');
    expect(describeTrim({ top: 5, bottom: 7.6 })).toBe('5% off the top, 8% off the bottom');
  });
});
