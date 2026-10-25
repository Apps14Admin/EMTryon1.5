import { GoogleGenAI } from "@google/genai";

/**
 * The Gemini renderer.
 *
 * Model ids are not written here — they come from `aiModels.ts`, the
 * application's AI configuration. This module re-exports them so existing
 * importers keep working; it does not define an id of its own, and it renders
 * with the model the user selected and no other.
 *
 * The request is assembled by `renderRequest.ts` — the one assembly every
 * engine shares.
 *
 * ONE REQUEST PER RENDER. No retry, no fallback, no second model.
 */
import {
  AiRequestError,
  DEFAULT_GEMINI_MODEL,
  GEMINI_MODELS,
  GEMINI_MODEL_CHOICES,
  geminiImageSizeFor,
  resolveGeminiModel,
  type GeminiModel,
} from './aiModels';
import { getGeminiModel, setGeminiModel } from './aiProvider';
import {
  buildRenderRequest,
  logRenderRequest,
  type GarmentInput,
  type GarmentPhoto,
  type RenderDiagnostics,
  type RenderExtras,
} from './renderRequest';

export {
  GEMINI_MODELS,
  GEMINI_MODEL_CHOICES,
  DEFAULT_GEMINI_MODEL,
  getGeminiModel,
  setGeminiModel,
};
export type { GeminiModel, GarmentPhoto, RenderDiagnostics };

export const generateTryOnImage = async (
  clothingBase64_1: GarmentInput = null,
  clothingBase64_2: GarmentInput = null,
  clothingBase64_3: GarmentInput = null,
  modelBase64: GarmentInput = null,
  userPrompt: string = "",
  modelDescription: string = "",
  quality: string = "1K",
  roomBase64?: string | null,
  lightingBase64?: string | null,
  // Called before the model is invoked with what this render was assembled
  // from, before the model is called.
  onDiagnostics?: (diagnostics: RenderDiagnostics) => void,
  extras: RenderExtras = {}
): Promise<string> => {
  // The model the user selected. Read from the configuration rather than
  // derived, and used exactly as selected: Lite means Lite, Flash means Flash,
  // Pro means Pro.
  const primaryModel = resolveGeminiModel(getGeminiModel());

  // The real API key lives server-side. Requests go to our own /api/gemini
  // proxy, which attaches the key before forwarding to Google.
  const ai = new GoogleGenAI({
    apiKey: 'proxied',
    httpOptions: { baseUrl: `${window.location.origin}/api/gemini` },
  });

  const request = await buildRenderRequest({
    footwear: clothingBase64_1,
    bottoms: clothingBase64_2,
    top: clothingBase64_3,
    subject: modelBase64,
    userPrompt,
    modelDescription,
    room: roomBase64,
    lighting: lightingBase64,
    ...extras,
  });

  logRenderRequest('Gemini', request, primaryModel, quality);

  // Reported before the model is called, so the UI can state what this render
  // was built from even if the render itself then fails.
  onDiagnostics?.(request.diagnostics);

  // The size each model accepts differs (Flash 512–4K, Pro 1K–4K, Lite 1K
  // only) and an unsupported size is a 400, not a downgrade — so the mapping
  // lives in one tested place, `geminiImageSizeFor`, shared with the batch
  // path.
  const imageConfig: any = { aspectRatio: request.aspectRatio };
  const imageSize = geminiImageSizeFor(primaryModel, quality);
  if (imageSize) imageConfig.imageSize = imageSize;

  const parts: any[] = request.images.map((img) => ({
    inlineData: { mimeType: img.mimeType, data: img.data },
  }));
  parts.push({ text: request.prompt });

  console.log(`[Studio Engine] Invoking '${primaryModel}' — one attempt, no fallback.`);

  let response: any;
  try {
    response = await ai.models.generateContent({
      model: primaryModel,
      contents: { parts },
      config: { imageConfig },
    });
  } catch (err: any) {
    const raw = err?.message || String(err);
    const status = /(400|401|403|404|429|500|503|504)/.exec(raw);

    // The raw SDK error is a JSON blob and was being shown verbatim. Name the
    // condition instead — but never suggest, or perform, another model.
    const reason = /(503|500)|high demand|unavailable|overloaded/i.test(raw)
      ? `The model is saturated (${status?.[1] ?? '503'}). Nothing is wrong with your uploads or your prompt.`
      : /429|resource_exhausted|quota/i.test(raw)
        ? 'RESOURCE_EXHAUSTED — the quota or rate limit for this model is spent.'
        : /(401|403)|permission|api key|api_key_invalid/i.test(raw)
          ? 'The API key was refused (401/403).'
          : /404|not found|unknown name/i.test(raw)
            ? 'This model id was not found on this key.'
            : /abort|timed out|timeout/i.test(raw)
              ? 'The request was abandoned at its time limit.'
              : raw;

    console.error('[Studio Engine] Render failed; nothing else was tried.', err);
    throw new AiRequestError({
      provider: 'gemini',
      model: primaryModel,
      reason,
      status: status ? Number(status[1]) : undefined,
      cause: err,
    });
  }

  // What this render actually consumed, straight from the API's own meter.
  const meta = response?.usageMetadata;
  if (meta) {
    console.log(
      `[Studio Engine] USAGE — model: ${primaryModel} · input tokens: ${meta.promptTokenCount ?? '?'} · ` +
        `output tokens: ${meta.candidatesTokenCount ?? '?'} · total: ${meta.totalTokenCount ?? '?'}`
    );
  }

  let raw: string | null = null;
  for (const part of response?.candidates?.[0]?.content?.parts ?? []) {
    if (part.inlineData?.data) {
      raw = `data:${part.inlineData.mimeType || 'image/png'};base64,${part.inlineData.data}`;
      break;
    }
  }

  // A 200 with no picture is terminal, not something to retry: the call was
  // billed, and repeating it bills again for the same non-answer.
  if (!raw) {
    throw new AiRequestError({
      provider: 'gemini',
      model: primaryModel,
      reason:
        'The model returned a response containing no image. This is usually a content refusal on one of the reference photographs.',
    });
  }

  return raw;
};
