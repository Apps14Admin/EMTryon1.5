/**
 * The architecture guarantees, as executable checks.
 *
 * Every test here exists to make one costly behaviour impossible to
 * reintroduce without a red build. They are deliberately about REQUEST COUNTS
 * and MODEL IDS rather than about output, because those two things are what
 * the bill is made of.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { generateContent } = vi.hoisted(() => ({ generateContent: vi.fn() }));

vi.mock('@google/genai', () => ({
  GoogleGenAI: vi.fn().mockImplementation(() => ({ models: { generateContent } })),
}));

import {
  GEMINI_MODELS,
  GEMINI_MODEL_IDS,
  GEMINI_ANALYSIS_MODEL,
  OPENAI_ANALYSIS_MODEL,
  OPENAI_IMAGE_MODEL,
  DEFAULT_GEMINI_MODEL,
  resolveGeminiModel,
  isConfiguredGeminiModel,
  modelsFor,
} from './aiModels';
import { setAiProvider, setGeminiModel, getGeminiModel, activeModels } from './aiProvider';
import { generateTryOnImage } from './geminiService';
import { generateTryOnImageOpenAI } from './openaiService';
import { askAnalysisModel, analysisModel } from './productGrouper';
import { mapAnglesToSlots } from './angleMapper';
import { submitBatch } from './geminiBatch';
import {
  buildBatchItems,
  runBatchItems,
  retryBatchItem,
  type BatchItem,
} from './batchRunner';
import type { ProductGroup } from './productGrouper';

/** A garment photo the preparer will accept as raw base64. */
const PHOTO = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/** A Gemini response carrying one picture. */
const imageReply = () => ({
  candidates: [{ content: { parts: [{ inlineData: { data: 'AAAA', mimeType: 'image/png' } }] } }],
});

const okOpenAiImage = () => ({
  ok: true,
  status: 200,
  json: async () => ({ data: [{ b64_json: 'AAAA' }] }),
});

const failedOpenAi = (status: number, message: string) => ({
  ok: false,
  status,
  statusText: 'error',
  json: async () => ({ error: { message } }),
});

beforeEach(() => {
  vi.clearAllMocks();
  setAiProvider('gemini');
  setGeminiModel(DEFAULT_GEMINI_MODEL);
  (globalThis as any).window = { location: { origin: 'https://studio.test' } };
});

afterEach(() => {
  setAiProvider('gemini');
  // `restoreAllMocks` would strip the mockImplementation off the hoisted
  // `@google/genai` module mock, leaving `new GoogleGenAI()` undefined and
  // every later test failing on a TypeError instead of on what it asserts.
  vi.unstubAllGlobals();
  delete (globalThis as any).window;
});

// ---------------------------------------------------------------------------
// TEST 1 — a failed request does NOT trigger a retry
// ---------------------------------------------------------------------------

describe('Test 1 — a failed request is not retried', () => {
  it('sends the Gemini render exactly once when the model fails', async () => {
    generateContent.mockRejectedValue(new Error('503 UNAVAILABLE: the model is overloaded'));

    await expect(
      generateTryOnImage(PHOTO, null, null, PHOTO, 'front view')
    ).rejects.toThrow();

    // The removed ladder made three of these, with 5s and 10s backoff.
    expect(generateContent).toHaveBeenCalledTimes(1);
  });

  it('sends the Gemini render exactly once on a rate limit too', async () => {
    generateContent.mockRejectedValue(new Error('429 RESOURCE_EXHAUSTED'));

    await expect(generateTryOnImage(PHOTO, null, null, PHOTO, 'front view')).rejects.toThrow();
    expect(generateContent).toHaveBeenCalledTimes(1);
  });

  it('does not resend when the model answers 200 with no picture', async () => {
    generateContent.mockResolvedValue({ candidates: [{ content: { parts: [{ text: 'no' }] } }] });

    await expect(generateTryOnImage(PHOTO, null, null, PHOTO, 'front view')).rejects.toThrow(
      /no image/i
    );
    expect(generateContent).toHaveBeenCalledTimes(1);
  });

  it('sends the OpenAI render exactly once when it fails', async () => {
    setAiProvider('openai');
    const fetchMock = vi.fn().mockResolvedValue(failedOpenAi(500, 'server error'));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      generateTryOnImageOpenAI(PHOTO, null, null, PHOTO, 'front view')
    ).rejects.toThrow();

    // Two attempts plus a parameter replay used to be possible here.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not replay the OpenAI request when a parameter is rejected', async () => {
    setAiProvider('openai');
    const fetchMock = vi
      .fn()
      .mockResolvedValue(failedOpenAi(400, 'Unknown parameter: input_fidelity'));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      generateTryOnImageOpenAI(PHOTO, null, null, PHOTO, 'front view')
    ).rejects.toThrow(/input_fidelity/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('sends one analysis request per failure, never a ladder', async () => {
    generateContent.mockRejectedValue(new Error('503 UNAVAILABLE'));

    await expect(
      askAnalysisModel({ models: { generateContent } }, [{ text: 'x' }], 1000)
    ).rejects.toThrow();
    expect(generateContent).toHaveBeenCalledTimes(1);
  });

  it('sends one angle-classification request, whatever goes wrong', async () => {
    generateContent.mockRejectedValue(new Error('503 UNAVAILABLE'));

    const result = await mapAnglesToSlots(['AAAA', 'BBBB'], ['FRONT', 'SIDE']);

    expect(generateContent).toHaveBeenCalledTimes(1);
    expect(result.classified).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// TEST 2 — a failed request does NOT trigger a fallback
// ---------------------------------------------------------------------------

describe('Test 2 — a failed request does not fall back', () => {
  it('never calls a second Gemini model id after the first fails', async () => {
    setGeminiModel(GEMINI_MODELS.FLASH);
    generateContent.mockRejectedValue(new Error('503 UNAVAILABLE'));

    await expect(generateTryOnImage(PHOTO, null, null, PHOTO, 'front view')).rejects.toThrow();

    const idsUsed = generateContent.mock.calls.map((call) => call[0].model);
    expect(idsUsed).toEqual([GEMINI_MODELS.FLASH]);
    expect(idsUsed).not.toContain(GEMINI_MODELS.PRO);
    expect(idsUsed).not.toContain(GEMINI_MODELS.LITE);
  });

  it('does not escalate a failed Flash render to Pro', async () => {
    setGeminiModel(GEMINI_MODELS.FLASH);
    generateContent.mockRejectedValue(new Error('429 RESOURCE_EXHAUSTED'));

    await expect(generateTryOnImage(PHOTO, null, null, PHOTO, 'front view')).rejects.toThrow();
    expect(generateContent.mock.calls.every((c) => c[0].model === GEMINI_MODELS.FLASH)).toBe(
      true
    );
  });

  it('does not cross to the other provider when Gemini fails', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    generateContent.mockRejectedValue(new Error('503 UNAVAILABLE'));

    await expect(generateTryOnImage(PHOTO, null, null, PHOTO, 'front view')).rejects.toThrow();

    // Nothing reached the OpenAI proxy.
    const openAiCalls = fetchMock.mock.calls.filter((c) => String(c[0]).includes('/api/openai'));
    expect(openAiCalls).toHaveLength(0);
  });

  it('does not cross to Gemini when OpenAI fails', async () => {
    setAiProvider('openai');
    const fetchMock = vi.fn().mockResolvedValue(failedOpenAi(429, 'rate limited'));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      generateTryOnImageOpenAI(PHOTO, null, null, PHOTO, 'front view')
    ).rejects.toThrow();
    expect(generateContent).not.toHaveBeenCalled();
  });

  it('names the provider, the model and the reason, and nothing about falling back', async () => {
    setGeminiModel(GEMINI_MODELS.FLASH);
    generateContent.mockRejectedValue(new Error('429 RESOURCE_EXHAUSTED'));

    const err = await generateTryOnImage(PHOTO, null, null, PHOTO, 'front view').catch((e) => e);

    expect(err.provider).toBe('gemini');
    expect(err.model).toBe(GEMINI_MODELS.FLASH);
    expect(err.reason).toMatch(/RESOURCE_EXHAUSTED/);
    expect(err.message).toContain('Provider: gemini');
    expect(err.message).toContain(`Model: ${GEMINI_MODELS.FLASH}`);
    expect(err.message).not.toMatch(/falling back|trying another|retrying/i);
  });
});

// ---------------------------------------------------------------------------
// TEST 3 — a Gemini request uses one of the three configured models
// ---------------------------------------------------------------------------

describe('Test 3 — the three configured Gemini models, used as selected', () => {
  it('holds exactly three ids, and they are the configured ones', () => {
    expect(GEMINI_MODEL_IDS).toHaveLength(3);
    expect([...GEMINI_MODEL_IDS]).toEqual([
      'gemini-3.1-flash-lite-image',
      'gemini-3.1-flash-image',
      'gemini-3-pro-image',
    ]);
  });

  it('cannot be extended at runtime', () => {
    expect(Object.isFrozen(GEMINI_MODEL_IDS)).toBe(true);
    expect(() => {
      (GEMINI_MODEL_IDS as any).push('gemini-3.6-flash');
    }).toThrow();
    expect(GEMINI_MODEL_IDS).toHaveLength(3);
  });

  it('renders through whichever of the three was selected, exactly', async () => {
    for (const id of GEMINI_MODEL_IDS) {
      generateContent.mockClear();
      generateContent.mockResolvedValue(imageReply());
      setGeminiModel(id);

      await generateTryOnImage(PHOTO, null, null, PHOTO, 'front view');

      expect(generateContent.mock.calls[0][0].model).toBe(id);
    }
  });

  it('analyses on a configured id too, so nothing outside the three is ever called', async () => {
    generateContent.mockResolvedValue({ candidates: [{ content: { parts: [{ text: '[]' }] } }] });

    await askAnalysisModel({ models: { generateContent } }, [{ text: 'x' }], 1000);

    expect(GEMINI_MODEL_IDS).toContain(generateContent.mock.calls[0][0].model);
    expect(GEMINI_ANALYSIS_MODEL).toBe(GEMINI_MODELS.LITE);
  });
});

// ---------------------------------------------------------------------------
// TEST 4 — a model id outside the configuration is never used
// ---------------------------------------------------------------------------

describe('Test 4 — a model outside the configuration is never used', () => {
  it('throws rather than substituting a default', () => {
    expect(() => resolveGeminiModel('gemini-2.5-flash-image')).toThrow(/not part of/i);
    expect(() => resolveGeminiModel('gemini-3-pro-image-preview')).toThrow();
    expect(() => resolveGeminiModel('')).toThrow();
    expect(() => resolveGeminiModel(null)).toThrow();
    expect(() => resolveGeminiModel(undefined)).toThrow();
  });

  it('refuses to arm the renderer with an id the configuration does not contain', () => {
    expect(() => setGeminiModel('gemini-2.0-flash-exp' as any)).toThrow();
    // The previously armed id is untouched: a rejected choice changes nothing.
    expect(getGeminiModel()).toBe(DEFAULT_GEMINI_MODEL);
  });

  it('refuses to submit such a batch before anything is sent', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      submitBatch('gemini-2.5-flash-image', [{ key: 'k', parts: [], aspectRatio: '9:16' }])
    ).rejects.toThrow(/not part of/i);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('accepts each configured id', () => {
    GEMINI_MODEL_IDS.forEach((id) => expect(resolveGeminiModel(id)).toBe(id));
  });
});

// ---------------------------------------------------------------------------
// TEST 5 — gemini-3.6-* is not part of the configuration
// ---------------------------------------------------------------------------

describe('Test 5 — the 3.6 family is not configured and cannot be used', () => {
  const notConfigured = [
    'gemini-3.6-flash',
    'gemini-3.6-flash-image',
    'gemini-3.6-pro',
    'gemini-6-flash',
  ];

  it('is not part of the Gemini configuration', () => {
    notConfigured.forEach((id) => {
      expect(isConfiguredGeminiModel(id)).toBe(false);
      expect(GEMINI_MODEL_IDS).not.toContain(id as any);
    });
  });

  it('does not resolve to a model', () => {
    notConfigured.forEach((id) => expect(() => resolveGeminiModel(id)).toThrow());
  });

  it('cannot reach the renderer, the analyser, or a batch', async () => {
    notConfigured.forEach((id) => expect(() => setGeminiModel(id as any)).toThrow());
    await expect(
      submitBatch('gemini-3.6-flash-image', [{ key: 'k', parts: [], aspectRatio: '9:16' }])
    ).rejects.toThrow();
  });

  it('no configured or routed model id anywhere contains 3.6', () => {
    [
      ...GEMINI_MODEL_IDS,
      GEMINI_ANALYSIS_MODEL,
      OPENAI_ANALYSIS_MODEL,
      OPENAI_IMAGE_MODEL,
      modelsFor('gemini').analysis,
      modelsFor('gemini').generation,
      modelsFor('openai').analysis,
      modelsFor('openai').generation,
    ].forEach((id) => expect(id).not.toMatch(/3\.6|gemini-6/));
  });
});

// ---------------------------------------------------------------------------
// TEST 6 — `latest` is not part of the configuration
// ---------------------------------------------------------------------------

describe('Test 6 — no moving alias is configured, so none can be used', () => {
  const notConfigured = [
    'gemini-flash-latest',
    'gemini-flash-lite-latest',
    'gemini-3.1-flash-image-latest',
    'latest',
    'gemini-3-pro-image-preview',
    'gemini-2.0-flash-exp',
    'gemini-experimental',
  ];

  it('is not part of the Gemini configuration', () => {
    notConfigured.forEach((id) => expect(isConfiguredGeminiModel(id)).toBe(false));
  });

  it('does not resolve, and cannot be submitted as a batch', async () => {
    notConfigured.forEach((id) => expect(() => resolveGeminiModel(id)).toThrow());
    await expect(
      submitBatch('gemini-flash-latest', [{ key: 'k', parts: [], aspectRatio: '9:16' }])
    ).rejects.toThrow();
  });

  it('no configured model id is a moving alias', () => {
    [
      ...GEMINI_MODEL_IDS,
      GEMINI_ANALYSIS_MODEL,
      modelsFor('gemini').analysis,
      modelsFor('gemini').generation,
    ].forEach((id) => expect(id).not.toMatch(/latest|preview|experimental|exp$/i));
  });
});

// ---------------------------------------------------------------------------
// TEST 7 — a batch does not duplicate requests
// ---------------------------------------------------------------------------

describe('Test 7 — a batch does not duplicate requests', () => {
  const group = (id: string, name: string): ProductGroup => ({
    id,
    name,
    category: 'FOOTWEAR',
    images: [],
    confidence: 1,
    needsReview: false,
  });

  const jobs = [
    { group: group('p1', 'Product A'), slot: 'footwear' as const, payload: [], shots: ['front', 'side'] },
    { group: group('p2', 'Product B'), slot: 'footwear' as const, payload: [], shots: ['front'] },
  ];

  it('makes exactly one item per product-and-shot, all pending', () => {
    const items = buildBatchItems(jobs, (id) => id);

    expect(items).toHaveLength(3);
    expect(new Set(items.map((i) => i.key)).size).toBe(3);
    expect(items.every((i) => i.state === 'pending' && i.attempts === 0)).toBe(true);
  });

  it('sends exactly one request per item across the whole run', async () => {
    const items = buildBatchItems(jobs, (id) => id);
    const render = vi.fn().mockResolvedValue('data:image/png;base64,AAAA');

    const summary = await runBatchItems(items, render);

    expect(render).toHaveBeenCalledTimes(3);
    expect(summary.attempts).toBe(3);
    expect(summary.completed).toHaveLength(3);
    expect(items.every((i) => i.attempts === 1)).toBe(true);
  });

  it('re-running a finished batch sends nothing at all', async () => {
    const items = buildBatchItems(jobs, (id) => id);
    const render = vi.fn().mockResolvedValue('data:image/png;base64,AAAA');

    await runBatchItems(items, render);
    render.mockClear();

    // A second call — a stray re-render, a double-click — must not re-bill.
    await runBatchItems(items, render);
    expect(render).not.toHaveBeenCalled();
  });

  it('refuses a Gemini batch submission containing a duplicated key', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      submitBatch(GEMINI_MODELS.PRO, [
        { key: 'p1::front', parts: [], aspectRatio: '9:16' },
        { key: 'p1::front', parts: [], aspectRatio: '9:16' },
      ])
    ).rejects.toThrow(/duplicate/i);

    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// TEST 8 — a failed batch item is NOT automatically retried
// ---------------------------------------------------------------------------

describe('Test 8 — a failed batch item is not retried automatically', () => {
  const group = (id: string, name: string): ProductGroup => ({
    id,
    name,
    category: 'FOOTWEAR',
    images: [],
    confidence: 1,
    needsReview: false,
  });

  const jobs = [
    { group: group('a', 'Product A'), slot: 'footwear' as const, payload: [], shots: ['front'] },
    { group: group('b', 'Product B'), slot: 'footwear' as const, payload: [], shots: ['front'] },
    { group: group('c', 'Product C'), slot: 'footwear' as const, payload: [], shots: ['front'] },
    { group: group('d', 'Product D'), slot: 'footwear' as const, payload: [], shots: ['front'] },
  ];

  const failingOnC = () => {
    const render = vi.fn(async (item: BatchItem) => {
      if (item.productId === 'c') throw new Error('RESOURCE_EXHAUSTED');
      return 'data:image/png;base64,AAAA';
    });
    return render;
  };

  it('marks C failed after exactly one attempt', async () => {
    const items = buildBatchItems(jobs, (id) => id);
    const render = failingOnC();

    const summary = await runBatchItems(items, render);

    const c = items.find((i) => i.productId === 'c')!;
    expect(c.state).toBe('failed');
    expect(c.attempts).toBe(1);
    expect(c.error).toMatch(/RESOURCE_EXHAUSTED/);
    // Four items, four requests. Not five.
    expect(summary.attempts).toBe(4);
  });

  it('lets the other products finish independently', async () => {
    const items = buildBatchItems(jobs, (id) => id);

    await runBatchItems(items, failingOnC());

    expect(items.filter((i) => i.state === 'completed').map((i) => i.productId)).toEqual([
      'a',
      'b',
      'd',
    ]);
  });

  it('does not switch model or provider for the failed item', async () => {
    const items = buildBatchItems(jobs, (id) => id);
    const seen: string[] = [];
    const render = vi.fn(async (item: BatchItem) => {
      seen.push(activeModels().generation);
      if (item.productId === 'c') throw new Error('RESOURCE_EXHAUSTED');
      return 'data:image/png;base64,AAAA';
    });

    await runBatchItems(items, render);

    expect(new Set(seen).size).toBe(1);
    expect(seen[0]).toBe(DEFAULT_GEMINI_MODEL);
  });

  it('only sends C again when a user reopens it, and sends nothing else', async () => {
    const items = buildBatchItems(jobs, (id) => id);
    const render = failingOnC();
    await runBatchItems(items, render);
    render.mockClear();

    // The user pressed Retry on C. This is the ONLY route back to pending.
    const reopened = retryBatchItem(items, items.find((i) => i.productId === 'c')!.key);
    await runBatchItems(reopened, render);

    expect(render).toHaveBeenCalledTimes(1);
    expect(render.mock.calls[0][0].productId).toBe('c');
    expect(reopened.find((i) => i.productId === 'c')!.attempts).toBe(2);
    expect(reopened.filter((i) => i.productId !== 'c').every((i) => i.attempts === 1)).toBe(true);
  });

  it('reopens nothing when Retry names an item that did not fail', async () => {
    const items = buildBatchItems(jobs, (id) => id);
    await runBatchItems(items, failingOnC());

    const reopened = retryBatchItem(items, items.find((i) => i.productId === 'a')!.key);
    expect(reopened.every((i) => i.state !== 'pending')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// TEST 9 — OpenAI image analysis uses an image-capable model
// ---------------------------------------------------------------------------

describe('Test 9 — OpenAI analysis uses the configured image-capable model', () => {
  it('routes analysis to the configured image-understanding model', () => {
    // The API id, not the product name. Configuring the product name verbatim
    // is what produced `model_not_found` on every analysis request.
    expect(OPENAI_ANALYSIS_MODEL).toBe('gpt-5.6-luna');
    expect(modelsFor('openai').analysis).toBe('gpt-5.6-luna');
  });

  it('is not the generation model — that one takes no messages and returns pictures', () => {
    expect(OPENAI_ANALYSIS_MODEL).not.toBe(OPENAI_IMAGE_MODEL);
  });

  it('actually sends the photographs as image content to the chat endpoint', async () => {
    setAiProvider('openai');
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: '[0]' } }] }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await askAnalysisModel(
      { models: { generateContent } },
      [{ inlineData: { mimeType: 'image/jpeg', data: 'AAAA' } }, { text: 'which view?' }],
      1000
    );

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/v1/chat/completions');
    const body = JSON.parse(init.body);
    expect(body.model).toBe(OPENAI_ANALYSIS_MODEL);
    expect(body.messages[0].content.some((c: any) => c.type === 'image_url')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// TEST 10 — OpenAI image generation uses an image-generation model
// ---------------------------------------------------------------------------

describe('Test 10 — OpenAI generation uses the configured image model', () => {
  it('routes generation to the configured image-generation model', () => {
    expect(OPENAI_IMAGE_MODEL).toBe('gpt-image-2');
    expect(modelsFor('openai').generation).toBe('gpt-image-2');
  });

  it('posts it to the images endpoint, not the chat endpoint', async () => {
    setAiProvider('openai');
    const fetchMock = vi.fn().mockResolvedValue(okOpenAiImage());
    vi.stubGlobal('fetch', fetchMock);

    await generateTryOnImageOpenAI(PHOTO, null, null, PHOTO, 'front view');

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/v1/images/edits');
    expect(init.body.get('model')).toBe(OPENAI_IMAGE_MODEL);
  });

  it('never asks the analysis model to draw, or the drawing model to answer', () => {
    const { analysis, generation } = modelsFor('openai');
    expect(analysis).not.toBe(generation);
    expect(generation).toMatch(/image/);
  });

  it('is fixed configuration — the user selects OpenAI, not these two ids', () => {
    // Selecting the provider is the whole choice. Both capabilities
    // resolve from it, identically, every time.
    setAiProvider('openai');
    expect(activeModels()).toEqual({
      provider: 'openai',
      analysis: 'gpt-5.6-luna',
      generation: 'gpt-image-2',
    });
  });
});

// ---------------------------------------------------------------------------
// TEST 11 — provider selection deterministically selects the implementation
// ---------------------------------------------------------------------------

describe('Test 11 — provider selection is deterministic', () => {
  it('maps each provider to a fixed pair of ids, every time', () => {
    for (let i = 0; i < 5; i++) {
      expect(modelsFor('gemini')).toEqual({
        provider: 'gemini',
        analysis: GEMINI_ANALYSIS_MODEL,
        generation: DEFAULT_GEMINI_MODEL,
      });
      expect(modelsFor('openai')).toEqual({
        provider: 'openai',
        analysis: OPENAI_ANALYSIS_MODEL,
        generation: OPENAI_IMAGE_MODEL,
      });
    }
  });

  it('honours the Gemini quality choice for generation and pins analysis to Lite', () => {
    GEMINI_MODEL_IDS.forEach((id) => {
      const routed = modelsFor('gemini', id);
      expect(routed.generation).toBe(id);
      expect(routed.analysis).toBe(GEMINI_ANALYSIS_MODEL);
    });
  });

  it('sends the Gemini render through the Gemini client and nothing else', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    generateContent.mockResolvedValue(imageReply());

    setAiProvider('gemini');
    await generateTryOnImage(PHOTO, null, null, PHOTO, 'front view');

    expect(generateContent).toHaveBeenCalledTimes(1);
    expect(
      fetchMock.mock.calls.filter((c) => String(c[0]).includes('/api/openai'))
    ).toHaveLength(0);
  });

  it('sends the OpenAI render through the OpenAI proxy and nothing else', async () => {
    setAiProvider('openai');
    const fetchMock = vi.fn().mockResolvedValue(okOpenAiImage());
    vi.stubGlobal('fetch', fetchMock);

    await generateTryOnImageOpenAI(PHOTO, null, null, PHOTO, 'front view');

    expect(generateContent).not.toHaveBeenCalled();
    expect(String(fetchMock.mock.calls[0][0])).toContain('/api/openai');
  });

  it('moves analysis with the same single switch', async () => {
    setAiProvider('gemini');
    expect(analysisModel()).toBe(GEMINI_ANALYSIS_MODEL);
    setAiProvider('openai');
    expect(analysisModel()).toBe(OPENAI_ANALYSIS_MODEL);
  });
});

// ---------------------------------------------------------------------------
// TEST 12 — one user action = one generation attempt
// ---------------------------------------------------------------------------

describe('Test 12 — one user action produces one generation attempt', () => {
  it('makes exactly one API call for one successful Gemini render', async () => {
    generateContent.mockResolvedValue(imageReply());

    await generateTryOnImage(PHOTO, null, null, PHOTO, 'front view');

    expect(generateContent).toHaveBeenCalledTimes(1);
  });

  it('makes exactly one API call for one failed Gemini render', async () => {
    generateContent.mockRejectedValue(new Error('503 UNAVAILABLE'));

    await expect(generateTryOnImage(PHOTO, null, null, PHOTO, 'front view')).rejects.toThrow();

    expect(generateContent).toHaveBeenCalledTimes(1);
  });

  it('makes exactly one API call for one OpenAI render', async () => {
    setAiProvider('openai');
    const fetchMock = vi.fn().mockResolvedValue(okOpenAiImage());
    vi.stubGlobal('fetch', fetchMock);

    await generateTryOnImageOpenAI(PHOTO, null, null, PHOTO, 'front view');

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('makes N calls for N shots and not one more', async () => {
    generateContent.mockResolvedValue(imageReply());

    // What one click on "Render 3 shot angles" does: three shots, three calls.
    for (const shot of ['front view', 'side profile', '180-degree rear']) {
      await generateTryOnImage(PHOTO, null, null, PHOTO, shot);
    }

    expect(generateContent).toHaveBeenCalledTimes(3);
  });

  it('only produces a second attempt when a user explicitly retries', async () => {
    const items = buildBatchItems(
      [
        {
          group: {
            id: 'p1',
            name: 'Product A',
            category: 'FOOTWEAR',
            images: [],
            confidence: 1,
            needsReview: false,
          } as ProductGroup,
          slot: 'footwear' as const,
          payload: [],
          shots: ['front'],
        },
      ],
      (id) => id
    );

    const render = vi.fn().mockRejectedValue(new Error('503'));

    await runBatchItems(items, render);
    expect(render).toHaveBeenCalledTimes(1);

    // No user action: running again changes nothing, because the item is
    // failed rather than pending.
    await runBatchItems(items, render);
    expect(render).toHaveBeenCalledTimes(1);

    // The user presses Retry. Now, and only now, a second request goes out.
    const reopened = retryBatchItem(items, items[0].key);
    await runBatchItems(reopened, render);
    expect(render).toHaveBeenCalledTimes(2);
    expect(reopened[0].attempts).toBe(2);
  });
});
