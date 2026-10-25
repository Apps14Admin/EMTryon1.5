// services/identityQuestion.test.ts
import { describe, expect, it } from 'vitest';
import { BECAUSE_WORDS, identityPrompt, readIdentity } from './identityQuestion';

describe('identityPrompt', () => {
  const prompt = identityPrompt(6);
  it('makes NONE an expected answer', () => {
    expect(prompt).toMatch(/NONE OF THEM MAY BE/);
  });
  it('never mentions angles', () => {
    expect(prompt.toLowerCase()).not.toMatch(/\bangle/);
  });
  it('warns against broad similarity', () => {
    expect(prompt).toMatch(/BROAD SIMILARITY IS NOT EVIDENCE/);
  });
  it('names the sole as part of the colourway', () => {
    expect(prompt).toMatch(/SOLE IS PART OF THE COLOURWAY/);
  });
  it('teaches seam continuity across views', () => {
    expect(prompt).toMatch(/EDGES OF NEIGHBOURING SIDES/);
    expect(prompt).toMatch(/CONTINUE/);
  });
});

describe('readIdentity', () => {
  it('reads a well-formed verdict', () => {
    expect(readIdentity(
      [{ photo: 1, same: true, sure: true, because: 'same heel logo' }], 3
    )).toEqual([{ photo: 1, same: true, sure: true, because: 'same heel logo' }]);
  });
  it('treats a missing or non-boolean sure as NOT sure', () => {
    const [a] = readIdentity([{ photo: 1, same: true }], 2);
    expect(a.sure).toBe(false);
    const [b] = readIdentity([{ photo: 1, same: true, sure: 'yes' }], 2);
    expect(b.sure).toBe(false);
  });
  it('drops entries with no readable same field', () => {
    expect(readIdentity([{ photo: 1, sure: true }], 2)).toEqual([]);
  });
  it('drops photo 0 (the anchor cannot answer about itself), out-of-range and duplicates', () => {
    const verdicts = readIdentity([
      { photo: 0, same: true, sure: true },
      { photo: 4, same: true, sure: true },
      { photo: 2, same: false, sure: true },
      { photo: 2, same: true, sure: true },
    ], 3);
    expect(verdicts).toEqual([{ photo: 2, same: false, sure: true, because: undefined }]);
  });
  it(`truncates because to ${BECAUSE_WORDS} words`, () => {
    const [v] = readIdentity([{
      photo: 1, same: false, sure: true,
      because: 'one two three four five six seven eight nine',
    }], 2);
    expect(v.because).toBe('one two three four five six');
  });
});
