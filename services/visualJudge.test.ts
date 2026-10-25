import { describe, expect, it } from 'vitest';
import {
  SURE,
  UNSURE,
  extractArray,
  extractObject,
  judgePrompt,
  readTieBreak,
  readVerdicts,
  toJudgements,
} from './visualJudge';
import { cluster } from './signedGraph';

const idOf = (photo: number) => `img-${photo}`;

describe('extractArray', () => {
  it('reads a bare array', () => {
    expect(extractArray('[{"photo":0,"item":"A"}]')).toHaveLength(1);
  });

  it('reads an array inside a code fence', () => {
    expect(extractArray('```json\n[{"photo":0,"item":"A"}]\n```')).toHaveLength(1);
  });

  it('reads an array after prose', () => {
    expect(extractArray('Here is my answer:\n[{"photo":0,"item":"A"}]')).toHaveLength(1);
  });

  it('is not fooled by a bracket inside a string', () => {
    const parsed = extractArray('[{"because":"a [bracket] here","item":"A","photo":0}]') as any[];
    expect(parsed[0].because).toBe('a [bracket] here');
  });

  it('is not fooled by an escaped quote inside a string', () => {
    const parsed = extractArray('[{"because":"say \\"hi\\"","item":"A","photo":0}]') as any[];
    expect(parsed[0].because).toBe('say "hi"');
  });

  it('returns null for a reply with no array', () => {
    expect(extractArray('I cannot help with that.')).toBeNull();
  });

  it('returns null for a truncated array rather than half an answer', () => {
    expect(extractArray('[{"photo":0,"item":"A"}')).toBeNull();
  });
});

describe('extractObject', () => {
  it('reads an object out of a fenced reply', () => {
    expect(extractObject('```json\n{"same":true}\n```')).toEqual({ same: true });
  });

  it('returns null when there is only an array', () => {
    expect(extractObject('[1,2,3]')).toBeNull();
  });
});

describe('readVerdicts', () => {
  it('reads a straight answer', () => {
    const verdicts = readVerdicts(
      [
        { photo: 0, item: 'A', because: 'white outsole', sure: true },
        { photo: 1, item: 'B', because: 'gum sole', sure: true },
      ],
      2
    );

    expect(verdicts).toEqual([
      { photo: 0, item: 'A', because: 'white outsole', sure: true },
      { photo: 1, item: 'B', because: 'gum sole', sure: true },
    ]);
  });

  it('uppercases the letter so "a" and "A" are one item', () => {
    expect(readVerdicts([{ photo: 0, item: 'a' }], 1)[0].item).toBe('A');
  });

  it('falls back to position when the model omitted the number', () => {
    const verdicts = readVerdicts([{ item: 'A' }, { item: 'B' }], 2);
    expect(verdicts.map((v) => v.photo)).toEqual([0, 1]);
  });

  it('drops a photograph numbered outside the sheet', () => {
    expect(readVerdicts([{ photo: 9, item: 'A' }], 3)).toEqual([]);
  });

  it('drops a second claim on one photograph rather than overwriting', () => {
    const verdicts = readVerdicts(
      [
        { photo: 0, item: 'A' },
        { photo: 0, item: 'B' },
      ],
      2
    );
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0].item).toBe('A');
  });

  it('drops an entry with no letter rather than inventing one', () => {
    expect(readVerdicts([{ photo: 0, item: '' }, { photo: 1 }], 2)).toEqual([]);
  });

  it('treats an omitted "sure" as sure, and anything non-true as unsure', () => {
    expect(readVerdicts([{ photo: 0, item: 'A' }], 1)[0].sure).toBe(true);
    expect(readVerdicts([{ photo: 0, item: 'A', sure: 'yes' }], 1)[0].sure).toBe(false);
    expect(readVerdicts([{ photo: 0, item: 'A', sure: false }], 1)[0].sure).toBe(false);
  });

  it('ignores entries that are not objects', () => {
    expect(readVerdicts(['nonsense', null, 42, { photo: 3, item: 'A' }], 4)).toHaveLength(1);
  });
});

describe('toJudgements', () => {
  it('emits a SAME for a shared letter', () => {
    const judgements = toJudgements(
      [
        { photo: 0, item: 'A', sure: true },
        { photo: 1, item: 'A', sure: true },
      ],
      idOf
    );

    expect(judgements).toHaveLength(1);
    expect(judgements[0]).toMatchObject({ a: 'img-0', b: 'img-1', same: true, confidence: SURE });
  });

  it('emits a DIFFERENT for two committed letters — the point of asking this way', () => {
    const judgements = toJudgements(
      [
        { photo: 0, item: 'A', sure: true, because: 'white sole' },
        { photo: 1, item: 'B', sure: true, because: 'gum sole' },
      ],
      idOf
    );

    expect(judgements[0].same).toBe(false);
    expect(judgements[0].reason).toBe('gum sole');
  });

  it('emits NO different when either photograph was unsure', () => {
    const judgements = toJudgements(
      [
        { photo: 0, item: 'A', sure: true },
        { photo: 1, item: 'B', sure: false },
      ],
      idOf
    );

    expect(judgements).toEqual([]);
  });

  it('still emits a weak SAME when a photograph was unsure', () => {
    const judgements = toJudgements(
      [
        { photo: 0, item: 'A', sure: true },
        { photo: 1, item: 'A', sure: false },
      ],
      idOf
    );

    expect(judgements[0]).toMatchObject({ same: true, confidence: UNSURE });
  });

  it('answers every pair on the sheet, not just the anchor', () => {
    // Nine photographs answer thirty-six pairs in one request. This ratio is
    // what makes the architecture affordable.
    const verdicts = Array.from({ length: 9 }, (_, i) => ({
      photo: i,
      item: String.fromCharCode(65 + (i % 3)),
      sure: true,
    }));

    expect(toJudgements(verdicts, idOf)).toHaveLength(36);
  });

  it('skips a photograph with no id behind it', () => {
    const judgements = toJudgements(
      [
        { photo: 0, item: 'A', sure: true },
        { photo: 1, item: 'A', sure: true },
      ],
      (photo) => (photo === 1 ? undefined : 'img-0')
    );

    expect(judgements).toEqual([]);
  });

  it('carries the source through, so two providers can be told apart', () => {
    const judgements = toJudgements(
      [
        { photo: 0, item: 'A', sure: true },
        { photo: 1, item: 'A', sure: true },
      ],
      idOf,
      'openai'
    );

    expect(judgements[0].source).toBe('openai');
  });
});

describe('readTieBreak', () => {
  it('reads a committed answer', () => {
    expect(readTieBreak('{"same":false,"because":"gum sole","sure":true}')).toEqual({
      same: false,
      because: 'gum sole',
    });
  });

  it('settles nothing when the tie-breaker was unsure', () => {
    expect(readTieBreak('{"same":true,"because":"maybe","sure":false}')).toBeNull();
  });

  it('settles nothing when the reply is unreadable', () => {
    expect(readTieBreak('I think they might be the same?')).toBeNull();
  });

  it('settles nothing when "same" is not a boolean', () => {
    expect(readTieBreak('{"same":"yes"}')).toBeNull();
  });
});

describe('a sheet answer, end to end', () => {
  it('turns one reply into products', () => {
    const reply = `\`\`\`json
[{"photo":0,"item":"A","because":"white outsole, hexagonal tread","sure":true},
 {"photo":1,"item":"A","because":"same tread from underneath","sure":true},
 {"photo":2,"item":"A","because":"same shoe, rear view","sure":true},
 {"photo":3,"item":"B","because":"gum sole, not white","sure":true},
 {"photo":4,"item":"B","because":"same gum sole","sure":true}]
\`\`\``;

    const entries = extractArray(reply)!;
    const verdicts = readVerdicts(entries, 5);
    const judgements = toJudgements(verdicts, idOf, 'gemini');
    const { clusters } = cluster(
      ['img-0', 'img-1', 'img-2', 'img-3', 'img-4'],
      judgements
    );

    expect(clusters.map((ids) => ids.sort())).toEqual([
      ['img-0', 'img-1', 'img-2'],
      ['img-3', 'img-4'],
    ]);
  });

  it('lets one sheet\'s DIFFERENT refuse another sheet\'s SAME', () => {
    // Sheet one saw photographs 0 and 1 together and separated them.
    const sheetOne = toJudgements(
      [
        { photo: 0, item: 'A', sure: true, because: 'white lining' },
        { photo: 1, item: 'B', sure: true, because: 'black lining' },
      ],
      idOf,
      'gemini'
    );

    // Sheet two saw 1 and 2 and joined them; sheet three saw 0 and 2 and
    // joined them. Those two joins together would merge 0 with 1.
    const sheetTwo = toJudgements(
      [
        { photo: 1, item: 'A', sure: true },
        { photo: 2, item: 'A', sure: true },
      ],
      idOf,
      'gemini'
    );
    const sheetThree = toJudgements(
      [
        { photo: 0, item: 'A', sure: true },
        { photo: 2, item: 'A', sure: true },
      ],
      idOf,
      'gemini'
    );

    const { clusters, contradictions } = cluster(
      ['img-0', 'img-1', 'img-2'],
      [...sheetOne, ...sheetTwo, ...sheetThree]
    );

    expect(clusters).toHaveLength(2);
    expect(contradictions).toHaveLength(1);
  });
});

describe('judgePrompt', () => {
  it('names the real photograph count and the real last number', () => {
    const text = judgePrompt(9);
    expect(text).toContain('9 product photographs');
    expect(text).toContain('0 to 8');
  });

  it('tells the model a single-photograph item is a normal answer', () => {
    // Without this the model sorts every sheet into two or three big piles,
    // which is the failure the old consolidation prompt kept hitting.
    expect(judgePrompt(9)).toContain('A letter used by exactly one photograph');
  });
});
