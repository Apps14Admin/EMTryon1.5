import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  readState,
  isFinished,
  submitBatch,
  pollBatch,
  collectBatch,
  imageFrom,
  buildBatchRenderRequest,
} from './geminiBatch';

const photo = (tag: string) => `/9j/${tag.repeat(10)}`;

const stubWindow = () => {
  (globalThis as any).window = { location: { origin: 'https://studio.test' } };
};

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

afterEach(() => {
  vi.restoreAllMocks();
  delete (globalThis as any).window;
});

describe('readState', () => {
  it('reads the states the service actually sends', () => {
    expect(readState('BATCH_STATE_PENDING')).toBe('pending');
    expect(readState('BATCH_STATE_RUNNING')).toBe('running');
    expect(readState('BATCH_STATE_SUCCEEDED')).toBe('succeeded');
    expect(readState('BATCH_STATE_FAILED')).toBe('failed');
    expect(readState('BATCH_STATE_CANCELLED')).toBe('cancelled');
    expect(readState('BATCH_STATE_EXPIRED')).toBe('expired');
  });

  it('treats an unknown state as still running, never as dead', () => {
    // Calling a live job dead abandons work that is still being paid for.
    expect(readState('BATCH_STATE_SOMETHING_NEW')).toBe('pending');
    expect(readState(undefined)).toBe('pending');
    expect(isFinished(readState('BATCH_STATE_SOMETHING_NEW'))).toBe(false);
  });
});

describe('submitBatch', () => {
  it('sends one job carrying every render, each tagged with its own key', async () => {
    stubWindow();
    const fetchMock = vi.fn().mockResolvedValue(ok({ name: 'batches/abc' }));
    vi.stubGlobal('fetch', fetchMock);

    const name = await submitBatch('gemini-3-pro-image', [
      { key: 'p1::front', parts: [{ text: 'a' }], aspectRatio: '9:16' },
      { key: 'p2::side', parts: [{ text: 'b' }], aspectRatio: '4:5', imageSize: '2K' },
    ]);

    expect(name).toBe('batches/abc');

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      'https://studio.test/api/gemini/v1beta/models/gemini-3-pro-image:batchGenerateContent'
    );

    const sent = JSON.parse(init.body).batch.input_config.requests.requests;
    expect(sent).toHaveLength(2);
    expect(sent.map((r: any) => r.metadata.key)).toEqual(['p1::front', 'p2::side']);
    expect(sent[0].request.generationConfig.imageConfig).toEqual({ aspectRatio: '9:16' });
    expect(sent[1].request.generationConfig.imageConfig).toEqual({
      aspectRatio: '4:5',
      imageSize: '2K',
    });
  });

  it('refuses an empty batch rather than submitting a job with nothing in it', async () => {
    stubWindow();
    await expect(submitBatch('gemini-3-pro-image', [])).rejects.toThrow(/at least one/i);
  });

  it('fails loudly when a job is accepted but unnamed — it could never be collected', async () => {
    stubWindow();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(ok({})));

    await expect(
      submitBatch('gemini-3-pro-image', [{ key: 'k', parts: [], aspectRatio: '9:16' }])
    ).rejects.toThrow(/no job name/i);
  });

  it('surfaces the service’s own reason when a submission is refused', async () => {
    stubWindow();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        json: async () => ({ error: { message: 'model does not support batch' } }),
      })
    );

    await expect(
      submitBatch('gemini-3-pro-image', [{ key: 'k', parts: [], aspectRatio: '9:16' }])
    ).rejects.toThrow(/model does not support batch/);
  });
});

describe('pollBatch', () => {
  it('turns the pending count into renders finished', async () => {
    stubWindow();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        ok({
          metadata: {
            state: 'BATCH_STATE_RUNNING',
            batchStats: { requestCount: '10', pendingRequestCount: '4' },
          },
        })
      )
    );

    expect(await pollBatch('batches/abc', 10)).toEqual({ state: 'running', done: 6, total: 10 });
  });

  it('falls back to the caller’s total when the service reports no stats', async () => {
    stubWindow();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(ok({ metadata: { state: 'BATCH_STATE_PENDING' } })));

    expect(await pollBatch('batches/abc', 7)).toEqual({ state: 'pending', done: 0, total: 7 });
  });
});

describe('collectBatch', () => {
  it('matches every picture to the key it was sent with, not to its position', async () => {
    stubWindow();
    // Deliberately returned in the opposite order to the submission.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        ok({
          metadata: {
            output: {
              inlinedResponses: {
                inlinedResponses: [
                  {
                    metadata: { key: 'p2::side' },
                    response: {
                      candidates: [
                        { content: { parts: [{ inlineData: { mimeType: 'image/png', data: 'BBB' } }] } },
                      ],
                    },
                  },
                  {
                    metadata: { key: 'p1::front' },
                    response: {
                      candidates: [
                        { content: { parts: [{ inlineData: { mimeType: 'image/png', data: 'AAA' } }] } },
                      ],
                    },
                  },
                ],
              },
            },
          },
        })
      )
    );

    const results = await collectBatch('batches/abc');

    // Matching on position here would put product 2's picture under product 1's
    // name — the same mix-up the isolation check exists to prevent.
    expect(results).toEqual([
      { key: 'p2::side', url: 'data:image/png;base64,BBB' },
      { key: 'p1::front', url: 'data:image/png;base64,AAA' },
    ]);
  });

  it('keeps the batch when one render inside it failed', async () => {
    stubWindow();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        ok({
          metadata: {
            output: {
              inlinedResponses: {
                inlinedResponses: [
                  { metadata: { key: 'bad' }, error: { message: 'blocked' } },
                  {
                    metadata: { key: 'good' },
                    response: {
                      candidates: [
                        { content: { parts: [{ inlineData: { mimeType: 'image/png', data: 'AAA' } }] } },
                      ],
                    },
                  },
                ],
              },
            },
          },
        })
      )
    );

    const results = await collectBatch('batches/abc');

    expect(results[0]).toEqual({ key: 'bad', url: null, error: 'blocked' });
    expect(results[1].url).toBe('data:image/png;base64,AAA');
  });

  it('prints the same USAGE meter line the interactive path prints, per render', async () => {
    stubWindow();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        ok({
          metadata: {
            output: {
              inlinedResponses: {
                inlinedResponses: [
                  {
                    metadata: { key: 'p1::front' },
                    response: {
                      modelVersion: 'gemini-3.1-flash-image',
                      usageMetadata: {
                        promptTokenCount: 4473,
                        candidatesTokenCount: 1050,
                        totalTokenCount: 5523,
                      },
                      candidates: [
                        { content: { parts: [{ inlineData: { mimeType: 'image/png', data: 'AAA' } }] } },
                      ],
                    },
                  },
                ],
              },
            },
          },
        })
      )
    );

    await collectBatch('batches/abc');

    const line = log.mock.calls.map((c) => c.join(' ')).find((l) => l.includes('USAGE'));
    log.mockRestore();
    expect(line).toContain('[Studio Engine] USAGE — model: gemini-3.1-flash-image');
    expect(line).toContain('input tokens: 4473');
    expect(line).toContain('output tokens: 1050');
    expect(line).toContain('total: 5523');
    expect(line).toContain('p1::front');
  });
});

describe('imageFrom', () => {
  it('skips text parts and returns the picture', () => {
    expect(
      imageFrom({
        candidates: [
          {
            content: {
              parts: [{ text: 'here you go' }, { inlineData: { mimeType: 'image/png', data: 'ZZ' } }],
            },
          },
        ],
      })
    ).toBe('data:image/png;base64,ZZ');
  });

  it('returns null for a response carrying no picture at all', () => {
    expect(imageFrom({ candidates: [{ content: { parts: [{ text: 'refused' }] } }] })).toBeNull();
    expect(imageFrom(undefined)).toBeNull();
  });
});

describe('buildBatchRenderRequest', () => {
  it('puts the photographs first and the directive last, as the prompt numbers them', async () => {
    const request = await buildBatchRenderRequest('p1::front', 'gemini-3-pro-image', '2K', {
      footwear: photo('AA'),
      subject: photo('BB'),
      userPrompt: 'front view',
    });

    expect(request.key).toBe('p1::front');
    expect(request.parts.at(-1)).toHaveProperty('text');
    request.parts.slice(0, -1).forEach((part: any) => expect(part).toHaveProperty('inlineData'));
  });

  it('maps imageSize per model: Pro 1K/2K/4K, flash 512/1K, lite 1K only', async () => {
    const args = { footwear: photo('AA'), subject: photo('BB'), userPrompt: 'front view' };

    expect((await buildBatchRenderRequest('k', 'gemini-3-pro-image', '2K', args)).imageSize).toBe('2K');
    expect(
      (await buildBatchRenderRequest('k', 'gemini-3-pro-image', 'draft', args)).imageSize
    ).toBeUndefined();
    expect(
      (await buildBatchRenderRequest('k', 'gemini-3.1-flash-image', 'draft', args)).imageSize
    ).toBe('512');
    expect(
      (await buildBatchRenderRequest('k', 'gemini-3.1-flash-image', 'low', args)).imageSize
    ).toBe('512');
    expect(
      (await buildBatchRenderRequest('k', 'gemini-3.1-flash-image', '1K', args)).imageSize
    ).toBe('1K');
    // Flash honours 2K and 4K — verified live (1536x2752 / 3072x5504 back).
    expect(
      (await buildBatchRenderRequest('k', 'gemini-3.1-flash-image', '2K', args)).imageSize
    ).toBe('2K');
    expect(
      (await buildBatchRenderRequest('k', 'gemini-3.1-flash-image', '4K', args)).imageSize
    ).toBe('4K');
    // Lite answers 400 "Image size 512 is not supported for this model" —
    // verified live. Draft on lite must send no imageSize at all.
    expect(
      (await buildBatchRenderRequest('k', 'gemini-3.1-flash-lite-image', 'draft', args)).imageSize
    ).toBeUndefined();
    expect(
      (await buildBatchRenderRequest('k', 'gemini-3.1-flash-lite-image', 'low', args)).imageSize
    ).toBeUndefined();
    expect(
      (await buildBatchRenderRequest('k', 'gemini-3.1-flash-lite-image', '1K', args)).imageSize
    ).toBe('1K');
  });

  it('refuses a render with no usable photograph rather than batching a no-op', async () => {
    // A shelf shot, so the missing-person guard does not fire first: this
    // test is about a request with no photographs at all.
    await expect(
      buildBatchRenderRequest('k', 'gemini-3-pro-image', '1K', {
        userPrompt: 'ON THE RETAIL SHELF DISPLAY',
      })
    ).rejects.toThrow(/Nothing to render from/i);
  });

  it('refuses a person shot that carries no person, rather than batching an invented one', async () => {
    await expect(
      buildBatchRenderRequest('k', 'gemini-3-pro-image', '1K', {
        footwear: '/9j/' + 'shoe'.repeat(10),
        userPrompt: 'front view',
      })
    ).rejects.toThrow(/never invents a person/i);
  });
});
