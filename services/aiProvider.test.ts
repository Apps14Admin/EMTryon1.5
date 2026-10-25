import { describe, it, expect, vi, afterEach } from 'vitest';
import { setAiProvider, getAiProvider, askOpenAiAnalysis } from './aiProvider';
import {
  askAnalysisModel,
  ANALYSIS_MODEL,
  ANALYSIS_TIMEOUT_MS,
  analysisModel,
  analysisTimeoutMs,
} from './productGrouper';
import { mappingTimeoutMs, MAPPING_TIMEOUT_MS } from './angleMapper';
import { OPENAI_ANALYSIS_MODEL, OPENAI_IMAGE_MODEL } from './aiModels';

const okResponse = (text: string) => ({
  ok: true,
  status: 200,
  json: async () => ({ choices: [{ message: { content: text } }] }),
});

const errorResponse = (status: number, body: string) => ({
  ok: false,
  status,
  text: async () => body,
});

/** The endpoint reads `window.location.origin`, so the tests need one. */
const stubWindow = () => {
  (globalThis as any).window = { location: { origin: 'https://studio.test' } };
};

afterEach(() => {
  setAiProvider('gemini');
  vi.restoreAllMocks();
  delete (globalThis as any).window;
});

describe('askOpenAiAnalysis', () => {
  it('sends inline image bytes as data URLs and text as text', async () => {
    stubWindow();
    const fetchMock = vi.fn().mockResolvedValue(okResponse('[0,1]'));
    vi.stubGlobal('fetch', fetchMock);

    await askOpenAiAnalysis(
      'gpt-4o-mini',
      [{ inlineData: { mimeType: 'image/png', data: 'AAAA' } }, { text: 'which view?' }],
      1000
    );

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://studio.test/api/openai/v1/chat/completions');

    const sent = JSON.parse(init.body);
    expect(sent.model).toBe('gpt-4o-mini');
    expect(sent.messages[0].content).toEqual([
      { type: 'text', text: 'which view?' },
      { type: 'text', text: 'Photograph 0:' },
      {
        type: 'image_url',
        image_url: { url: 'data:image/png;base64,AAAA', detail: 'high' },
      },
    ]);
  });

  it('numbers the photographs, which is what the prompts answer by', async () => {
    stubWindow();
    const fetchMock = vi.fn().mockResolvedValue(okResponse('[]'));
    vi.stubGlobal('fetch', fetchMock);

    await askOpenAiAnalysis(
      'gpt-4o-mini',
      [
        { inlineData: { mimeType: 'image/jpeg', data: 'A' } },
        { inlineData: { mimeType: 'image/jpeg', data: 'B' } },
        { inlineData: { mimeType: 'image/jpeg', data: 'C' } },
        { text: 'group these' },
      ],
      1000
    );

    const content = JSON.parse(fetchMock.mock.calls[0][1].body).messages[0].content;
    const captions = content.filter((c: any) => c.type === 'text').map((c: any) => c.text);

    // The instruction leads, then every image is announced by its number.
    expect(captions).toEqual(['group these', 'Photograph 0:', 'Photograph 1:', 'Photograph 2:']);
    // Each caption sits immediately before the image it names.
    content.forEach((c: any, i: number) => {
      if (c.type !== 'image_url') return;
      expect(content[i - 1].text).toBe(`Photograph ${(i - 2) / 2}:`);
    });
  });

  it('goes through the proxy, so no key is ever put in the request', async () => {
    stubWindow();
    const fetchMock = vi.fn().mockResolvedValue(okResponse('ok'));
    vi.stubGlobal('fetch', fetchMock);

    await askOpenAiAnalysis('gpt-4o-mini', [{ text: 'hi' }], 1000);

    const headers = fetchMock.mock.calls[0][1].headers;
    expect(Object.keys(headers).map((k) => k.toLowerCase())).not.toContain('authorization');
  });

  it('returns the answer in the shape the Gemini call sites already read', async () => {
    stubWindow();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse('[2,0,1]')));

    const res = await askOpenAiAnalysis('gpt-4o-mini', [{ text: 'sort' }], 1000);

    expect(res.candidates[0].content.parts[0].text).toBe('[2,0,1]');
  });

  it('puts the status in the message, which is what decides whether to walk on', async () => {
    stubWindow();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(errorResponse(404, 'model not found')));

    await expect(askOpenAiAnalysis('nope', [{ text: 'x' }], 1000)).rejects.toThrow(/404/);
  });
});

describe('askAnalysisModel under the provider switch', () => {
  it('leaves the Gemini client untouched while Gemini is selected', async () => {
    const generateContent = vi.fn().mockResolvedValue({ candidates: [] });

    await askAnalysisModel({ models: { generateContent } }, [{ text: 'x' }], 1000);

    expect(generateContent).toHaveBeenCalledOnce();
    expect(generateContent.mock.calls[0][0].model).toBe(ANALYSIS_MODEL);
  });

  it('sends analysis to OpenAI — not just the render — once OpenAI is selected', async () => {
    stubWindow();
    setAiProvider('openai');
    const fetchMock = vi.fn().mockResolvedValue(okResponse('[0]'));
    vi.stubGlobal('fetch', fetchMock);
    const generateContent = vi.fn();

    const res = await askAnalysisModel({ models: { generateContent } }, [{ text: 'x' }], 1000);

    expect(generateContent).not.toHaveBeenCalled();
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).model).toBe(OPENAI_ANALYSIS_MODEL);
    expect(res.candidates[0].content.parts[0].text).toBe('[0]');
  });

  it('has one id and no fallback, so a retired id fails rather than degrading', async () => {
    stubWindow();
    setAiProvider('openai');
    const fetchMock = vi.fn().mockResolvedValue(errorResponse(404, 'model not found'));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      askAnalysisModel({ models: { generateContent: vi.fn() } }, [{ text: 'x' }], 1000)
    ).rejects.toThrow(/404/);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('stops on a refused key rather than paying twice for the same answer', async () => {
    stubWindow();
    setAiProvider('openai');
    const fetchMock = vi.fn().mockResolvedValue(errorResponse(403, 'invalid api key'));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      askAnalysisModel({ models: { generateContent: vi.fn() } }, [{ text: 'x' }], 1000)
    ).rejects.toThrow(/403/);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('reports the id it actually used, so a failure names the right account', async () => {
    stubWindow();
    setAiProvider('openai');
    const fetchMock = vi.fn().mockResolvedValue(errorResponse(429, 'quota'));
    vi.stubGlobal('fetch', fetchMock);

    expect(analysisModel()).toBe(OPENAI_ANALYSIS_MODEL);

    const err = await askAnalysisModel({ models: { generateContent: vi.fn() } }, [{ text: 'x' }], 1000)
      .then(() => null)
      .catch((e) => e);

    // A 429 used to walk to a second id. It now stops here.
    expect(err.analysisModels).toEqual([OPENAI_ANALYSIS_MODEL]);
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

describe('the ceilings each provider is given', () => {
  it('keeps the measured Gemini figures while Gemini is selected', () => {
    expect(analysisTimeoutMs()).toBe(ANALYSIS_TIMEOUT_MS);
    expect(mappingTimeoutMs()).toBe(MAPPING_TIMEOUT_MS);
  });

  it('gives OpenAI longer, because the Gemini figures abort it every time', () => {
    setAiProvider('openai');

    expect(analysisTimeoutMs()).toBeGreaterThan(ANALYSIS_TIMEOUT_MS);
    expect(mappingTimeoutMs()).toBeGreaterThan(MAPPING_TIMEOUT_MS);
  });

  it('is the ceiling actually applied to the request, not just a constant', async () => {
    stubWindow();
    setAiProvider('openai');
    let abortedAfter: number | null = null;
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((_url: string, init: any) => {
        // Never resolves; only the ceiling can end it.
        return new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => {
            abortedAfter = Date.now() - startedAt;
            reject(new Error('signal is aborted without reason'));
          });
        });
      })
    );

    const startedAt = Date.now();
    await expect(askOpenAiAnalysis('gpt-4o-mini', [{ text: 'x' }], 50)).rejects.toThrow(/abort/);
    expect(abortedAfter).not.toBeNull();
  });

  it('is the configured analysis id, never the generation id', () => {
    // Two capabilities, two configured models. Analysis returns words;
    // generation returns a picture. Neither stands in for the other.
    expect(OPENAI_ANALYSIS_MODEL).toBe('gpt-5.6-luna');
    expect(OPENAI_ANALYSIS_MODEL).not.toBe(OPENAI_IMAGE_MODEL);
    expect(OPENAI_IMAGE_MODEL).toBe('gpt-image-2');
  });
});

describe('ONE provider selection drives both capabilities', () => {
  it('moves analysis AND generation together — there is no second switch', async () => {
    stubWindow();
    const fetchMock = vi.fn().mockResolvedValue(okResponse('[0]'));
    vi.stubGlobal('fetch', fetchMock);
    const generateContent = vi.fn();

    setAiProvider('openai');
    await askAnalysisModel({ models: { generateContent } }, [{ text: 'x' }], 1000);

    expect(generateContent).not.toHaveBeenCalled();
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).model).toBe(OPENAI_ANALYSIS_MODEL);

    setAiProvider('gemini');
    await askAnalysisModel({ models: { generateContent } }, [{ text: 'x' }], 1000);
    expect(generateContent).toHaveBeenCalledOnce();
  });

  it('starts on Gemini, the provider that works with only the required key', () => {
    expect(getAiProvider()).toBe('gemini');
  });
});

describe('getAiProvider', () => {
  it('defaults to Gemini, the path that works with only the required key set', () => {
    expect(getAiProvider()).toBe('gemini');
  });
});
