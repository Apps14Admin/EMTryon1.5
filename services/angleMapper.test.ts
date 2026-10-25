import { describe, it, expect, vi, beforeEach } from 'vitest';

const { generateContent } = vi.hoisted(() => ({ generateContent: vi.fn() }));

vi.mock('@google/genai', () => ({
  GoogleGenAI: vi.fn().mockImplementation(() => ({ models: { generateContent } })),
}));

import { mapAnglesToSlots, majorityCategory, reasonFor, statusOf, detailOf } from './angleMapper';
import { analysisModel } from './productGrouper';

vi.stubGlobal('window', { location: { origin: 'http://localhost:3000' } });

const SLOTS = ['FRONT', 'BACK', 'LEFT', 'RIGHT', 'SOLE', 'TOP'];
const photos = (count: number) => Array.from({ length: count }, (_, i) => `PHOTO-${i}`);

const reply = (payload: unknown) => ({
  candidates: [
    {
      content: {
        parts: [{ text: typeof payload === 'string' ? payload : JSON.stringify(payload) }],
      },
    },
  ],
});

/** The refusals this endpoint really returns, in the API's own words. */
const CREDITS_DEPLETED =
  'got status: 429 RESOURCE_EXHAUSTED. Your prepayment credits are depleted. ' +
  'Please go to AI Studio at https://ai.studio/projects to manage your project and billing.';
const QUOTA_EXCEEDED =
  'got status: 429 RESOURCE_EXHAUSTED. You exceeded your current quota, please check your plan and billing details.';

beforeEach(() => {
  generateContent.mockReset();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

/**
 * Runs a mapping that will hit the retry path, with the clock under test
 * control. A refusal worth retrying is spaced by seconds of real waiting in
 * the app; making the test sit through it buys nothing.
 */
const mapWithClockAdvanced = async (count: number) => {
  vi.useFakeTimers();
  try {
    const pending = mapAnglesToSlots(photos(count), SLOTS);
    await vi.runAllTimersAsync();
    return await pending;
  } finally {
    vi.useRealTimers();
  }
};

describe('majorityCategory — what kind of product a folder holds', () => {
  it('takes the majority of what the photographs showed', () => {
    expect(majorityCategory(['TOP', 'TOP', 'BOTTOMS'])).toBe('TOP');
  });

  it('never lets OTHER outvote a real category', () => {
    expect(majorityCategory(['OTHER', 'OTHER', 'FOOTWEAR'])).toBe('FOOTWEAR');
    expect(majorityCategory(['OTHER', 'OTHER'])).toBe('OTHER');
  });

  it('answers nothing when nothing was read', () => {
    expect(majorityCategory([undefined, undefined])).toBeUndefined();
  });
});

describe('reasonFor — what actually went wrong', () => {
  it('separates a depleted prepaid balance from a spent quota', () => {
    // Both arrive as 429 RESOURCE_EXHAUSTED and they are different problems:
    // one needs a payment, the other needs a wait. Telling them apart is the
    // whole reason this function exists.
    expect(reasonFor(new Error(CREDITS_DEPLETED))).toBe('credits');
    expect(reasonFor(new Error(QUOTA_EXCEEDED))).toBe('quota');
  });

  it('calls an overloaded model busy, not out of quota', () => {
    expect(reasonFor(new Error('503 Service Unavailable: model is overloaded'))).toBe('busy');
    // A 503 that also mentions RESOURCE_EXHAUSTED must not read as a billing
    // problem — that sends someone to a payment page over a passing spike.
    expect(reasonFor(new Error('503 UNAVAILABLE RESOURCE_EXHAUSTED'))).toBe('busy');
  });

  it('names a retired or unknown model id as a code problem', () => {
    expect(reasonFor(new Error('404 NOT_FOUND: models/gemini-x is not found'))).toBe('missing-model');
    expect(reasonFor(new Error('Unknown name "gemini-x"'))).toBe('missing-model');
  });

  it('names a refused request as a code problem, not an account one', () => {
    expect(reasonFor(new Error('400 INVALID_ARGUMENT: request contains an invalid part'))).toBe(
      'invalid-request'
    );
    expect(reasonFor(new Error('403 PERMISSION_DENIED'))).toBe('invalid-request');
  });

  it('recognises a timeout', () => {
    expect(reasonFor(new Error('The operation was aborted'))).toBe('timeout');
    expect(reasonFor(new Error('504 Gateway Timeout'))).toBe('timeout');
  });

  it('falls back to unreachable only when nothing else fits', () => {
    expect(reasonFor(new Error('fetch failed'))).toBe('unreachable');
  });

  it('reads the status and the upstream wording off the error', () => {
    expect(statusOf(new Error(CREDITS_DEPLETED))).toBe(429);
    expect(statusOf({ status: 503 })).toBe(503);
    expect(statusOf(new Error('something went wrong'))).toBeUndefined();
    expect(detailOf(new Error(CREDITS_DEPLETED))).toContain('prepayment credits are depleted');
  });
});

describe('mapAnglesToSlots — when the analysis fails', () => {
  it('reports depleted credits as credits, with the API wording attached', async () => {
    // The exact failure seen in the running app: every model refuses because
    // the account has no balance, not because a slot could not be judged.
    generateContent.mockRejectedValue(new Error(CREDITS_DEPLETED));

    const result = await mapWithClockAdvanced(3);

    expect(result.classified).toBe(false);
    expect(result.reason).toBe('credits');
    expect(result.status).toBe(429);
    expect(result.detail).toContain('prepayment credits are depleted');
  });

  it('never presents upload order as an answer about the views', async () => {
    generateContent.mockRejectedValue(new Error(CREDITS_DEPLETED));

    const result = await mapWithClockAdvanced(4);

    // Photos still land in slots — the tiles have to be somewhere — but every
    // placement is marked fallback, which is what stops the renderer treating
    // the slot's name as evidence about that photograph.
    expect(result.assignments).toHaveLength(4);
    expect(result.assignments.every((a) => a.source === 'fallback')).toBe(true);
    expect(result.assignments.some((a) => a.source === 'model')).toBe(false);
    expect(result.classified).toBe(false);
  });

  it('sends exactly one request, whatever the failure', async () => {
    generateContent.mockRejectedValue(new Error('404 NOT_FOUND: models/gemini-x is not found'));

    const result = await mapAnglesToSlots(photos(2), SLOTS);

    // One request. No retry ladder and no second model id — what used to be
    // here was three attempts across a two-id walk, up to six billed calls
    // for one drag-and-drop.
    expect(generateContent).toHaveBeenCalledTimes(1);
    expect(result.reason).toBe('missing-model');
  });

  it('does not retry a transient failure either', async () => {
    generateContent.mockRejectedValue(new Error('503 UNAVAILABLE: the model is overloaded'));

    const result = await mapAnglesToSlots(photos(2), SLOTS);

    // A 503 used to be the one thing that DID retry, three times with backoff.
    expect(generateContent).toHaveBeenCalledTimes(1);
    expect(result.reason).toBe('busy');
  });

  it('reports a saturated model as temporary rather than as spent quota', async () => {
    generateContent.mockRejectedValue(new Error('503 UNAVAILABLE: the model is overloaded'));

    const result = await mapWithClockAdvanced(2);

    expect(result.reason).toBe('busy');
    expect(result.classified).toBe(false);
  });

  it('reports a reply it cannot read as unreadable, not as an account problem', async () => {
    generateContent.mockResolvedValue(reply('I had a look and they all seem to be shoes.'));

    const result = await mapAnglesToSlots(photos(2), SLOTS);

    expect(result.reason).toBe('unreadable');
    expect(result.assignments.every((a) => a.source === 'fallback')).toBe(true);
  });

  it('only ever asks the configured model, whatever the failure', async () => {
    generateContent.mockRejectedValue(new Error(CREDITS_DEPLETED));

    await mapWithClockAdvanced(2);

    // The configured model, and nothing else — no 3.6 family, nothing
    // ending in -latest, nothing discovered at runtime.
    generateContent.mock.calls.forEach((call) => {
      expect(call[0].model).toBe(analysisModel());
      expect(call[0].model).not.toMatch(/3\.6|latest|preview|experimental/);
    });
  });
});

describe('mapAnglesToSlots — when the analysis works', () => {
  it('reads the product box and the category off an object reply, and keeps a box even for an unplaced photo', async () => {
    generateContent.mockResolvedValue(
      reply([
        { image: 0, slot: 2, box: [100, 50, 900, 950], category: 'TOP' },
        { image: 1, slot: -1, box: [120, 80, 880, 920], category: 'top' },
        { image: 2, slot: 0, box: [0, 0, 1000, 1000], category: 'hat' },
      ])
    );
    const result = await mapAnglesToSlots(photos(3), SLOTS);
    expect(result.classified).toBe(true);
    expect(result.assignments[0]).toMatchObject({ slot: 2, source: 'model', category: 'TOP' });
    expect(result.assignments[0].box).toEqual({ ymin: 0.1, xmin: 0.05, ymax: 0.9, xmax: 0.95 });
    // Unplaced in a view, but the product is still there to crop to.
    expect(result.assignments[1].source).toBe('fallback');
    expect(result.assignments[1].box).toEqual({ ymin: 0.12, xmin: 0.08, ymax: 0.88, xmax: 0.92 });
    expect(result.assignments[1].category).toBe('TOP');
    // A whole-frame box crops nothing and an unknown category is not one.
    expect(result.assignments[2].box).toBeNull();
    expect(result.assignments[2].category).toBeUndefined();
  });

  it('places each photo in the slot the model named', async () => {
    generateContent.mockResolvedValue(reply([1, 0]));

    const result = await mapAnglesToSlots(photos(2), SLOTS);

    expect(result.classified).toBe(true);
    expect(result.reason).toBeUndefined();
    expect(result.assignments[0]).toMatchObject({ slot: 1, source: 'model' });
    expect(result.assignments[1]).toMatchObject({ slot: 0, source: 'model' });
  });

  it('marks the leftovers of a partial answer as fallback, not as named views', async () => {
    // Two photos judged, one not: the judged ones are evidence, the third is
    // filling a free slot and says so.
    generateContent.mockResolvedValue(reply([2, 0, -1]));

    const result = await mapAnglesToSlots(photos(3), SLOTS);

    expect(result.classified).toBe(true);
    expect(result.assignments.filter((a) => a.source === 'model')).toHaveLength(2);
    expect(result.assignments.filter((a) => a.source === 'fallback')).toHaveLength(1);
  });

  it('sends the photographs and one instruction, on the one routed model', async () => {
    generateContent.mockResolvedValue(reply([0, 1]));

    await mapAnglesToSlots(photos(2), SLOTS);

    const parts = generateContent.mock.calls[0][0].contents.parts;
    expect(parts.filter((p: any) => p.inlineData)).toHaveLength(2);
    expect(parts.filter((p: any) => typeof p.text === 'string')).toHaveLength(1);
    expect(generateContent.mock.calls[0][0].model).toBe(analysisModel());
  });
});

/**
 * THE SAME CLASSIFIER SORTS APPAREL.
 *
 * mapAnglesToSlots takes the slot list as an argument and builds its prompt
 * from it, so the top and bottoms strips reach the same code the footwear
 * strip has always used. These pin that: no apparel-specific ordering exists,
 * and widening the apparel slot list is the whole of the change.
 */
describe('mapAnglesToSlots - apparel uses the footwear classifier', () => {
  const APPAREL = ['FRONT', 'BACK', 'LEFT', 'RIGHT'];

  it('sorts a shirt uploaded back, right, front, left into the right slots', async () => {
    // Upload order is deliberately none of the slot order.
    generateContent.mockResolvedValue(
      reply([
        { image: 0, slot: 1, category: 'TOP' }, // back photo  -> BACK
        { image: 1, slot: 3, category: 'TOP' }, // right photo -> RIGHT
        { image: 2, slot: 0, category: 'TOP' }, // front photo -> FRONT
        { image: 3, slot: 2, category: 'TOP' }, // left photo  -> LEFT
      ])
    );

    const result = await mapAnglesToSlots(photos(4), APPAREL);

    expect(result.classified).toBe(true);
    expect(result.assignments.map((a) => a.slot)).toEqual([1, 3, 0, 2]);
    expect(result.assignments.every((a) => a.source === 'model')).toBe(true);
  });

  it('sorts trousers uploaded in a scrambled order', async () => {
    generateContent.mockResolvedValue(
      reply([
        { image: 0, slot: 2, category: 'BOTTOMS' },
        { image: 1, slot: 0, category: 'BOTTOMS' },
        { image: 2, slot: 3, category: 'BOTTOMS' },
        { image: 3, slot: 1, category: 'BOTTOMS' },
      ])
    );

    const result = await mapAnglesToSlots(photos(4), APPAREL);

    expect(result.assignments.map((a) => a.slot)).toEqual([2, 0, 3, 1]);
  });

  it('offers LEFT and RIGHT to the model for apparel', async () => {
    generateContent.mockResolvedValue(reply([{ image: 0, slot: 0, category: 'TOP' }]));

    await mapAnglesToSlots(photos(1), APPAREL);

    const text = generateContent.mock.calls[0][0].contents.parts.at(-1).text;
    expect(text).toContain('0=FRONT');
    expect(text).toContain('1=BACK');
    expect(text).toContain('2=LEFT');
    expect(text).toContain('3=RIGHT');
    // No sole or top-down face on a garment.
    expect(text).not.toContain('SOLE');
  });

  it('still offers all six faces for footwear', async () => {
    generateContent.mockResolvedValue(reply([{ image: 0, slot: 0, category: 'FOOTWEAR' }]));

    await mapAnglesToSlots(photos(1), SLOTS);

    const text = generateContent.mock.calls[0][0].contents.parts.at(-1).text;
    expect(text).toContain('4=SOLE');
    expect(text).toContain('5=TOP');
  });

  it('leaves a missing angle unfilled rather than inventing one', async () => {
    // Three photos for four slots: whichever slot nothing shows stays empty.
    generateContent.mockResolvedValue(
      reply([
        { image: 0, slot: 0, category: 'TOP' },
        { image: 1, slot: 1, category: 'TOP' },
        { image: 2, slot: 2, category: 'TOP' },
      ])
    );

    const result = await mapAnglesToSlots(photos(3), APPAREL);

    expect(result.assignments).toHaveLength(3);
    expect(result.assignments.map((a) => a.slot).sort()).toEqual([0, 1, 2]);
  });
});
