import { GoogleGenAI } from '@google/genai';
import { askAnalysisModel } from './productGrouper';
import { getAiProvider } from './aiProvider';
import { readProductBox } from './productBoxCache';
import type { NormBox } from './box';

/**
 * Sorts a batch of reference photos into named view slots (SIDE, SOLE, BACK…)
 * by asking Gemini which view each photo shows.
 *
 * Every photo always lands in a slot: the ones the model identified take the
 * slot it named, and the rest fill whatever slots are left, in upload order.
 * How each photo got there survives in `source`, so the strip can mark a
 * placement as recognised or as a fallback worth a glance — and any placement
 * is one drag away from being corrected.
 *
 * The caller is also told whether the classifier ran at all. A depleted quota
 * or a dead network degrades to upload order, which looks identical to a bad
 * classification unless the UI says otherwise.
 */

/**
 * Only applied when the model volunteers a confidence figure. The prompt does
 * not ask for one: pressing these image models for structured scores makes
 * them hedge, and a hedged score is thrown away, which is worse than the
 * plain answer they give reliably.
 */
export const CONFIDENCE_THRESHOLD = 0.6;

/**
 * The whole operation's ceiling. With retries removed this is now simply an
 * outer bound on the single request: upload order with a warning is a usable
 * outcome the user can fix with a drag; a spinner that never resolves is not,
 * and it blocks the upload behind it.
 */
export const MAPPING_BUDGET_MS = 60_000;

/**
 * Per-request ceiling for classification. Lower than the folder grouper's:
 * this asks for one short JSON array, so a request still running after this
 * long is not about to succeed.
 *
 * A ceiling is not a retry. When it fires the request is abandoned and the
 * strip falls back to upload order with a visible warning; nothing is sent
 * a second time.
 */
export const MAPPING_TIMEOUT_MS = 25_000;

/**
 * The same two ceilings for OpenAI, which is slower on this kind of request:
 * the configured analysis model is a reasoning model reading several
 * photographs, which takes considerably longer than a Gemini flash id, and the
 * Gemini figures abort it every time.
 *
 * Still bounded — a strip that never resolves blocks the upload behind it —
 * just bounded where this provider actually finishes. An aborted request is
 * billed for whatever it generated before the abort, so a ceiling set too
 * tight costs money and loses the answer.
 */
export const OPENAI_MAPPING_BUDGET_MS = 150_000;
export const OPENAI_MAPPING_TIMEOUT_MS = 90_000;

/** Whichever pair belongs to the provider currently selected. */
export const mappingBudgetMs = (): number =>
  getAiProvider() === 'openai' ? OPENAI_MAPPING_BUDGET_MS : MAPPING_BUDGET_MS;

export const mappingTimeoutMs = (): number =>
  getAiProvider() === 'openai' ? OPENAI_MAPPING_TIMEOUT_MS : MAPPING_TIMEOUT_MS;

export interface SlotAssignment {
  /** Slot this photo goes in, or null when there were more photos than slots. */
  slot: number | null;
  /** Whether the model picked this slot or the photo just filled a free one. */
  source: 'model' | 'fallback';
  /** 0–1, only when the model volunteered a figure. */
  confidence?: number;
  /**
   * Where the product sits in the photograph, when the model said. The render
   * path crops the photograph to it (`evidence.ts`) so the product fills the
   * frame the render model sees. Null when the model gave no usable box.
   */
  box?: NormBox | null;
  /**
   * What kind of product the photograph shows, when the model said. A folder
   * product takes the majority answer of its photographs as its category, so
   * a subfolder of shirts is a TOP without anyone setting it by hand.
   */
  category?: ProductCategory;
}

export type ProductCategory = 'FOOTWEAR' | 'TOP' | 'BOTTOMS' | 'OTHER';
const CATEGORIES: ReadonlySet<string> = new Set(['FOOTWEAR', 'TOP', 'BOTTOMS', 'OTHER']);

/**
 * The shape of the classifier's answer: one object per photograph. Kept as
 * documentation and for the OpenAI path's structured output; the Gemini
 * image model that answers analysis questions refuses response schemas, so
 * the Gemini request is prompt-driven and `toClaims` tolerates a bare list
 * of numbers as well.
 */
export const ANGLE_SLOT_SCHEMA: Record<string, unknown> = {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      image: { type: 'integer' },
      slot: { type: 'integer' },
      box: { type: 'array', items: { type: 'integer' } },
      category: { type: 'string', enum: ['FOOTWEAR', 'TOP', 'BOTTOMS', 'OTHER'] },
    },
    required: ['image', 'slot', 'box', 'category'],
    additionalProperties: false,
  },
};

/**
 * Why the views could not be named. Each one is a different thing to do about
 * it, which is the point of separating them: "the quota is spent" sent a user
 * looking at their billing when the real answer was a retired model id, and it
 * hid a depleted prepaid balance behind the same words as a one-minute rate
 * limit.
 */
export type MappingFailure =
  /** Prepaid credits at zero. Nothing works until the account is topped up. */
  | 'credits'
  /** 429 against an allowance: a per-minute limit, or the daily cap. */
  | 'quota'
  /** 503 / overloaded. Temporary, worth another attempt shortly. */
  | 'busy'
  /** 404 / unknown model id. The model list in the code needs changing. */
  | 'missing-model'
  /** 400. The request itself was refused — a bug here, not an account problem. */
  | 'invalid-request'
  /** No answer inside the ceiling. */
  | 'timeout'
  /** Network, proxy, or anything else that never reached a model. */
  | 'unreachable'
  /** A model answered, but not with a grouping this code can read. */
  | 'unreadable';

export interface MappingResult {
  assignments: SlotAssignment[];
  /** False when the classifier could not be reached or returned nothing usable. */
  classified: boolean;
  /** Why classification did not happen, for the UI to show. */
  reason?: MappingFailure;
  /**
   * The upstream message, trimmed, so the UI can show what the API actually
   * said instead of this code's guess about it.
   */
  detail?: string;
  /** HTTP status when one was reported. */
  status?: number;
}

const unplaced = (count: number): SlotAssignment[] =>
  Array.from({ length: count }, () => ({ slot: null, source: 'fallback' as const }));

/**
 * Drops photos into whatever slots are still free, in upload order. Used both
 * for the leftovers of a partial classification and for a request that failed
 * outright, so a batch upload always produces something usable.
 */
const fillFreeSlots = (
  assignments: SlotAssignment[],
  takenSlots: Set<number>,
  slotCount: number
): SlotAssignment[] => {
  assignments.forEach((assignment, i) => {
    if (assignment.slot !== null) return;

    for (let slot = 0; slot < slotCount; slot += 1) {
      if (takenSlots.has(slot)) continue;
      takenSlots.add(slot);
      assignments[i] = { slot, source: 'fallback' };
      return;
    }
  });

  return assignments;
};

/**
 * Pulls the first complete JSON array out of a reply, so code fences and any
 * stray prose around it are harmless.
 */
const extractJsonArray = (text: string): unknown[] | null => {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end <= start) return null;

  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

interface Claim {
  image: number;
  slot: number;
  confidence?: number;
}

/**
 * The prompt asks for one object per photograph — its slot and the box the
 * product occupies. A plain array of slot indices is tolerated too, which is
 * what these models answered before the schema existed. Anything out of
 * range is dropped rather than clamped — an invented index says nothing
 * about a photo. Boxes are read independently of the slot: a photograph the
 * model could not place in a view still has a product in it worth cropping to.
 */
const toClaims = (
  entries: unknown[],
  imageCount: number,
  slotCount: number
): { claims: Claim[]; boxes: (NormBox | null)[]; categories: (ProductCategory | undefined)[] } => {
  const claims: Claim[] = [];
  const boxes: (NormBox | null)[] = Array.from({ length: imageCount }, () => null);
  const categories: (ProductCategory | undefined)[] = Array.from({ length: imageCount }, () => undefined);

  entries.forEach((entry, position) => {
    let image = position;
    let slot: number | null = null;
    let confidence: number | undefined;

    if (typeof entry === 'number') {
      slot = entry;
    } else if (entry && typeof entry === 'object') {
      const record = entry as Record<string, unknown>;

      const declaredImage = Number(record.image);
      if (Number.isInteger(declaredImage)) image = declaredImage;

      const declaredSlot = Number(record.slot);
      if (Number.isInteger(declaredSlot)) slot = declaredSlot;

      const declaredConfidence = Number(record.confidence);
      if (Number.isFinite(declaredConfidence)) {
        // Tolerate a percentage where a fraction would be expected.
        const value = declaredConfidence > 1 ? declaredConfidence / 100 : declaredConfidence;
        confidence = Math.max(0, Math.min(1, value));
      }

      if (image >= 0 && image < imageCount && record.box !== undefined) {
        boxes[image] = readProductBox(record.box);
      }
      const category = String(record.category ?? '').trim().toUpperCase();
      if (image >= 0 && image < imageCount && CATEGORIES.has(category)) {
        categories[image] = category as ProductCategory;
      }
    }

    if (slot === null || !Number.isInteger(slot) || slot < 0 || slot >= slotCount) return;
    if (image < 0 || image >= imageCount) return;

    claims.push({ image, slot, confidence });
  });

  return { claims, boxes, categories };
};

/**
 * The category most of a product's photographs were read as, or undefined
 * when none was read. OTHER never outvotes a real category: a close-up the
 * model could not name says nothing against the three photographs it could.
 */
export const majorityCategory = (
  categories: (ProductCategory | undefined)[]
): ProductCategory | undefined => {
  const counts = new Map<ProductCategory, number>();
  categories.forEach((c) => {
    if (c) counts.set(c, (counts.get(c) ?? 0) + 1);
  });
  const named = [...counts.entries()].filter(([c]) => c !== 'OTHER').sort((a, b) => b[1] - a[1]);
  if (named.length) return named[0][0];
  return counts.has('OTHER') ? 'OTHER' : undefined;
};

/** The HTTP status the upstream reported, when it reported one. */
export const statusOf = (err: unknown): number | undefined => {
  const raw = (err as any)?.status ?? (err as any)?.code;
  if (typeof raw === 'number' && raw >= 100 && raw < 600) return raw;

  const match = /\b(400|401|403|404|408|429|500|503|504)\b/.exec(
    String((err as any)?.message ?? err)
  );
  return match ? Number(match[1]) : undefined;
};

/** The upstream's own words, trimmed to something a banner can hold. */
export const detailOf = (err: unknown): string | undefined => {
  const message = String((err as any)?.message ?? err).trim();
  if (!message || message === 'undefined') return undefined;
  return message.length > 300 ? `${message.slice(0, 300)}…` : message;
};

/**
 * What actually went wrong, read off the response rather than assumed.
 *
 * Order matters. A depleted prepaid balance and a spent daily quota both
 * arrive as 429 RESOURCE_EXHAUSTED, and they are different problems with
 * different fixes — one needs a payment, the other needs a wait — so the
 * balance is tested first, on the wording the API uses for it. A 503 is
 * checked before either, because an overloaded model sometimes reports
 * RESOURCE_EXHAUSTED too, and telling someone their credits are gone when the
 * model is merely busy sends them to a billing page for nothing.
 */
export const reasonFor = (err: unknown): MappingFailure => {
  const message = String((err as any)?.message ?? err).toLowerCase();
  const status = statusOf(err);

  if (message.includes('abort') || message.includes('timed out') || status === 408 || status === 504) {
    return 'timeout';
  }
  if (
    status === 503 ||
    message.includes('503') ||
    message.includes('unavailable') ||
    message.includes('overloaded') ||
    message.includes('high demand')
  ) {
    return 'busy';
  }
  if (message.includes('credit')) return 'credits';
  if (
    status === 429 ||
    message.includes('429') ||
    message.includes('resource_exhausted') ||
    message.includes('quota')
  ) {
    return 'quota';
  }
  if (
    status === 404 ||
    message.includes('404') ||
    message.includes('not_found') ||
    message.includes('not found') ||
    message.includes('unknown name') ||
    message.includes('does not exist') ||
    message.includes('unsupported')
  ) {
    return 'missing-model';
  }
  if (
    status === 400 ||
    status === 401 ||
    status === 403 ||
    message.includes('400') ||
    message.includes('invalid_argument') ||
    message.includes('invalid argument') ||
    message.includes('permission')
  ) {
    return 'invalid-request';
  }
  return 'unreachable';
};

export async function mapAnglesToSlots(
  images: string[],
  slots: string[]
): Promise<MappingResult> {
  if (!images.length) return { assignments: [], classified: true };

  /**
   * Every photo still lands in a slot, because the tiles have to appear
   * somewhere — but `classified: false` travels with them, every placement is
   * marked `fallback`, and the caller withholds those slot names from the
   * renderer. Upload order is never presented as an answer about the views.
   */
  const giveUp = (reason: MappingFailure, err?: unknown): MappingResult => ({
    assignments: fillFreeSlots(unplaced(images.length), new Set<number>(), slots.length),
    classified: false,
    reason,
    detail: err === undefined ? undefined : detailOf(err),
    status: err === undefined ? undefined : statusOf(err),
  });

  const startedAt = Date.now();
  const remainingBudget = () => mappingBudgetMs() - (Date.now() - startedAt);

  const classifyOnce = async (): Promise<MappingResult> => {
    const ai = new GoogleGenAI({
      apiKey: 'proxied',
      httpOptions: { baseUrl: `${window.location.origin}/api/gemini` },
    });

    const parts: any[] = images.map((data) => ({
      inlineData: { mimeType: 'image/jpeg', data },
    }));

    parts.push({
      text:
        `You are sorting reference photographs of ONE single product into fixed view slots.\n` +
        `Slots, in order: ${slots.map((s, i) => `${i}=${s}`).join(', ')}.\n` +
        `There are ${images.length} images, indexed 0 to ${images.length - 1} in the order given.\n` +
        `For each image choose the slot index whose name best describes the camera view of that photo. ` +
        `Use each slot at most once. If nothing fits, use -1.\n` +
        `Also give the bounding box of the PRODUCT ITSELF in each image — the item alone, not the table, ` +
        `box, hand or backdrop around it — as [ymin, xmin, ymax, xmax] in 0-1000 coordinates, (0,0) top-left.\n` +
        `Also say what kind of product each image shows: FOOTWEAR (shoes, sneakers, boots, sandals), ` +
        `TOP (shirt, t-shirt, jacket, hoodie, sweater), BOTTOMS (trousers, jeans, shorts, joggers) or OTHER.\n` +
        `Reply with ONLY a JSON array, one object per image, in image order: ` +
        `[{"image":0,"slot":0,"box":[120,80,900,940],"category":"FOOTWEAR"},{"image":1,"slot":2,"box":[100,60,880,950],"category":"FOOTWEAR"}]. ` +
        `No prose, no code fences.`,
    });

    // ONE request, to the ONE model the selected provider maps to. There is
    // no list to walk and no second attempt behind this call.
    //
    // No response schema: the configured Gemini analysis id is an IMAGE
    // model, and it answers `responseSchema` with 400 INVALID_ARGUMENT
    // (verified live, Sept 2026). The prompt's example line and `toClaims`'
    // tolerance are what keep the object reply readable.
    const res: any = await askAnalysisModel(
      ai,
      parts,
      Math.max(1000, Math.min(mappingTimeoutMs(), remainingBudget())),
      { temperature: 0 }
    );

    const text = (res.candidates?.[0]?.content?.parts ?? [])
      .map((p: any) => p.text ?? '')
      .join('');

    const entries = extractJsonArray(text);
    if (!entries) {
      console.warn('[Angle mapper] a model answered, but not with a grouping:', text.slice(0, 300));
      return giveUp('unreadable');
    }

    const takenSlots = new Set<number>();
    const result = unplaced(images.length);
    const { claims, boxes, categories } = toClaims(entries, images.length, slots.length);

    // Stable sort, so with no confidence figures the model's own image order
    // decides ties — the behaviour this classifier has always had.
    claims
      .filter((claim) => claim.confidence === undefined || claim.confidence >= CONFIDENCE_THRESHOLD)
      .sort((a, b) => (b.confidence ?? 1) - (a.confidence ?? 1))
      .forEach((claim) => {
        if (takenSlots.has(claim.slot)) return;
        if (result[claim.image].slot !== null) return;

        takenSlots.add(claim.slot);
        result[claim.image] = { slot: claim.slot, source: 'model', confidence: claim.confidence };
      });

    // Nothing at all was recognised — treat it as a failed classification so
    // the UI can say so, rather than silently presenting upload order.
    const recognised = result.some((r) => r.source === 'model');
    if (!recognised) {
      console.warn('[Angle mapper] the reply named no slot this code could use:', text.slice(0, 300));
      return giveUp('unreadable');
    }

    return {
      assignments: fillFreeSlots(result, takenSlots, slots.length).map((assignment, i) => ({
        ...assignment,
        box: boxes[i],
        category: categories[i],
      })),
      classified: true,
    };
  };

  // ONE attempt. No retry, no second model, no backoff ladder.
  //
  // What used to be here was three attempts across a two-id model walk — up to
  // six billed analysis calls for one drag-and-drop of a few photographs, none
  // of them visible to the user. A classification that fails now degrades to
  // upload order immediately, `classified: false` travels with it, and the
  // strip says so; the user can re-run it deliberately if they want to.
  try {
    return await classifyOnce();
  } catch (err) {
    // Everything needed to tell an account problem from a code problem,
    // without opening the network tab: which id was used, what the upstream
    // answered, and how this code classified it.
    console.warn(
      `[Angle mapper] classification failed — ` +
        `model: ${(err as any)?.aiModel ?? 'unknown'} · ` +
        `status: ${statusOf(err) ?? 'none reported'} · ` +
        `classified as: ${reasonFor(err)} · NOT retried (one attempt by design)`,
      err
    );
    return giveUp(reasonFor(err), err);
  }
}
