import { describe, it, expect, vi, beforeEach } from 'vitest';

const { generateContent } = vi.hoisted(() => ({ generateContent: vi.fn() }));

vi.mock('@google/genai', () => ({
  GoogleGenAI: vi.fn().mockImplementation(() => ({ models: { generateContent } })),
}));

import {
  groupFolder,
  clearAttributeCache,
  ANALYSIS_MODEL,
  analysisModel,
  type FolderImage,
} from './productGrouper';
import { GEMINI_MODEL_IDS } from './aiModels';

vi.stubGlobal('window', { location: { origin: 'http://localhost:3000' } });

/** A reply in the shape the SDK hands back. */
const reply = (payload: unknown) => ({
  candidates: [
    {
      content: {
        parts: [{ text: typeof payload === 'string' ? payload : JSON.stringify(payload) }],
      },
    },
  ],
});

const folder = (count: number): FolderImage[] =>
  Array.from({ length: count }, (_, i) => ({
    id: `img-${i}`,
    fileName: `IMG_${String(i + 1).padStart(3, '0')}.jpg`,
    full: `FULL-${i}`,
    thumb: `THUMB-${i}`,
    scout: `SCOUT-${i}`,
  }));

/** Image ids per group, so membership can be asserted without ordering noise. */
const membership = (groups: { images: { imageId: string }[] }[]) =>
  groups.map((g) => g.images.map((i) => i.imageId).sort());

const partsOf = (callIndex: number): any[] =>
  generateContent.mock.calls[callIndex][0].contents.parts;

const textPartsOf = (callIndex: number): string[] =>
  partsOf(callIndex)
    .filter((part) => typeof part.text === 'string')
    .map((part) => part.text);

const imagePartsOf = (callIndex: number): string[] =>
  partsOf(callIndex)
    .filter((part) => part.inlineData)
    .map((part) => part.inlineData.data);

const modelOf = (callIndex: number): string => generateContent.mock.calls[callIndex][0].model;

/**
 * Calls that were a BATCH READ, as opposed to a consolidation or an audit.
 *
 * The batching assertions below are about how the folder is cut into reading
 * requests, and that number should not move because a later verification pass
 * was added or its budget changed. So they count the reads rather than the
 * calls.
 */
const batchCalls = (): number =>
  generateContent.mock.calls.filter((call: any) =>
    (call[0].contents.parts as any[]).some(
      (part) =>
        typeof part.text === 'string' && part.text.includes('FOR EACH PHOTOGRAPH, REPORT')
    )
  ).length;

/** Calls that showed one pre-grouped product's photographs together. */
const auditCalls = (): number =>
  generateContent.mock.calls.filter((call: any) =>
    (call[0].contents.parts as any[]).some(
      (part) =>
        typeof part.text === 'string' &&
        part.text.includes('pre-grouped by deterministic visual rules')
    )
  ).length;

beforeEach(() => {
  generateContent.mockReset();
  // Readings are cached by image CONTENT for the life of the session, so two
  // tests built from the same fixture would otherwise share answers and the
  // second would send nothing. A test asserting what goes on the wire has to
  // start from an empty cache.
  clearAttributeCache();
});

describe('groupFolder — grouping', () => {
  it('puts photos of one product together, mixed order and all', async () => {
    // Six photos, three products, interleaved the way a real folder is.
    generateContent.mockResolvedValue(
      reply([
        { image: 0, product: 'A', angle: 'FRONT', colour: 'grey white' },
        { image: 1, product: 'B', angle: 'FRONT', colour: 'black' },
        { image: 2, product: 'A', angle: 'RIGHT', colour: 'grey white' },
        { image: 3, product: 'C', angle: 'TOP', colour: 'olive' },
        { image: 4, product: 'B', angle: 'LEFT', colour: 'black' },
        { image: 5, product: 'A', angle: 'SOLE', colour: 'grey white' },
      ])
    );

    const result = await groupFolder(folder(6));

    expect(result.classified).toBe(true);
    expect(membership(result.groups)).toEqual([
      ['img-0', 'img-2', 'img-5'],
      ['img-1', 'img-4'],
      ['img-3'],
    ]);
  });

  it('does the whole thing in one request for a folder this size', async () => {
    generateContent.mockResolvedValue(
      reply([
        { image: 0, product: 'A', angle: 'FRONT' },
        { image: 1, product: 'A', angle: 'BACK' },
      ])
    );

    await groupFolder(folder(2));

    // One READ. The two photos are then shown to the model together to confirm
    // they really are one product, which is a second call and a different
    // question.
    expect(batchCalls()).toBe(1);
    expect(auditCalls()).toBe(1);
  });

  it('labels each photo with its angle from the same answer', async () => {
    generateContent.mockResolvedValue(
      reply([
        { image: 0, product: 'A', angle: 'SOLE' },
        { image: 1, product: 'A', angle: 'FRONT' },
      ])
    );

    const result = await groupFolder(folder(2));

    expect(result.groups[0].images.map((i) => i.view)).toEqual(['SOLE', 'FRONT']);
    expect(result.groups[0].images.every((i) => i.viewSource === 'model')).toBe(true);
  });

  it('accepts any number of photos per product', async () => {
    generateContent.mockResolvedValue(
      reply([
        { image: 0, product: 'A', angle: 'FRONT' },
        { image: 1, product: 'A', angle: 'BACK' },
        { image: 2, product: 'A', angle: 'LEFT' },
        { image: 3, product: 'A', angle: 'SOLE' },
        { image: 4, product: 'B', angle: 'FRONT' },
        { image: 5, product: 'C', angle: 'FRONT' },
        { image: 6, product: 'C', angle: 'TOP' },
      ])
    );

    const result = await groupFolder(folder(7));

    expect(result.groups.map((g) => g.images.length)).toEqual([4, 1, 2]);
  });

  it('reads loose angle wording', async () => {
    generateContent.mockResolvedValue(
      reply([
        { image: 0, product: 'A', angle: 'outsole' },
        { image: 1, product: 'A', angle: 'rear' },
      ])
    );

    const result = await groupFolder(folder(2));
    expect(result.groups[0].images.map((i) => i.view)).toEqual(['SOLE', 'BACK']);
  });

  it('keeps a photo out of a product of another colour', async () => {
    generateContent.mockResolvedValue(
      reply([
        { image: 0, product: 'A', angle: 'FRONT', colour: 'grey white' },
        { image: 1, product: 'A', angle: 'BACK', colour: 'olive green' },
      ])
    );

    const result = await groupFolder(folder(2));

    expect(result.groups).toHaveLength(2);
    expect(result.log.join('\n')).toMatch(/another colour — "olive green" vs "grey white"/);
  });

  it('gives a photo the model ignored its own product, flagged', async () => {
    generateContent.mockResolvedValue(reply([{ image: 0, product: 'A', angle: 'FRONT' }]));

    const result = await groupFolder(folder(2));

    expect(result.groups).toHaveLength(2);
    expect(result.groups[1].needsReview).toBe(true);
  });
});

describe('groupFolder — across batches', () => {
  /** How many photographs one request actually carried. */
  const askedIn = (callIndex: number) => imagePartsOf(callIndex).length;

  it('repeats the tail of a request in the next one, and joins them by it', async () => {
    // 26 photos is two requests. The second one is told the overlapping photos
    // belong to its own product, which is what fuses the two answers.
    //
    // CLOSEUP throughout on purpose: a product has one FRONT and one SOLE, and
    // sixteen photographs of one product all answering FRONT would be refused
    // by the angle rule before the overlap ever got a say. Close-ups are the
    // one view a product may legitimately have any number of.
    generateContent
      .mockResolvedValueOnce(
        reply(
          Array.from({ length: 16 }, (_, i) => ({
            image: i,
            product: 'A',
            angle: 'CLOSEUP',
            colour: 'black',
          }))
        )
      )
      .mockResolvedValueOnce(
        reply(
          Array.from({ length: 12 }, (_, i) => ({
            image: i,
            product: 'X',
            angle: 'CLOSEUP',
            colour: 'black',
          }))
        )
      );

    const result = await groupFolder(folder(26));

    expect(batchCalls()).toBe(2);
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].images).toHaveLength(26);
  });

  it('carries no representative of an already-known product', async () => {
    generateContent.mockImplementation(async (request: any) => {
      const count = request.contents.parts.filter((p: any) => p.inlineData).length;
      return reply(
        Array.from({ length: count }, (_, i) => ({ image: i, product: `P${i}`, angle: 'FRONT' }))
      );
    });

    await groupFolder(folder(26));

    // Sixteen photos, then the two repeated from that request plus the last
    // ten — and nothing else. The old design sent a photo of every product
    // found so far, which is why each request had to wait for the last.
    expect(askedIn(0)).toBe(16);
    expect(askedIn(1)).toBe(12);
    expect(imagePartsOf(1).slice(0, 2)).toEqual(['SCOUT-14', 'SCOUT-15']);
    expect(textPartsOf(1).join(' ')).not.toMatch(/P0:/);
  });

  it('runs requests at the same time rather than one after another', async () => {
    let inFlight = 0;
    let peak = 0;

    generateContent.mockImplementation(async (request: any) => {
      const count = request.contents.parts.filter((p: any) => p.inlineData).length;
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return reply(
        Array.from({ length: count }, (_, i) => ({ image: i, product: `P${i}`, angle: 'FRONT' }))
      );
    });

    await groupFolder(folder(60));

    expect(generateContent.mock.calls.length).toBeGreaterThan(2);
    expect(peak).toBeGreaterThan(1);
  });

  it('hands the products it has found to the screen before it finishes', async () => {
    generateContent.mockImplementation(async (request: any) => {
      const count = request.contents.parts.filter((p: any) => p.inlineData).length;
      return reply(
        Array.from({ length: count }, (_, i) => ({ image: i, product: 'A', angle: 'FRONT' }))
      );
    });

    const seen: number[] = [];
    await groupFolder(folder(60), undefined, undefined, (groups) => seen.push(groups.length));

    // One update per request that lands, not a single one at the end.
    expect(seen.length).toBeGreaterThan(1);
    expect(seen[0]).toBeGreaterThan(0);
  });
});

describe('groupFolder — failure is shown, never disguised', () => {
  it('reports an unreadable reply instead of one product per photo', async () => {
    generateContent.mockResolvedValue(reply('I am not able to tell these apart.'));

    const result = await groupFolder(folder(4));

    expect(result.classified).toBe(false);
    expect(result.groups).toEqual([]);
    expect(result.error).toMatch(/did not answer with a grouping/i);
    expect(result.rawReply).toMatch(/not able to tell/);
  });

  it('reports a reply that names no products', async () => {
    generateContent.mockResolvedValue(reply([{ image: 0 }, { image: 1 }]));

    const result = await groupFolder(folder(2));

    expect(result.classified).toBe(false);
    expect(result.groups).toEqual([]);
    expect(result.error).toMatch(/named no products/i);
  });

  it('says so when the reply has no text at all', async () => {
    generateContent.mockResolvedValue({
      candidates: [{ content: { parts: [{ inlineData: {} }] } }],
    });

    const result = await groupFolder(folder(2));

    expect(result.classified).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it('surfaces a spent quota in words', async () => {
    generateContent.mockRejectedValue(new Error('429 RESOURCE_EXHAUSTED'));

    const result = await groupFolder(folder(3));

    expect(result.classified).toBe(false);
    expect(result.groups).toEqual([]);
    expect(result.error).toMatch(/quota is exhausted/i);
    expect(result.error).toMatch(/429/);
  });

  it('surfaces a refused key in words', async () => {
    generateContent.mockRejectedValue(new Error('403 permission denied'));

    const result = await groupFolder(folder(2));
    expect(result.error).toMatch(/key was refused/i);
  });

  it('gives an empty folder nothing to do', async () => {
    const result = await groupFolder([]);
    expect(result).toEqual({ groups: [], unassigned: [], classified: true, log: [] });
    expect(generateContent).not.toHaveBeenCalled();
  });
});

describe('groupFolder — the configured model, used once', () => {
  it('analyses with the one configured model', async () => {
    generateContent.mockResolvedValue(reply([{ image: 0, product: 'A', angle: 'FRONT' }]));

    await groupFolder(folder(1));

    expect(modelOf(0)).toBe(ANALYSIS_MODEL);
    expect(modelOf(0)).toBe(analysisModel());
  });

  it('does NOT walk to another model when the id is missing', async () => {
    generateContent.mockRejectedValue(new Error('404 model not found'));

    const result = await groupFolder(folder(1));

    // The old behaviour tried a second id here. A missing model is a failure,
    // not a reason to spend another request.
    expect(generateContent).toHaveBeenCalledTimes(1);
    expect(result.classified).toBe(false);
    expect(result.error).toContain(analysisModel());
  });

  it('does NOT walk to another model when the first is rate limited', async () => {
    generateContent.mockRejectedValue(new Error('429 RESOURCE_EXHAUSTED'));

    const result = await groupFolder(folder(1));

    expect(generateContent).toHaveBeenCalledTimes(1);
    expect(result.classified).toBe(false);
    expect(result.error).toMatch(/quota is exhausted/i);
  });

  it('only ever uses a configured Gemini id', async () => {
    generateContent.mockResolvedValue(reply([{ image: 0, product: 'A', angle: 'FRONT' }]));

    await groupFolder(folder(1));

    expect(GEMINI_MODEL_IDS).toContain(modelOf(0));
  });

  it('never reaches a 3.6 or a -latest id', async () => {
    generateContent.mockRejectedValue(new Error('429 RESOURCE_EXHAUSTED'));

    await groupFolder(folder(1));

    generateContent.mock.calls.forEach((call) => {
      expect(call[0].model).not.toMatch(/3\.6/);
      expect(call[0].model).not.toMatch(/latest|preview|experimental/);
    });
  });

  it('reports a timeout as a timeout, not as the raw abort wording', async () => {
    generateContent.mockRejectedValue(new Error('signal is aborted without reason'));

    const result = await groupFolder(folder(1));

    expect(result.classified).toBe(false);
    expect(generateContent).toHaveBeenCalledTimes(1);
  });
});

describe('groupFolder — evidence discipline', () => {
  it('never sends a filename to the model', async () => {
    generateContent.mockResolvedValue(reply([{ image: 0, product: 'A', angle: 'FRONT' }]));

    await groupFolder(folder(2));

    const everyText = generateContent.mock.calls
      .flatMap((call) => call[0].contents.parts as any[])
      .filter((part) => typeof part.text === 'string')
      .map((part) => part.text)
      .join('\n');

    expect(everyText).not.toMatch(/IMG_/);
    expect(everyText).not.toMatch(/\.jpg/);
  });

  it('never sends the full-size photos', async () => {
    generateContent.mockResolvedValue(reply([{ image: 0, product: 'A', angle: 'FRONT' }]));

    await groupFolder(folder(1));

    expect(imagePartsOf(0).every((data) => !data.startsWith('FULL-'))).toBe(true);
  });

  it('sends the smallest copy, not the one the review grid shows', async () => {
    generateContent.mockResolvedValue(reply([{ image: 0, product: 'A', angle: 'FRONT' }]));

    await groupFolder(folder(1));

    expect(imagePartsOf(0)).toEqual(['SCOUT-0']);
  });

  it('tells the model a new angle is not a new product', async () => {
    generateContent.mockResolvedValue(reply([{ image: 0, product: 'A', angle: 'FRONT' }]));

    await groupFolder(folder(1));

    expect(textPartsOf(0).join(' ')).toMatch(/DIFFERENT CAMERA ANGLE IS NOT A DIFFERENT PRODUCT/i);
  });
});

/**
 * These assert the wording that stops a reading describing THE PART IN FRAME
 * instead of THE ITEM.
 *
 * They exist because a real folder of a hundred and ten black sneakers failed
 * on exactly this. Photographs of one shoe were split apart by answers that
 * were each individually correct: the sole shot reported colour "white" for a
 * black shoe with a white outsole, and material "rubber" for the sole of a
 * mesh trainer, so the upper shot and the sole shot of one item described two
 * different items. None of it is visible in the code — the whole fix lives in
 * the prompt — so the prompt is what has to be tested.
 */
describe('groupFolder — the prompt asks about the item, not the crop', () => {
  const promptText = async () => {
    generateContent.mockResolvedValue(reply([{ image: 0, product: 'A' }]));
    await groupFolder(folder(1));
    return textPartsOf(0).join(' ');
  };

  it('says the colour is the whole colourway, sole included', async () => {
    const text = await promptText();
    expect(text).toMatch(/WHOLE ITEM'S colourway/i);
    expect(text).toMatch(/black white.*not "white"/is);
  });

  it('scopes the material to the upper', async () => {
    expect(await promptText()).toMatch(/material.*is the material of the UPPER only/is);
  });

  it('scopes the sole to the outsole, and asks for one answer per item', async () => {
    const text = await promptText();
    expect(text).toMatch(/soleType.*is the OUTSOLE/is);
    expect(text).toMatch(/do not call it "foam" from one angle and "rubber" from another/i);
  });

  it('asks for details specific enough to tell two items apart', async () => {
    const text = await promptText();
    expect(text).toMatch(/BE SPECIFIC/);
    expect(text).toMatch(/outsole tread pattern/i);
  });

  it('asks for the same feature to be worded the same way from every angle', async () => {
    expect(await promptText()).toMatch(/BE CONSISTENT/);
  });

  it('warns that a flat heel and a rubber sole separate nothing', async () => {
    const text = await promptText();
    expect(text).toMatch(/WHAT DOES NOT SEPARATE TWO ITEMS/i);
    expect(text).toMatch(/never treat them as a reason to call two photographs the same item/i);
  });
});

describe('groupFolder — stopping', () => {
  it('keeps what it has and hands back the rest', async () => {
    generateContent.mockResolvedValue(
      reply(Array.from({ length: 16 }, (_, i) => ({ image: i, product: 'A', angle: 'CLOSEUP' })))
    );

    // The first report is made before anything is sent, so stopping on the
    // second is stopping after exactly one request has landed.
    let reports = 0;
    const result = await groupFolder(
      folder(50),
      () => {
        reports += 1;
      },
      () => reports >= 2
    );

    expect(result.stopped).toBe(true);
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].images).toHaveLength(16);
    expect(result.unassigned).toHaveLength(34);
  });

  it('gives every photo back when it is stopped before it starts', async () => {
    const result = await groupFolder(folder(30), undefined, () => true);

    expect(result.stopped).toBe(true);
    expect(result.classified).toBe(true);
    expect(result.groups).toEqual([]);
    expect(result.unassigned).toHaveLength(30);
    expect(generateContent).not.toHaveBeenCalled();
  });
});
