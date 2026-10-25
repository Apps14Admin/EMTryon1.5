import { describe, expect, it } from 'vitest';
import { DEFAULT_MODE, describeMode } from './groupingMode';

describe('grouping mode v3', () => {
  it('defaults to v3', () => {
    expect(DEFAULT_MODE).toBe('v3');
  });
  it('describes all three modes distinctly', () => {
    const names = ['v1', 'v2', 'v3'].map((m) => describeMode(m as any));
    expect(new Set(names).size).toBe(3);
  });
});
