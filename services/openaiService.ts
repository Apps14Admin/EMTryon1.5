/**
 * OpenAI rendering path, on the configured generation model (`image-2`).
 *
 * The request — which photographs, in what order, and the prompt text — is
 * built by `renderRequest.ts`, the provider-neutral port of the Gemini
 * engine's assembly. Only the transport and the model parameters differ here,
 * which is what makes "Gemini vs OpenAI" a comparison of the models rather than
 * of two different prompts.
 *
 * The real key lives server-side. Requests go to our own `/api/openai` proxy,
 * which attaches it before forwarding to api.openai.com — the browser bundle
 * never sees it, exactly as with the Gemini proxy.
 *
 * ONE REQUEST PER RENDER. No retry, no parameter retry, no second model.
 */

import {
  buildRenderRequest,
  logRenderRequest,
  type GarmentInput,
  type RenderDiagnostics,
  type RenderExtras,
} from './renderRequest';
import { AiRequestError, OPENAI_IMAGE_MODEL } from './aiModels';

export { OPENAI_IMAGE_MODEL };
export type OpenAiImageModel = typeof OPENAI_IMAGE_MODEL;

/** The edits endpoint accepts at most 16 reference images. */
export const OPENAI_MAX_IMAGES = 16;

/** Hard prompt ceiling for the images endpoint. */
export const OPENAI_MAX_PROMPT_CHARS = 32000;

/** How long one render may take before it is abandoned. High quality is slow. */
const REQUEST_TIMEOUT_MS = 300_000;

/**
 * The only three frame shapes the endpoint offers. Every ratio the studio asks
 * for is snapped to the nearest of them, so a 9:16 shot comes back portrait
 * rather than square.
 */
export type OpenAiSize = '1024x1024' | '1024x1536' | '1536x1024';

/** Nearest supported frame for a studio aspect ratio such as '9:16' or '4:5'. */
export const openAiSizeFor = (aspectRatio: string): OpenAiSize => {
  const [w, h] = aspectRatio.split(':').map(Number);
  if (!w || !h) return '1024x1536';
  const ratio = w / h;
  if (ratio < 0.9) return '1024x1536';
  if (ratio > 1.1) return '1536x1024';
  return '1024x1024';
};

export interface OpenAiRenderTier {
  quality: 'low' | 'medium' | 'high';
  /**
   * How faithfully the reference photographs are preserved. `high` is what
   * keeps a logo where the photo puts it, and it is what a try-on render is
   * for — but it bills the input images at a higher rate, so the draft tier
   * deliberately does without it.
   */
  input_fidelity: 'low' | 'high';
  /** Rough per-image cost in USD at a portrait size, for the UI hint only. */
  approxUsd: number;
}

/**
 * The studio's quality dropdown mapped onto OpenAI's two dials.
 *
 * The Gemini flash path maps 'draft' and 'low' to its 512 tier and '1K' to 1K;
 * here the same split holds through OpenAI's two dials, because on both
 * providers a draft should cost draft money.
 */
export const OPENAI_TIERS: Record<string, OpenAiRenderTier> = {
  draft: { quality: 'low', input_fidelity: 'low', approxUsd: 0.02 },
  low: { quality: 'low', input_fidelity: 'high', approxUsd: 0.03 },
  '1K': { quality: 'medium', input_fidelity: 'high', approxUsd: 0.07 },
  '2K': { quality: 'high', input_fidelity: 'high', approxUsd: 0.25 },
  '4K': { quality: 'high', input_fidelity: 'high', approxUsd: 0.25 },
};

export const openAiTierFor = (quality: string): OpenAiRenderTier =>
  OPENAI_TIERS[quality] ?? OPENAI_TIERS['1K'];

/**
 * Models that accept `input_fidelity` on /images/edits. `gpt-image-2` refuses
 * the parameter outright — "The model 'gpt-image-2' does not support the
 * 'input_fidelity' parameter" — which failed every render in a batch before a
 * pixel was made. The tier still records the fidelity it WOULD ask for; this
 * decides whether the request may carry it.
 */
export const supportsInputFidelity = (model: string): boolean => /^gpt-image-1/.test(model);

/** Rough cost of one render, for the estimate shown next to the model picker. */
export const estimateOpenAiCost = (quality: string): number => openAiTierFor(quality).approxUsd;

/**
 * What the shared prompt assumes, spelled out for this provider.
 *
 * The directive `renderRequest` writes is addressed by position throughout —
 * "Input Image 3: THE SUBJECT", "preserve the face in Input Image 3". Gemini
 * resolves those against the order of the parts it was sent. The images/edits
 * endpoint takes an unlabelled array instead, and a model given sixteen
 * anonymous photographs and a directive about "Input Image 3" cannot bind the
 * two: it falls back on the words alone and invents a person and garments to
 * match them, which is why the OpenAI renders came back looking synthesised
 * rather than photographed. Stating the correspondence is the only place to
 * repair it from the client.
 *
 * The photographic instruction is here for a related reason. Gemini's default
 * output for this prompt is a photograph; the OpenAI image models drift toward
 * a rendered, illustrative look unless told otherwise, and "commercial
 * photograph" further down the directive has not been enough on its own.
 */
export const openAiPreamble = (imageCount: number): string =>
  `THE ATTACHED PHOTOGRAPHS ARE AN ORDERED LIST. There ${imageCount === 1 ? 'is 1' : `are ${imageCount}`} of them. ` +
  `Throughout the directive below, "Input Image 1" means the FIRST attached photograph, ` +
  `"Input Image 2" the SECOND, and so on to "Input Image ${imageCount}", the LAST. ` +
  `Every rule below is addressed to a specific one of them by that number. Resolve each ` +
  `reference to that exact photograph before you render; do not treat the attachments as a ` +
  `general mood board.

` +
  `THE OUTPUT IS A PHOTOGRAPH. Real camera, real optics, real skin and real fabric. ` +
  `Not a 3D render, not CGI, not an illustration, not a game or film asset, and not a ` +
  `stylised or plastic-looking figure.

`;

const base64ToBlob = (base64: string, mimeType: string): Blob => {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mimeType });
};

/** File extension the endpoint will accept for a given mime type. */
const extensionFor = (mimeType: string): string =>
  mimeType === 'image/jpeg' ? 'jpg' : mimeType === 'image/webp' ? 'webp' : 'png';

interface OpenAiErrorShape {
  status: number | null;
  message: string;
}

const readError = async (res: Response): Promise<OpenAiErrorShape> => {
  let message = `${res.status} ${res.statusText}`;
  try {
    const body = await res.json();
    if (body?.error?.message) message = body.error.message;
  } catch {
    // Non-JSON error body; the status line is all we have.
  }
  return { status: res.status, message };
};

/**
 * Renders one try-on shot through OpenAI.
 *
 * Signature matches `generateTryOnImage` argument for argument so the two are
 * interchangeable at the call site.
 */
export const generateTryOnImageOpenAI = async (
  clothingBase64_1: GarmentInput = null,
  clothingBase64_2: GarmentInput = null,
  clothingBase64_3: GarmentInput = null,
  modelBase64: GarmentInput = null,
  userPrompt: string = '',
  modelDescription: string = '',
  quality: string = '1K',
  roomBase64?: string | null,
  lightingBase64?: string | null,
  onDiagnostics?: (diagnostics: RenderDiagnostics) => void,
  extras: RenderExtras = {}
): Promise<string> => {
  const request = await buildRenderRequest({
    footwear: clothingBase64_1,
    bottoms: clothingBase64_2,
    top: clothingBase64_3,
    subject: modelBase64,
    userPrompt,
    modelDescription,
    room: roomBase64,
    lighting: lightingBase64,
    maxImages: OPENAI_MAX_IMAGES,
    ...extras,
  });

  if (!request.images.length) {
    throw new Error(
      'Nothing to render from: no product, person or scene photograph survived preparation. Re-upload the references and try again.'
    );
  }

  const model = OPENAI_IMAGE_MODEL;
  const tier = openAiTierFor(quality);
  const size = openAiSizeFor(request.aspectRatio);
  logRenderRequest('OpenAI', request, model, quality);

  // Truncating is better than a 400 that costs a round trip, but the operator
  // has to know the directive was cut or they will read the missing rule as a
  // model failure.
  let prompt = openAiPreamble(request.images.length) + request.prompt;
  if (prompt.length > OPENAI_MAX_PROMPT_CHARS) {
    console.warn(
      `[Studio Engine · OpenAI] Prompt is ${prompt.length} chars, over the ${OPENAI_MAX_PROMPT_CHARS} limit. It was truncated; the tail of the directive did not reach the model.`
    );
    prompt = prompt.slice(0, OPENAI_MAX_PROMPT_CHARS);
  }

  console.log('================ REQUEST MANIFEST (OpenAI) ================');
  console.log(
    `Model: ${model} - quality ${quality} -> ${tier.quality}/${tier.input_fidelity} - ${size} (from ${request.aspectRatio})`
  );
  console.log(`Attachments (${request.images.length}), in the order sent.`);
  if (request.dropped.length) {
    console.warn(
      `Dropped to fit the ${OPENAI_MAX_IMAGES}-image limit: ` +
        request.dropped.map((a) => `#${a.idx} ${a.role}`).join(', ')
    );
  }
  console.log(`Prompt characters: ${prompt.length}`);
  console.log('===========================================================');

  onDiagnostics?.(request.diagnostics);

  // `input_fidelity` is what keeps a logo where the photograph puts it. It is
  // sent to the models that accept it and omitted for the ones that reject it
  // (`supportsInputFidelity`) — decided HERE, before the request, never by
  // replaying a rejected request without it. That replay used to exist and was
  // a hidden second HTTP request per render.
  const form = new FormData();
  form.append('model', model);
  form.append('prompt', prompt);
  form.append('size', size);
  form.append('quality', tier.quality);
  if (supportsInputFidelity(model)) form.append('input_fidelity', tier.input_fidelity);
  form.append('n', '1');
  // PNG so the returned data URL matches what the Gemini path hands back and
  // the export/crop code downstream needs no special case.
  form.append('output_format', 'png');

  request.images.forEach((img) => {
    form.append(
      'image[]',
      base64ToBlob(img.data, img.mimeType),
      `input-${img.idx}.${extensionFor(img.mimeType)}`
    );
  });

  // ---------------------------------------------------------------------
  // ONE REQUEST, ON THE CONFIGURED MODEL. NO RETRY, NO PARAMETER REPLAY,
  // NO SECOND MODEL.
  //
  // What stood here was a two-attempt loop with a 5s backoff on transient
  // failures, plus a third request whenever `input_fidelity` was rejected.
  // One click on Render could therefore produce three requests. It now
  // produces one; a failure is reported and the user decides whether to
  // spend another by pressing Retry.
  // ---------------------------------------------------------------------
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  const fail = (reason: string, status?: number, cause?: unknown): never => {
    console.error(`[Studio Engine · OpenAI] Render failed; nothing else was tried. ${reason}`);
    throw new AiRequestError({ provider: 'openai', model, reason, status, cause });
  };

  try {
    console.log(`[Studio Engine · OpenAI] Invoking '${model}' — one attempt, no fallback.`);

    let res: Response;
    try {
      res = await fetch(`${window.location.origin}/api/openai/v1/images/edits`, {
        method: 'POST',
        body: form,
        signal: controller.signal,
      });
    } catch (err: any) {
      return err?.name === 'AbortError'
        ? fail(
            `The render did not finish within ${REQUEST_TIMEOUT_MS / 1000}s and was abandoned. It was NOT resent.`,
            undefined,
            err
          )
        : fail(err instanceof Error ? err.message : String(err), undefined, err);
    }

    if (!res.ok) {
      const { status, message } = await readError(res);
      return fail(
        status === 401 || status === 403
          ? `The key was refused (${status}). Set OPENAI_API_KEY in .env to a valid key and restart the server. Message: ${message}`
          : message,
        status ?? undefined
      );
    }

    const body = await res.json();

    if (body?.usage) {
      // Logged so a bill can be attributed to renders instead of guessed at.
      console.log(
        `[Studio Engine · OpenAI] usage: input ${body.usage.input_tokens ?? '?'} / output ${body.usage.output_tokens ?? '?'} tokens`
      );
    }

    const b64 = body?.data?.[0]?.b64_json;
    if (!b64) {
      // A 200 with no image is terminal: the call was billed, and repeating it
      // bills again for the same non-answer.
      return fail(
        'The response contained no image. This is usually a content refusal on one of the reference photographs — swap the references and render again.'
      );
    }

    return `data:image/png;base64,${b64}`;
  } finally {
    clearTimeout(timer);
  }
};
