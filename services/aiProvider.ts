/**
 * ONE provider selection for the whole application.
 *
 * The user selects a provider — and, on Gemini, a model — once. `modelsFor` in
 * `aiModels.ts` turns that selection into both model ids, and that is the only
 * routing there is.
 *
 * There used to be two singletons here, one for the renderer and one for
 * analysis, which meant "OpenAI" in the picker could mean OpenAI for pictures
 * and Gemini for questions at the same time.
 *
 * Module state rather than React context: the analysis calls are made from
 * plain service code with no component above them, so a singleton is the only
 * way to reach them without threading a provider argument through every layer.
 *
 * NOTHING in this file retries, falls back, or substitutes a model. A request
 * that fails throws, once, and the caller shows the error.
 */

import {
  AiProvider,
  AiRequestError,
  DEFAULT_GEMINI_MODEL,
  GeminiModel,
  ProviderModels,
  resolveGeminiModel,
  modelsFor,
} from './aiModels';

export type { AiProvider } from './aiModels';

/**
 * Gemini is the starting value because it is the provider that works with only
 * the required key set. The UI moves it once the server has answered whether
 * an OpenAI key exists; until then nothing has been sent.
 */
let activeProvider: AiProvider = 'gemini';

/** Which of the configured Gemini models renders, when Gemini is selected. */
let activeGeminiModel: GeminiModel = DEFAULT_GEMINI_MODEL;

export const setAiProvider = (provider: AiProvider): void => {
  activeProvider = provider;
};

export const getAiProvider = (): AiProvider => activeProvider;

/**
 * Records the user's Gemini model choice.
 *
 * An id the configuration does not contain throws here rather than being
 * quietly replaced with the default, so a bad value is a visible bug and not a
 * render that silently used a different model from the one on screen.
 */
export const setGeminiModel = (model: GeminiModel): void => {
  activeGeminiModel = resolveGeminiModel(model);
};

export const getGeminiModel = (): GeminiModel => activeGeminiModel;

/** Both model ids for the current selection. The deterministic routing lookup. */
export const activeModels = (): ProviderModels =>
  modelsFor(activeProvider, activeGeminiModel);

/** The id that will answer the next analysis question. */
export const activeAnalysisModel = (): string => activeModels().analysis;

/** The id that will render the next picture. */
export const activeGenerationModel = (): string => activeModels().generation;

/**
 * Per-request ceiling for an OpenAI analysis call.
 *
 * Deliberately far above the Gemini path's, for two reasons that compound. A
 * chat-vision request carrying twelve base64 photographs is a different shape
 * of request from a Gemini flash one; and the configured analysis model is a
 * REASONING model, measured spending 512 reasoning tokens on a request of four
 * trivial images. A real folder batch is twelve real photographs.
 *
 * Set high on purpose. An abort does not refund anything: the tokens generated
 * before the ceiling fired are billed, and the folder fails as well — so a
 * ceiling set too low is the worst of both. This is the outer bound that stops
 * a genuinely hung socket, not a latency target.
 *
 * A ceiling is not a retry. When it fires the request is abandoned and the
 * failure is reported; nothing is sent again.
 */
export const OPENAI_ANALYSIS_TIMEOUT_MS = 150_000;

/**
 * Gemini's request shape, translated for OpenAI's chat endpoint.
 *
 * Callers assemble `parts` — `{ text }` and `{ inlineData: { mimeType, data } }`
 * — because that is what the Gemini SDK takes. Rather than fork every prompt
 * builder, the parts are converted here: text stays text, and inline image
 * bytes become the `data:` URLs OpenAI expects.
 *
 * Two things about that translation are not cosmetic.
 *
 * FIRST, every image is announced by a numbered line of its own. Both prompts
 * this app sends are addressed by position — "there are 12 photographs,
 * numbered 0 to 11", then one answer per number. Gemini reads that numbering
 * off the order of the `parts` array. OpenAI's chat format has no such
 * implicit numbering: a bare run of images is a set, not a list, and asked to
 * number them the model guesses. That is what produced a folder of a hundred
 * photographs answered as ONE product — not a failure to tell the shoes apart,
 * but an inability to say which answer belonged to which photograph.
 *
 * SECOND, the instruction goes first. Both callers push their prompt text last
 * because that is the order Gemini was tuned on; OpenAI attends to an
 * instruction that precedes the evidence, and a directive arriving after
 * twelve images is read as a footnote to them.
 */
const toOpenAiContent = (parts: any[]): any[] => {
  const instructions = parts.filter((part) => !part?.inlineData);
  const images = parts.filter((part) => part?.inlineData);

  const content: any[] = instructions.map((part) => ({ type: 'text', text: part?.text ?? '' }));

  images.forEach((part, i) => {
    content.push({ type: 'text', text: `Photograph ${i}:` });
    content.push({
      type: 'image_url',
      image_url: {
        url: `data:${part.inlineData.mimeType || 'image/jpeg'};base64,${part.inlineData.data}`,
        // The judgement is "same colourway or a different one", which is
        // exactly what the downsampled low-detail encoding destroys. These are
        // already-shrunk scout copies, so full detail on them is cheap.
        detail: 'high',
      },
    });
  });

  return content;
};

/**
 * OpenAI's answer, translated back into Gemini's response shape.
 *
 * Both call sites read `res.candidates[0].content.parts[].text`. Returning
 * that shape means neither the angle mapper nor the folder grouper needs to
 * know which provider answered — the switch stays in one place.
 */
const toGeminiShape = (text: string, usage?: any): any => ({
  candidates: [{ content: { parts: [{ text }] } }],
  ...(usage
    ? {
        usageMetadata: {
          promptTokenCount: usage.prompt_tokens,
          candidatesTokenCount: usage.completion_tokens,
        },
      }
    : {}),
});

/**
 * ONE analysis request through the OpenAI proxy, on the configured analysis
 * model. One HTTP call, no retry, no second id.
 *
 * The key is attached by our own `/api/openai` proxy, exactly as with the
 * Gemini path — the browser bundle carries neither key.
 *
 * The HTTP status is put in the thrown message because the UI reads it back
 * out to say what went wrong. It is no longer read by any code that decides
 * whether to send another request, because no such code exists any more.
 */
export interface AnalysisOptions {
  /**
   * Sampling temperature. Gemini only.
   *
   * NOT sent to OpenAI on purpose: the configured analysis id is a reasoning
   * model, and those reject `temperature` with a 400. Since nothing in this
   * codebase retries, one rejected parameter would fail the whole folder rather
   * than degrade — so the determinism OpenAI gets is the schema, not the knob.
   */
  temperature?: number;
  /**
   * The exact shape the answer must take.
   *
   * Worth more than the temperature. A schema removes the entire class of
   * failure where a reply is prose, a fenced block, a missing field or a
   * renamed key — all of which the parsers downstream have to guard against by
   * hand, and any of which loses a whole request's worth of judgements.
   */
  schema?: Record<string, unknown>;
  /** Name for the schema. OpenAI requires one; Gemini ignores it. */
  schemaName?: string;
}

/**
 * The same schema, in the dialect Gemini wants.
 *
 * The two providers do not accept the same document. OpenAI's structured
 * outputs take standard JSON Schema — lowercase types, and under `strict` every
 * property must be listed in `required` with `additionalProperties: false`.
 * Gemini takes an OpenAPI-flavoured schema with UPPERCASE type names and
 * rejects `additionalProperties` outright.
 *
 * So the schemas in this codebase are written once, as JSON Schema, and
 * translated here. Writing two by hand would mean two things to keep in step,
 * and the one that drifted would fail only at runtime, on a real folder.
 */
export const toGeminiSchema = (schema: Record<string, unknown>): Record<string, unknown> => {
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (!node || typeof node !== 'object') return node;

    const out: Record<string, unknown> = {};
    Object.entries(node as Record<string, unknown>).forEach(([key, value]) => {
      // Meaningless to Gemini, and `additionalProperties` is rejected.
      if (key === 'additionalProperties' || key === 'strict') return;
      if (key === 'type' && typeof value === 'string') {
        out.type = value.toUpperCase();
        return;
      }
      out[key] = walk(value);
    });
    return out;
  };

  return walk(schema) as Record<string, unknown>;
};

export const askOpenAiAnalysis = async (
  model: string,
  parts: any[],
  ms: number,
  options: AnalysisOptions = {}
): Promise<any> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);

  try {
    const res = await fetch(`${window.location.origin}/api/openai/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: toOpenAiContent(parts) }],
        ...(options.schema
          ? {
              response_format: {
                type: 'json_schema',
                json_schema: {
                  name: options.schemaName ?? 'answer',
                  strict: true,
                  schema: options.schema,
                },
              },
            }
          : {}),
      }),
    });

    if (!res.ok) {
      // Body first: OpenAI puts the reason ("model not found", the quota that
      // ran out) in it, and the status alone cannot tell those apart.
      const body = await res.text().catch(() => '');
      throw new AiRequestError({
        provider: 'openai',
        model,
        reason: `OpenAI ${res.status}: ${body.slice(0, 500)}`,
        status: res.status,
      });
    }

    const json = await res.json();
    return toGeminiShape(json?.choices?.[0]?.message?.content ?? '', json?.usage);
  } finally {
    clearTimeout(timer);
  }
};
