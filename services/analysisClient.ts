import { GEMINI_ANALYSIS_MODEL } from './aiModels';
import {
  getAiProvider,
  activeAnalysisModel,
  OPENAI_ANALYSIS_TIMEOUT_MS,
  askOpenAiAnalysis,
  toGeminiSchema,
  type AnalysisOptions,
} from './aiProvider';

/**
 * The model that answers every analysis question, for the provider currently
 * selected. ONE id. Not a list, and not walkable.
 *
 * This replaced a two-id walk that moved to a second model whenever the first
 * answered 404 or 429. Neither of those ids is part of the configuration now,
 * and the walk itself is gone independently of that: a second model is a
 * second billed request the user did not ask for.
 *
 * See `GEMINI_ANALYSIS_MODEL` in `aiModels.ts` for the note about analysis and
 * render quota sharing a pool.
 */
export const analysisModel = (): string => activeAnalysisModel();

/** The Gemini id analysis uses. Exported for the UI, which names it on screen. */
export const ANALYSIS_MODEL = GEMINI_ANALYSIS_MODEL;

/** True for "that model id is not something I have". */
export const isModelUnavailable = (err: unknown): boolean => {
  const message = String((err as any)?.message ?? err).toLowerCase();
  return (
    message.includes('404') ||
    message.includes('not_found') ||
    message.includes('not found') ||
    message.includes('unknown name') ||
    message.includes('does not exist') ||
    message.includes('not supported') ||
    message.includes('unsupported')
  );
};

/** True for a refused-on-allowance answer: 429 / RESOURCE_EXHAUSTED / quota. */
export const isRateLimited = (err: unknown): boolean => {
  const message = String((err as any)?.message ?? err).toLowerCase();
  return (
    message.includes('429') ||
    message.includes('resource_exhausted') ||
    message.includes('quota')
  );
};

/**
 * Per-request ceiling. A model that stops answering hangs the socket rather
 * than failing, so without this the UI waits on it indefinitely with no way
 * to tell the user anything.
 *
 * A ceiling is not a retry: when it fires the request is abandoned and the
 * failure reported. Nothing is sent again.
 */
export const ANALYSIS_TIMEOUT_MS = 60_000;

/**
 * That ceiling, for the provider currently selected. An OpenAI chat-vision
 * request on twelve photographs is legitimately slower than a Gemini flash
 * one, and applying the Gemini number to it aborted the folder's first
 * request, which is fatal to the whole run.
 */
export const analysisTimeoutMs = (): number =>
  getAiProvider() === 'openai' ? OPENAI_ANALYSIS_TIMEOUT_MS : ANALYSIS_TIMEOUT_MS;

/** Aborts a request that outlives the ceiling, and cleans its timer up. */
const withTimeout = async <T>(
  run: (signal: AbortSignal) => Promise<T>,
  ms: number = analysisTimeoutMs()
): Promise<T> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await run(controller.signal);
  } finally {
    clearTimeout(timer);
  }
};

/**
 * ONE analysis request, to the ONE model the selected provider maps to.
 *
 * There is no loop in this function and no second id to reach for. Whatever
 * the failure — a missing id, a spent quota, a 503, a timeout — it is thrown
 * to the caller as it stands. Every one of those used to move the request to
 * another model, and each of those moves was a billed call the user had not
 * asked for.
 *
 * Shared by the folder grouper and the angle strip so both go through the same
 * single-attempt path.
 */
export const askAnalysisModel = async (
  ai: { models: { generateContent: (args: any) => Promise<any> } },
  parts: any[],
  ms: number = analysisTimeoutMs(),
  options: AnalysisOptions = {}
): Promise<any> => {
  const provider = getAiProvider();
  const model = analysisModel();

  try {
    // The `ai` client is only built by the Gemini path; on OpenAI it is
    // ignored rather than removed, so every caller stays a single call.
    if (provider === 'openai') return await askOpenAiAnalysis(model, parts, ms, options);

    return await withTimeout(
      (abortSignal) =>
        ai.models.generateContent({
          model,
          contents: { parts },
          config: {
            abortSignal,
            ...(options.temperature === undefined
              ? {}
              : { temperature: options.temperature }),
            ...(options.schema
              ? {
                  responseMimeType: 'application/json',
                  responseSchema: toGeminiSchema(options.schema),
                }
              : {}),
          },
        }),
      ms
    );
  } catch (err) {
    // Which id was actually used travels with the error. Without it the caller
    // can only report "analysis failed", and the difference between a retired
    // model id and an empty account is invisible from the UI.
    if (err && typeof err === 'object') {
      (err as any).analysisModels = [model];
      (err as any).aiProvider = provider;
      (err as any).aiModel = model;
    }
    throw err;
  }
};
