/**
 * THE AI CONFIGURATION.
 *
 * Every model id this application uses is written here, as a literal, once.
 * The renderer, the batch submitter, the folder grouper, the angle classifier,
 * the UI and the server proxy all read their ids from this file — so there is
 * one place to look to answer "what does this application call".
 *
 * The principle, stated plainly:
 *
 *     The user selects the AI configuration once. The application uses
 *     exactly that configuration, and never invents, discovers, retries
 *     with, or switches to another model.
 *
 * What follows from that, and is true of this file:
 *
 *   - Model ids are CONFIGURED, never derived. Nothing here is templated,
 *     concatenated, versioned, aliased, or read from a discovery endpoint.
 *     There is no `latest`, no `-preview`, no `-exp`.
 *   - A provider resolves to its two model ids deterministically. Selecting
 *     OpenAI selects Luna for analysis and Image 2 for generation, always.
 *   - There is no alternative id for anything. A model that fails is a failed
 *     request; there is nothing configured for the application to move to.
 */

/**
 * AVAILABLE GEMINI MODELS.
 *
 * These are the Gemini models the application offers. The user picks one and
 * that exact id renders — Lite means Lite, Flash means Flash, Pro means Pro.
 *
 * All three were checked against this key's own model list and confirmed to
 * support `generateContent`. That check is a DEVELOPMENT step, done once, to
 * source correct literals for this file — the application itself never lists
 * models at runtime.
 *
 * MIND THE LITE ID: it is `flash-lite-image`, not `flash-image-lite`. The
 * segments read <family>-<tier>-<modality>, so "lite" sits with "flash" and
 * "image" comes last, exactly as it does in the other two ids. The transposed
 * spelling looks entirely plausible, is what one writes from memory, and
 * answers 404 — it cost a full 110-photo folder run to find.
 */
export const GEMINI_MODELS = {
  LITE: 'gemini-3.1-flash-lite-image',
  FLASH: 'gemini-3.1-flash-image',
  PRO: 'gemini-3-pro-image',
} as const;

export type GeminiModel = (typeof GEMINI_MODELS)[keyof typeof GEMINI_MODELS];

/** The configured ids as a frozen array, for iteration and for the UI. */
export const GEMINI_MODEL_IDS: readonly GeminiModel[] = Object.freeze([
  GEMINI_MODELS.LITE,
  GEMINI_MODELS.FLASH,
  GEMINI_MODELS.PRO,
]);

/**
 * What the Gemini model dropdown offers. The ids come from the configuration
 * above rather than being retyped, so the label the user reads and the id that
 * is sent cannot drift apart.
 */
export const GEMINI_MODEL_CHOICES: readonly {
  id: GeminiModel;
  label: string;
  note: string;
}[] = Object.freeze([
  { id: GEMINI_MODELS.LITE, label: 'Flash Image Lite', note: 'fastest, cheapest' },
  { id: GEMINI_MODELS.FLASH, label: 'Flash Image', note: 'balanced — the default' },
  { id: GEMINI_MODELS.PRO, label: 'Pro Image', note: 'best quality, slowest — honours 2K/4K' },
]);

/** The Gemini model selected when the user has not chosen one. */
export const DEFAULT_GEMINI_MODEL: GeminiModel = GEMINI_MODELS.FLASH;

/** One entry in the per-model quality dropdown. */
export interface QualityChoice {
  id: string;
  label: string;
}

/**
 * The output sizes each model ACCEPTS, one list per model — not one shared
 * list. Every cell was verified against the live API (Sept 2026), where an
 * unsupported size answers 400 "Image size X is not supported for this
 * model" rather than downgrading:
 *
 *            512   1K    2K    4K
 *   Lite     400   OK    400   400
 *   Flash    OK    OK    OK    OK
 *   Pro      400   OK    OK    OK
 *
 * Offering a size a model rejects fails the whole render, and offering a
 * size it silently ignores bills a tier the user did not pick — so the
 * dropdown must be built from this table and nothing else.
 */
export const GEMINI_QUALITY_CHOICES: Record<GeminiModel, readonly QualityChoice[]> =
  Object.freeze({
    [GEMINI_MODELS.LITE]: Object.freeze([{ id: '1K', label: 'Standard (1K) — the only size Lite renders' }]),
    [GEMINI_MODELS.FLASH]: Object.freeze([
      { id: 'draft', label: 'Draft (512px) — fastest and cheapest; fine detail is soft' },
      { id: '1K', label: 'Standard (1K) — sharper product for finals' },
      { id: '2K', label: 'Premium (2K) — slower' },
      { id: '4K', label: 'Studio (4K) — slowest' },
    ]),
    [GEMINI_MODELS.PRO]: Object.freeze([
      { id: '1K', label: 'Standard (1K)' },
      { id: '2K', label: 'Premium (2K) — slower' },
      { id: '4K', label: 'Studio (4K) — slowest' },
    ]),
  });

export const qualityChoicesFor = (model: GeminiModel): readonly QualityChoice[] =>
  GEMINI_QUALITY_CHOICES[model] ?? GEMINI_QUALITY_CHOICES[DEFAULT_GEMINI_MODEL];

/**
 * A quality the current model cannot honour is moved to one it can, never
 * sent: 'low' (a retired tier that meant 512) becomes 'draft' where draft
 * exists, and anything else falls to the model's first offered choice.
 */
export const coerceQuality = (model: GeminiModel, quality: string): string => {
  const choices = qualityChoicesFor(model);
  if (choices.some((c) => c.id === quality)) return quality;
  if (quality === 'low' && choices.some((c) => c.id === 'draft')) return 'draft';
  return choices[0].id;
};

/**
 * The `imageSize` actually sent for a model/quality pair — the single
 * mapping both the interactive and the batch path use, so the two cannot
 * drift apart. `undefined` means send nothing and take the model's default.
 */
export const geminiImageSizeFor = (
  model: string,
  quality: string
): '512' | '1K' | '2K' | '4K' | undefined => {
  if (model === GEMINI_MODELS.PRO) {
    return quality === '1K' || quality === '2K' || quality === '4K' ? quality : undefined;
  }
  if (model === GEMINI_MODELS.FLASH) {
    if (quality === 'draft' || quality === 'low') return '512';
    return quality === '1K' || quality === '2K' || quality === '4K' ? quality : undefined;
  }
  // Lite: 1K is the only size it accepts; everything else takes the default.
  return quality === '1K' ? '1K' : undefined;
};

/**
 * The Gemini model configured to answer analysis questions — which
 * photographs show the same product, which view a photograph is.
 *
 * Lite, because analysis returns a short JSON array and gains nothing from
 * Pro. It is a fixed part of the configuration, not something the render
 * selection moves: choosing Pro to render with does not make every grouping
 * request a Pro request.
 *
 * Worth stating, because it is a real cost: this draws on the same allowance
 * the renders draw on. An earlier design used separate text-only ids to keep
 * the two pools apart; those ids are not part of this configuration, so that
 * separation is not available.
 */
export const GEMINI_ANALYSIS_MODEL: GeminiModel = GEMINI_MODELS.LITE;

/**
 * OPENAI CONFIGURATION.
 *
 * Two capabilities, two configured models, and the user selects neither of
 * them individually. Selecting "OpenAI" selects both:
 *
 *     OpenAI
 *      ├── Analysis   -> Luna    (gpt-5.6-luna)
 *      └── Generation -> Image 2 (gpt-image-2)
 *
 * These are the API ids for the two models named for this application: Luna
 * for image understanding, Image 2 for image generation. The product names and
 * the API ids differ, and it is the API ids that must be written here — an
 * earlier revision configured the product names verbatim and every analysis
 * request came back `model_not_found`. Both ids below were confirmed present
 * on this account, and `gpt-5.6-luna` was confirmed to accept image inputs.
 *
 * Two ids rather than one because the jobs are different in kind: analysis
 * asks a question about photographs and needs words back, generation returns
 * a picture. Neither id substitutes for the other, and neither is discovered
 * or replaced at runtime.
 *
 * NOTE — Luna is a REASONING model. It spent 512 reasoning tokens answering a
 * four-image request, which is why the OpenAI analysis ceilings in
 * `aiProvider.ts` and `angleMapper.ts` are set well above the Gemini ones. A
 * ceiling that fires part-way still bills the tokens already generated, so a
 * ceiling set too low wastes money AND fails the folder.
 */
export const OPENAI_MODELS = {
  ANALYSIS: 'gpt-5.6-luna',
  GENERATION: 'gpt-image-2',
} as const;

/** The OpenAI model configured for image understanding / analysis. */
export const OPENAI_ANALYSIS_MODEL = OPENAI_MODELS.ANALYSIS;

/** The OpenAI model configured for image generation. */
export const OPENAI_IMAGE_MODEL = OPENAI_MODELS.GENERATION;

export type AiProvider = 'gemini' | 'openai';

export const AI_PROVIDERS: readonly AiProvider[] = Object.freeze(['gemini', 'openai']);

/** True for a model id that is part of the Gemini configuration. */
export const isConfiguredGeminiModel = (id: unknown): id is GeminiModel =>
  typeof id === 'string' && (GEMINI_MODEL_IDS as readonly string[]).includes(id);

/**
 * The configured Gemini model for a selection.
 *
 * It throws on an id the configuration does not contain, rather than quietly
 * resolving to a default. Substituting a different model for the one that was
 * asked for is the behaviour this architecture exists to prevent — including
 * when the caller is this application's own code with a stale value. A caller
 * that asked for something the configuration does not have must find out.
 */
export const resolveGeminiModel = (id: unknown): GeminiModel => {
  if (!isConfiguredGeminiModel(id)) {
    throw new Error(
      `'${String(id)}' is not part of this application's Gemini configuration. ` +
        `The configured models are ${GEMINI_MODEL_IDS.join(', ')}. ` +
        `No substitute was selected for you.`
    );
  }
  return id;
};

/** The two model ids a provider resolves to. */
export interface ProviderModels {
  provider: AiProvider;
  /** Answers questions about photographs. */
  analysis: string;
  /** Renders pictures. */
  generation: string;
}

/**
 * Provider in, both configured model ids out.
 *
 * This is the whole of the application's model routing. There is no other
 * function that decides which model does which job, and this one consults
 * nothing but the configuration above and the user's selection.
 *
 * `geminiModel` is the model the user picked from the three offered. It
 * applies to generation; Gemini analysis stays on its configured id.
 */
export const modelsFor = (
  provider: AiProvider,
  geminiModel: GeminiModel = DEFAULT_GEMINI_MODEL
): ProviderModels =>
  provider === 'openai'
    ? { provider, analysis: OPENAI_ANALYSIS_MODEL, generation: OPENAI_IMAGE_MODEL }
    : {
        provider,
        analysis: GEMINI_ANALYSIS_MODEL,
        generation: resolveGeminiModel(geminiModel),
      };

/**
 * One failed AI call, described the way the user is shown it.
 *
 * Provider and model are carried on the error rather than dug out of its text,
 * because the message the UI prints names both, and reconstructing them from a
 * stack trace is how an error ends up naming a model nobody selected.
 */
export class AiRequestError extends Error {
  readonly provider: AiProvider;
  readonly model: string;
  readonly reason: string;
  readonly status?: number;

  constructor(args: {
    provider: AiProvider;
    model: string;
    reason: string;
    status?: number;
    cause?: unknown;
  }) {
    super(`Generation failed\nProvider: ${args.provider}\nModel: ${args.model}\nReason: ${args.reason}`);
    this.name = 'AiRequestError';
    this.provider = args.provider;
    this.model = args.model;
    this.reason = args.reason;
    this.status = args.status;
    (this as any).cause = args.cause;
  }
}

/** Provider label as the UI writes it. */
export const providerLabel = (provider: AiProvider): string =>
  provider === 'openai' ? 'OpenAI' : 'Gemini';
