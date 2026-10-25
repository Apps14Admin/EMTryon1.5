/**
 * Gemini Batch Mode: many renders submitted as one job, collected later.
 *
 * The interactive path sends one request per shot and waits for the picture.
 * That is right for a single shot and wrong for a folder: forty renders of a
 * Pro-quality product line are forty sequential waits at full price. Batch Mode
 * takes all of them in one submission, runs them on Google's own schedule, and
 * bills at half the interactive rate.
 *
 * What it costs in exchange is immediacy. A batch is asynchronous: it comes
 * back in minutes or, at the far end of the published target, in up to 24
 * hours. So this module is built around a job that OUTLIVES the page. The job
 * name is the only thing that has to survive, and it is small enough to keep in
 * local storage — reload mid-run and the poll picks the same job back up
 * instead of paying for the folder a second time.
 *
 * This is Google's OWN batch endpoint (`:batchGenerateContent`), not an
 * orchestration this app invented.
 *
 * BATCH IS A TRANSPORT, NOT A MODEL CHOICE. It submits whichever model the
 * caller selected, and never swaps in another one because the work is going
 * through a batch. `submitBatch` resolves the id against the configuration
 * before anything is sent, so a stale value fails locally rather than
 * submitting a job on a model nobody picked.
 *
 * Batch submits each render exactly ONCE. A render that fails inside the job
 * is reported as failed for that key and is never resubmitted automatically.
 *
 * The real API key is attached server-side, as everywhere else here: requests
 * go to our own `/api/gemini` proxy, which is a straight path passthrough.
 */

import {
  buildRenderRequest,
  logRenderRequest,
  type GarmentInput,
  type RenderDiagnostics,
  type RenderExtras,
} from './renderRequest';
import { geminiImageSizeFor, resolveGeminiModel } from './aiModels';

/** One render, as it goes into a batch. */
export interface BatchRenderRequest {
  /** Caller's own id for this render, returned alongside its picture. */
  key: string;
  /** The assembled prompt and photographs, in Gemini's `parts` shape. */
  parts: any[];
  /** Frame shape, e.g. '9:16'. */
  aspectRatio: string;
  /** '512' | '1K' | '2K' | '4K', when the model honours it. */
  imageSize?: string;
  /** What the render was assembled from, for the gallery badge. */
  diagnostics?: RenderDiagnostics;
}

export type BatchState =
  | 'pending'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'expired';

export interface BatchProgress {
  state: BatchState;
  /** Renders finished so far, when the service reports it. */
  done: number;
  /** Renders in the job. */
  total: number;
}

/** One finished render. `url` is null when that single render failed. */
export interface BatchResult {
  key: string;
  url: string | null;
  error?: string;
}

const base = () => `${window.location.origin}/api/gemini/v1beta`;

/**
 * The service's state strings, mapped onto ours.
 *
 * Anything unrecognised is treated as still running rather than as a failure:
 * a state this code has not been taught is not evidence the job is dead, and
 * calling it dead would abandon a job that is still being paid for.
 */
export const readState = (raw: string | undefined): BatchState => {
  const state = (raw ?? '').toUpperCase();
  if (state.includes('SUCCEEDED')) return 'succeeded';
  if (state.includes('FAILED')) return 'failed';
  if (state.includes('CANCELLED')) return 'cancelled';
  if (state.includes('EXPIRED')) return 'expired';
  if (state.includes('RUNNING')) return 'running';
  return 'pending';
};

/** True once the job will never change again, whatever the outcome. */
export const isFinished = (state: BatchState): boolean =>
  state === 'succeeded' || state === 'failed' || state === 'cancelled' || state === 'expired';

const readError = async (res: Response): Promise<string> => {
  try {
    const body = await res.json();
    return body?.error?.message || `${res.status} ${res.statusText}`;
  } catch {
    return `${res.status} ${res.statusText}`;
  }
};

/**
 * Submits every render as one job and returns its name.
 *
 * The name is the whole handle to the work. Nothing else in this module needs
 * the requests again, which is what makes the job survivable across a reload:
 * store the name, and the pictures can still be collected from a fresh page.
 */
export const submitBatch = async (
  model: string,
  requests: BatchRenderRequest[],
  displayName = `em-tryon-${Date.now()}`
): Promise<string> => {
  if (!requests.length) throw new Error('A batch needs at least one render.');

  // The selected model, resolved against the configuration at the point of
  // submission. A batch is billed on acceptance, so a model this application
  // is not configured for must not reach Google from here — and the model
  // that IS submitted is the one the caller selected, unchanged.
  resolveGeminiModel(model);

  // Two renders with the same key would be indistinguishable on collection,
  // and a duplicated request is a duplicated bill. Refused rather than
  // deduplicated, because a collision means the caller built the run wrong.
  const keys = new Set(requests.map((r) => r.key));
  if (keys.size !== requests.length) {
    throw new Error(
      `This batch contains duplicate render keys, which would submit the same work twice. Nothing was sent.`
    );
  }

  const body = {
    batch: {
      display_name: displayName,
      input_config: {
        requests: {
          requests: requests.map((r) => ({
            request: {
              contents: [{ parts: r.parts }],
              generationConfig: {
                imageConfig: {
                  aspectRatio: r.aspectRatio,
                  ...(r.imageSize ? { imageSize: r.imageSize } : {}),
                },
              },
            },
            metadata: { key: r.key },
          })),
        },
      },
    },
  };

  const res = await fetch(`${base()}/models/${model}:batchGenerateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) throw new Error(`Batch submission was refused: ${await readError(res)}`);

  const json = await res.json();
  const name = json?.name ?? json?.metadata?.name;
  if (!name) {
    throw new Error('The batch was accepted but returned no job name, so it cannot be collected.');
  }

  return name;
};

/** Where the job has got to. One cheap GET; safe to call on a timer. */
export const pollBatch = async (name: string, total: number): Promise<BatchProgress> => {
  const res = await fetch(`${base()}/${name}`);
  if (!res.ok) throw new Error(`Could not read the batch job: ${await readError(res)}`);

  const json = await res.json();
  const meta = json?.metadata ?? json;
  const stats = meta?.batchStats ?? {};

  const counted = Number(stats.requestCount ?? total);
  const resolvedTotal = Number.isFinite(counted) && counted > 0 ? counted : total;

  // Progress is only reported when the pending count is. Defaulting a missing
  // count to zero made "none pending" mean "all finished", so a job that had
  // not started yet showed as complete.
  const reported = stats.pendingRequestCount;
  const pending = reported === undefined || reported === null ? null : Number(reported);
  const finished = pending === null || !Number.isFinite(pending) ? 0 : resolvedTotal - pending;

  return {
    state: readState(meta?.state),
    done: Math.max(0, Math.min(resolvedTotal, finished)),
    total: resolvedTotal,
  };
};

/**
 * Pulls the first image out of one response, as a data URL.
 *
 * A response with no picture in it is a failure for that render alone. The
 * batch as a whole can still have succeeded, which is why this returns null
 * rather than throwing — one bad shot must not discard the other thirty-nine.
 */
export const imageFrom = (response: any): string | null => {
  const parts = response?.candidates?.[0]?.content?.parts ?? [];
  for (const part of parts) {
    if (part?.inlineData?.data) {
      return `data:${part.inlineData.mimeType || 'image/png'};base64,${part.inlineData.data}`;
    }
  }
  return null;
};

/**
 * The finished pictures, keyed by the caller's own ids.
 *
 * Responses are matched by the `key` that went out with each request, never by
 * position: a batch is not promised back in the order it was sent, and matching
 * on position would attach one product's picture to another product's name —
 * the same class of mix-up `batchRunner`'s isolation check exists to prevent.
 */
export const collectBatch = async (name: string): Promise<BatchResult[]> => {
  const res = await fetch(`${base()}/${name}`);
  if (!res.ok) throw new Error(`Could not read the batch results: ${await readError(res)}`);

  const json = await res.json();
  const meta = json?.metadata ?? json;
  const inlined =
    meta?.output?.inlinedResponses?.inlinedResponses ??
    meta?.output?.inlinedResponses ??
    meta?.response?.inlinedResponses?.inlinedResponses ??
    [];

  return (Array.isArray(inlined) ? inlined : []).map((entry: any) => {
    const key = entry?.metadata?.key ?? '';
    // The same meter line the interactive path prints (geminiService), one
    // per render, so a batched render's cost is exactly as visible as an
    // interactive one's — straight from the API's own meter, never guessed.
    const usage = entry?.response?.usageMetadata;
    if (usage) {
      console.log(
        `[Studio Engine] USAGE — model: ${entry?.response?.modelVersion ?? 'batch'} · ` +
          `input tokens: ${usage.promptTokenCount ?? '?'} · ` +
          `output tokens: ${usage.candidatesTokenCount ?? '?'} · ` +
          `total: ${usage.totalTokenCount ?? '?'} · render: ${key}`
      );
    }
    if (entry?.error) {
      return { key, url: null, error: entry.error.message || 'This render failed.' };
    }
    const url = imageFrom(entry?.response);
    return url
      ? { key, url }
      : { key, url: null, error: 'The model returned no picture for this render.' };
  });
};

/**
 * How many attached photographs one batched render may carry.
 *
 * The interactive Gemini path has no explicit ceiling. A batch does have a
 * practical one: every photograph is base64 in the submission body, and the
 * whole folder's renders go up in a single request.
 */
export const BATCH_MAX_IMAGES = 14;

/**
 * One shot, assembled and ready to batch.
 *
 * The assembly is `renderRequest`'s — the same one the OpenAI path renders
 * from, so a shot batched here and a shot rendered interactively are built from
 * one description of the work rather than two that can drift apart.
 */
export const buildBatchRenderRequest = async (
  key: string,
  model: string,
  quality: string,
  args: RenderExtras & {
    footwear?: GarmentInput;
    bottoms?: GarmentInput;
    top?: GarmentInput;
    subject?: GarmentInput;
    userPrompt?: string;
    modelDescription?: string;
    room?: string | null;
    lighting?: string | null;
  }
): Promise<BatchRenderRequest> => {
  const request = await buildRenderRequest({
    ...args,
    userPrompt: args.userPrompt ?? '',
    modelDescription: args.modelDescription ?? '',
    maxImages: BATCH_MAX_IMAGES,
    // the prompt is written so the matching product view leads its item.
  });

  if (!request.images.length) {
    throw new Error(
      'Nothing to render from: no product, person or scene photograph survived preparation.'
    );
  }

  logRenderRequest(`Gemini batch · ${key}`, request, model, quality);

  // Photographs first, directive last — the order the interactive Gemini path
  // sends, and the order every `Input Image N` in the prompt is numbered by.
  const parts: any[] = request.images.map((img) => ({
    inlineData: { mimeType: img.mimeType, data: img.data },
  }));
  parts.push({ text: request.prompt });

  return {
    key,
    parts,
    aspectRatio: request.aspectRatio,
    imageSize: geminiImageSizeFor(model, quality),
    diagnostics: request.diagnostics,
  };
};

/** Stops a job that is still queued or running. Best effort. */
export const cancelBatch = async (name: string): Promise<void> => {
  await fetch(`${base()}/${name}:cancel`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  }).catch(() => undefined);
};
