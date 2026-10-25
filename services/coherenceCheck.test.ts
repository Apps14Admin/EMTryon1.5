// services/coherenceCheck.test.ts
import { describe, expect, it } from 'vitest';
import {
  COHERENCE_MIN_GROUP,
  COHERENCE_SCHEMA,
  coherencePrompt,
  readCoherence,
  partitionByVerdicts,
  CoherenceVerdict,
} from './coherenceCheck';

describe('coherencePrompt', () => {
  const prompt = coherencePrompt(4);
  it('says how many photographs and numbers them 0-based', () => {
    expect(prompt).toMatch(/4 photographs/);
    expect(prompt).toMatch(/numbered 0 to\s+3/);
  });
  it('makes answering every photograph "A" the expected common case', () => {
    expect(prompt).toMatch(/answer every photograph "A"/);
  });
  it('teaches seam continuity, mirroring the identity prompt', () => {
    expect(prompt).toMatch(/EDGES OF NEIGHBOURING SIDES/);
    expect(prompt).toMatch(/CONTINUE/);
  });
  it('judges colourway and construction, never the background', () => {
    expect(prompt).toMatch(/colourways and construction, never the background/);
  });
});

describe('COHERENCE_MIN_GROUP', () => {
  it('is 3', () => {
    expect(COHERENCE_MIN_GROUP).toBe(3);
  });
});

describe('COHERENCE_SCHEMA', () => {
  it('describes an array of {photo, item, sure}, all required, no extras', () => {
    expect(COHERENCE_SCHEMA.type).toBe('array');
    const items = (COHERENCE_SCHEMA as any).items;
    expect(items.required.sort()).toEqual(['item', 'photo', 'sure']);
    expect(items.additionalProperties).toBe(false);
  });
});

describe('readCoherence', () => {
  it('reads a well-formed verdict, uppercasing and trimming the letter', () => {
    expect(readCoherence(
      [{ photo: 0, item: ' a ', sure: true }], 3
    )).toEqual([{ photo: 0, item: 'A', sure: true }]);
  });
  it('drops non-objects', () => {
    expect(readCoherence([null, 'nope', 42, { photo: 0, item: 'A', sure: true }], 3))
      .toEqual([{ photo: 0, item: 'A', sure: true }]);
  });
  it('drops out-of-range photo numbers (0-based, unlike identity)', () => {
    const verdicts = readCoherence([
      { photo: -1, item: 'A', sure: true },
      { photo: 3, item: 'A', sure: true },
      { photo: 0, item: 'A', sure: true },
    ], 3);
    expect(verdicts).toEqual([{ photo: 0, item: 'A', sure: true }]);
  });
  it('drops duplicate photo numbers, keeping the first', () => {
    const verdicts = readCoherence([
      { photo: 0, item: 'A', sure: true },
      { photo: 0, item: 'B', sure: true },
    ], 3);
    expect(verdicts).toEqual([{ photo: 0, item: 'A', sure: true }]);
  });
  it('drops entries with no readable item field, and empty-after-trim items', () => {
    expect(readCoherence([{ photo: 0, sure: true }], 2)).toEqual([]);
    expect(readCoherence([{ photo: 0, item: '   ', sure: true }], 2)).toEqual([]);
    expect(readCoherence([{ photo: 0, item: 42, sure: true }], 2)).toEqual([]);
  });
  it('treats a missing or non-boolean sure as NOT sure', () => {
    const [a] = readCoherence([{ photo: 0, item: 'A' }], 2);
    expect(a.sure).toBe(false);
    const [b] = readCoherence([{ photo: 0, item: 'A', sure: 'yes' }], 2);
    expect(b.sure).toBe(false);
  });
});

describe('partitionByVerdicts', () => {
  it('all one letter -> a single partition (the good case)', () => {
    const verdicts: CoherenceVerdict[] = [
      { photo: 0, item: 'A', sure: true },
      { photo: 1, item: 'A', sure: true },
      { photo: 2, item: 'A', sure: true },
    ];
    expect(partitionByVerdicts(3, verdicts)).toEqual([[0, 1, 2]]);
  });
  it('two letters -> two partitions, ordered by first member, folder order inside each', () => {
    const verdicts: CoherenceVerdict[] = [
      { photo: 0, item: 'A', sure: true },
      { photo: 1, item: 'A', sure: true },
      { photo: 2, item: 'B', sure: true },
    ];
    expect(partitionByVerdicts(3, verdicts)).toEqual([[0, 1], [2]]);
  });
  it('a photo with no verdict becomes its own singleton partition (split-safe)', () => {
    const verdicts: CoherenceVerdict[] = [
      { photo: 0, item: 'A', sure: true },
      { photo: 2, item: 'A', sure: true },
      // photo 1 has no verdict at all - it must not silently inherit 'A'
    ];
    expect(partitionByVerdicts(3, verdicts)).toEqual([[0, 2], [1]]);
  });
  it('is deterministic for the same input', () => {
    const verdicts: CoherenceVerdict[] = [
      { photo: 0, item: 'B', sure: true },
      { photo: 1, item: 'A', sure: true },
      { photo: 2, item: 'B', sure: true },
      { photo: 3, item: 'A', sure: false },
    ];
    const one = partitionByVerdicts(4, verdicts);
    const two = partitionByVerdicts(4, verdicts);
    expect(one).toEqual(two);
    expect(one).toEqual([[0, 2], [1, 3]]);
  });
});
