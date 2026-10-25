import { describe, expect, it } from 'vitest';
import { extractJsonArray, extractJsonObject } from './jsonReply';

describe('extractJsonArray', () => {
  it('reads a bare array', () => {
    expect(extractJsonArray('[{"a":1}]')).toEqual([{ a: 1 }]);
  });
  it('reads an array wrapped in prose and fences', () => {
    const text = 'Here you go:\n```json\n[{"photo":0,"same":true}]\n```\nDone.';
    expect(extractJsonArray(text)).toEqual([{ photo: 0, same: true }]);
  });
  it('survives brackets inside strings', () => {
    expect(extractJsonArray('[{"because":"a ] tricky [ one"}]')).toEqual([
      { because: 'a ] tricky [ one' },
    ]);
  });
  it('returns null for truncated JSON rather than guessing', () => {
    expect(extractJsonArray('[{"a":1}')).toBeNull();
  });
  it('returns null when there is no array', () => {
    expect(extractJsonArray('no json here')).toBeNull();
  });
});

describe('extractJsonObject', () => {
  it('reads an object out of prose', () => {
    expect(extractJsonObject('answer: {"same":false,"sure":true}')).toEqual({
      same: false,
      sure: true,
    });
  });
  it('rejects an array as not-an-object', () => {
    expect(extractJsonObject('[1,2]')).toBeNull();
  });
});
