// services/contactSheet.test.ts
import { describe, expect, it } from 'vitest';
import { LABEL_BAND, anchorSheetLayout, sheetLayout } from './contactSheet';

describe('anchorSheetLayout', () => {
  it('gives the anchor the full left half', () => {
    const layout = anchorSheetLayout(6, 1280);
    const anchor = layout.cells[0];
    expect(anchor.label).toBe(0);
    expect(anchor.x).toBe(0);
    expect(anchor.width).toBeCloseTo(1280 * 0.45, 0);
    expect(anchor.height + LABEL_BAND).toBeLessThanOrEqual(layout.height);
  });
  it('numbers candidates 1..n on the right, none overlapping the anchor', () => {
    const layout = anchorSheetLayout(6, 1280);
    expect(layout.cells.length).toBe(7);
    layout.cells.slice(1).forEach((cell, i) => {
      expect(cell.label).toBe(i + 1);
      expect(cell.x).toBeGreaterThanOrEqual(layout.cells[0].width);
    });
  });
  it('handles a single candidate', () => {
    expect(anchorSheetLayout(1, 1280).cells.length).toBe(2);
  });
  it('leaves the plain grid layout untouched', () => {
    expect(sheetLayout(9).cells.length).toBe(9); // regression guard
  });
});
