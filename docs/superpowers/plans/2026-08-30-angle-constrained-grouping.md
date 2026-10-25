# Angle-Constrained Product Grouping Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the contact-sheet grouping pipeline with an angle-constrained one: angle labels give free cannot-link edges, SigLIP proposes candidates, a per-anchor identity question creates the only links, and a wave scheduler keeps the run under $0.20 and under 2 minutes.

**Architecture:** Three parallel tracks (angle pass on raw thumbs; crop+embed locally), joined into stratified candidate pools, resolved by disjoint waves of anchor-vs-candidates requests, clustered by a constrained union-find that can never violate the one-photo-per-angle invariant.

**Tech Stack:** TypeScript, React 19, Vite 6, Vitest 3, @google/genai (proxied), @huggingface/transformers (SigLIP, local).

**Spec:** `docs/superpowers/specs/2026-08-30-angle-constrained-product-grouping-design.md` — read it before starting any task. Every design decision below is argued there; this plan states only *how*.

## Global Constraints

- Cannot-link is absolute: no group may ever hold two photographs labelled the same angle (FRONT, BACK, LEFT, RIGHT, TOP, SOLE). CLOSEUP and OTHER carry no cannot-link.
- Only a `same:true, sure:true` model answer creates a link. Cosine similarity NEVER merges anything.
- No forced assignment; insufficient evidence → Unresolved, never a guess.
- The floor NEVER removes a candidate from a pool. It only orders priority and gates the Confirmed-Alone label.
- Budget: $0.20 per folder measured in money; 90-request fuse as backstop. Checked BEFORE each request.
- Runtime: parallel tracks, wave-issued requests, worker-thread cropping. Nothing serial that can be concurrent.
- Determinism: same photos + same model answers ⇒ same request sequence, same groups. Every ordering ends in a folder-order tie-break.
- Free text (`because`, `category`, `colour`) is inert: displayed, never read by a decision.
- `npm run lint` (tsc --noEmit) and `npm test` (vitest run) must pass at every commit.
- Windows dev box: run commands through PowerShell or Git Bash as the harness provides; paths in code always forward-slash.
- Existing v1/v2 pipelines stay working until v3 beats them on a real folder. Nothing in this plan deletes them.

---

### Task 1: Extract shared model types and the analysis client

The new pipeline must not import from the 2,507-line `productGrouper.ts` (v1). Move the shared types/helpers out; `productGrouper.ts` re-exports them so v1/v2 and the UI keep compiling unchanged.

**Files:**
- Create: `services/productModel.ts`
- Create: `services/analysisClient.ts`
- Modify: `services/productGrouper.ts` (delete moved code, add re-exports at top)
- Test: existing suite must stay green — this task adds no new tests.

**Interfaces:**
- Consumes: nothing new.
- Produces (in `productModel.ts`): `FolderImage`, `GroupedImage`, `ProductGroup`, `GroupingResult`, `GroupingProgress`, `Category`, `CATEGORIES`, `ViewName`, `VIEW_NAMES`, `REVIEW_CONFIDENCE`, `ImageAttributes`, `ProductFingerprint`, `groupLabel(i: number): string`, `renumber(groups: ProductGroup[]): ProductGroup[]`, `summarise(group: ProductGroup): ProductGroup`, `moveImage`, `mergeGroups`, `splitGroup` — signatures byte-identical to what `productGrouper.ts` exports today.
- Produces (in `analysisClient.ts`): `askAnalysisModel(ai, parts, ms?, options?): Promise<any>`, `analysisModel(): string`, `ANALYSIS_MODEL`, `isModelUnavailable(err): boolean`, `isRateLimited(err): boolean`, `analysisTimeoutMs(): number`, plus the private `withTimeout` helper it needs.
- Produces (in `productModel.ts`, NEW addition): the `joinedVia` field on `GroupedImage` and two new optional fields on `GroupingResult`:

```ts
export interface GroupedImage {
  imageId: string;
  view: ViewName;
  viewSource: 'model' | 'fallback';
  colour?: string;
  attributes?: ImageAttributes;
  reason?: string;
  /** How this photograph came to be in its group. v3 only. */
  joinedVia?: {
    to: string;                    // imageId it attached to
    kind: 'direct' | 'indirect';
    because?: string;              // present only when kind === 'direct'
    hops?: number;                 // chain length when indirect
  };
}

export interface GroupingResult {
  groups: ProductGroup[];
  unassigned: string[];
  classified: boolean;
  error?: string;
  stopped?: boolean;
  log?: string[];
  /** v3: why each unassigned photograph is in the tray. Keyed by imageId. */
  uncertainReasons?: Record<string, string>;
  /** v3: estimated AI spend for the run, in USD. Null when rates are unconfigured. */
  spendUsd?: number | null;
}
```

- `GroupingProgress.phase` union: add `'angles'` to the existing members.

- [ ] **Step 1: Locate the exact block boundaries.** In `services/productGrouper.ts`, find every export listed under Produces above (grep each name). They live roughly between the imports and the first request-making function. Note line ranges.

- [ ] **Step 2: Create `services/productModel.ts`.** Cut (not copy) the located type/helper definitions into it, keeping their doc comments intact. Add the `joinedVia` field, the two `GroupingResult` fields, and the `'angles'` phase exactly as shown above. `productModel.ts` must import nothing from `productGrouper.ts` and nothing that touches the network.

- [ ] **Step 3: Create `services/analysisClient.ts`.** Cut `askAnalysisModel`, `analysisModel`, `ANALYSIS_MODEL`, `isModelUnavailable`, `isRateLimited`, `analysisTimeoutMs`, `withTimeout` into it. Its imports come from `./aiProvider` and `./aiModels` only.

- [ ] **Step 4: Re-export from `productGrouper.ts`.** At the top of the file:

```ts
export * from './productModel';
export {
  askAnalysisModel, analysisModel, ANALYSIS_MODEL,
  isModelUnavailable, isRateLimited, analysisTimeoutMs,
} from './analysisClient';
```

Remove any now-duplicate local definitions. Internal uses inside `productGrouper.ts` switch to the imported names (add a matching `import` line).

- [ ] **Step 5: Verify nothing broke.**

Run: `npm run lint` — Expected: clean.
Run: `npm test` — Expected: same pass count as before the task (run once before starting to record it).

- [ ] **Step 6: Commit**

```bash
git add services/productModel.ts services/analysisClient.ts services/productGrouper.ts
git commit -m "refactor: extract shared grouping types and analysis client from productGrouper"
```

---

### Task 2: JSON reply readers

Small shared module so the new pipeline does not import parsers from the retiring `visualJudge.ts`.

**Files:**
- Create: `services/jsonReply.ts`
- Test: `services/jsonReply.test.ts`

**Interfaces:**
- Produces: `extractJsonArray(text: string): unknown[] | null`, `extractJsonObject(text: string): Record<string, unknown> | null`.
- Behaviour: find the first complete JSON array/object in a reply that may contain prose or code fences; return null on anything unparseable. Escape-aware, string-aware bracket matching — copy the proven implementations of `extractArray` / `extractObject` from `services/visualJudge.ts` verbatim, renamed.

- [ ] **Step 1: Write the failing tests**

```ts
// services/jsonReply.test.ts
import { describe, expect, it } from 'vitest';
import { extractJsonArray, extractJsonObject } from './jsonReply';

describe('extractJsonArray', () => {
  it('reads a bare array', () => {
    expect(extractJsonArray('[{"a":1}]')).toEqual([{ a: 1 }]);
  });
  it('reads an array wrapped in prose and fences', () => {
    const text = 'Here you go:\n```json\n[{"photo":0,"same":true}]\n```\nDone.';
    expect(extractJsonArray(text)).toEqual([{ photo: 0, same: true }]);
  });
  it('survives brackets inside strings', () => {
    expect(extractJsonArray('[{"because":"a ] tricky [ one"}]')).toEqual([
      { because: 'a ] tricky [ one' },
    ]);
  });
  it('returns null for truncated JSON rather than guessing', () => {
    expect(extractJsonArray('[{"a":1}')).toBeNull();
  });
  it('returns null when there is no array', () => {
    expect(extractJsonArray('no json here')).toBeNull();
  });
});

describe('extractJsonObject', () => {
  it('reads an object out of prose', () => {
    expect(extractJsonObject('answer: {"same":false,"sure":true}')).toEqual({
      same: false,
      sure: true,
    });
  });
  it('rejects an array as not-an-object', () => {
    expect(extractJsonObject('[1,2]')).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run services/jsonReply.test.ts`
Expected: FAIL — cannot resolve `./jsonReply`.

- [ ] **Step 3: Implement.** Create `services/jsonReply.ts` by copying the bodies of `extractArray` and `extractObject` from `services/visualJudge.ts` (lines ~300–424), renaming to `extractJsonArray` / `extractJsonObject`. Keep the escape/string state machine exactly as-is; it is tested and correct.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run services/jsonReply.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add services/jsonReply.ts services/jsonReply.test.ts
git commit -m "feat: shared JSON reply readers for the v3 pipeline"
```

---

### Task 3: Cost meter and usage passthrough

Money-measured budget gate (spec §11). Gemini responses already reach the browser byte-for-byte (`server.js` pipes the body), so `usageMetadata` is available on the SDK response object. The OpenAI adapter currently discards usage when reshaping — fix that here too.

**Files:**
- Create: `services/costMeter.ts`
- Modify: `services/aiProvider.ts` (`toGeminiShape` + its call site, ~lines 144–146 and 261)
- Test: `services/costMeter.test.ts`

**Interfaces:**
- Produces:

```ts
export const BUDGET_USD = 0.2;
export const REQUEST_FUSE = 90;

/** USD per million tokens. null = rate not yet confirmed from the dashboard. */
export interface ModelRate { inPerMTok: number; outPerMTok: number }
export const RATES: Record<string, ModelRate | null>;

export interface Usage { model: string; inputTokens: number; outputTokens: number }

/** Reads usage off a response in Gemini shape. Null when absent. */
export const usageOf = (model: string, res: any): Usage | null;

export class CostMeter {
  constructor(ceilingUsd?: number, fuse?: number);
  /** True while another request may be issued. Check BEFORE sending. */
  canSpend(): boolean;
  /** Why canSpend() is false, for the run log. Null while spending is allowed. */
  blockedBy(): 'budget' | 'fuse' | null;
  /** Count a request as issued. Call exactly once per request, before it. */
  charge(): void;
  /** Record what a response actually cost. */
  record(usage: Usage | null): void;
  requests(): number;
  /** Estimated spend so far. Null when any used model has no configured rate. */
  spentUsd(): number | null;
  /** One line for the run log. */
  summary(): string;
}
```

- Consumes: nothing from earlier tasks.
- `RATES` starts as `{ 'gemini-3.1-flash-lite-image': null, 'gemini-3.1-flash-image': null, 'gemini-3-pro-image': null }` with a comment: **fill from the provider dashboard; do not guess.** While any used model's rate is null, `spentUsd()` returns null and the meter guards with the request fuse alone — and `summary()` says so out loud.

- [ ] **Step 1: Write the failing tests**

```ts
// services/costMeter.test.ts
import { describe, expect, it } from 'vitest';
import { BUDGET_USD, CostMeter, RATES, usageOf } from './costMeter';

const RATED = 'test-model';
(RATES as any)[RATED] = { inPerMTok: 0.1, outPerMTok: 0.4 };

describe('usageOf', () => {
  it('reads Gemini usageMetadata', () => {
    const res = { usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 50 } };
    expect(usageOf('m', res)).toEqual({ model: 'm', inputTokens: 1000, outputTokens: 50 });
  });
  it('returns null when the response carries no usage', () => {
    expect(usageOf('m', { candidates: [] })).toBeNull();
  });
});

describe('CostMeter', () => {
  it('accumulates money from recorded usage', () => {
    const meter = new CostMeter();
    meter.charge();
    meter.record({ model: RATED, inputTokens: 2_000_000, outputTokens: 1_000_000 });
    expect(meter.spentUsd()).toBeCloseTo(0.1 * 2 + 0.4 * 1, 10);
  });
  it('blocks at the budget ceiling, before the request', () => {
    const meter = new CostMeter(0.5, 1000);
    meter.charge();
    meter.record({ model: RATED, inputTokens: 6_000_000, outputTokens: 0 }); // $0.60
    expect(meter.canSpend()).toBe(false);
    expect(meter.blockedBy()).toBe('budget');
  });
  it('falls back to the request fuse when a model has no rate', () => {
    const meter = new CostMeter(BUDGET_USD, 3);
    meter.charge();
    meter.record({ model: 'gemini-3.1-flash-lite-image', inputTokens: 9e9, outputTokens: 9e9 });
    expect(meter.spentUsd()).toBeNull();       // rate unconfigured
    expect(meter.canSpend()).toBe(true);        // money gate cannot fire...
    meter.charge();
    meter.charge();
    expect(meter.canSpend()).toBe(false);       // ...but the fuse does
    expect(meter.blockedBy()).toBe('fuse');
  });
  it('counts a request even when its response never arrives', () => {
    const meter = new CostMeter(BUDGET_USD, 2);
    meter.charge();
    meter.charge();
    expect(meter.requests()).toBe(2);
    expect(meter.canSpend()).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run services/costMeter.test.ts`
Expected: FAIL — cannot resolve `./costMeter`.

- [ ] **Step 3: Implement `services/costMeter.ts`**

```ts
export const BUDGET_USD = 0.2;
export const REQUEST_FUSE = 90;

export interface ModelRate { inPerMTok: number; outPerMTok: number }

/**
 * USD per million tokens, per model id. FILL FROM THE PROVIDER DASHBOARD.
 * null means "not confirmed": the meter then guards with the request fuse
 * alone and says so in its summary. Never guess a rate — a wrong rate is a
 * budget gate that silently lies in one direction or the other.
 */
export const RATES: Record<string, ModelRate | null> = {
  'gemini-3.1-flash-lite-image': null,
  'gemini-3.1-flash-image': null,
  'gemini-3-pro-image': null,
};

export interface Usage { model: string; inputTokens: number; outputTokens: number }

export const usageOf = (model: string, res: any): Usage | null => {
  const meta = res?.usageMetadata;
  const input = Number(meta?.promptTokenCount);
  const output = Number(meta?.candidatesTokenCount);
  if (!Number.isFinite(input) || !Number.isFinite(output)) return null;
  return { model, inputTokens: input, outputTokens: output };
};

export class CostMeter {
  private ceiling: number;
  private fuse: number;
  private issued = 0;
  private usages: Usage[] = [];
  private unrated = false;

  constructor(ceilingUsd: number = BUDGET_USD, fuse: number = REQUEST_FUSE) {
    this.ceiling = ceilingUsd;
    this.fuse = fuse;
  }

  charge(): void { this.issued += 1; }

  record(usage: Usage | null): void {
    if (!usage) { this.unrated = true; return; }
    if (!RATES[usage.model]) this.unrated = true;
    this.usages.push(usage);
  }

  requests(): number { return this.issued; }

  spentUsd(): number | null {
    if (this.unrated) return null;
    let usd = 0;
    for (const u of this.usages) {
      const rate = RATES[u.model];
      if (!rate) return null;
      usd += (u.inputTokens / 1e6) * rate.inPerMTok + (u.outputTokens / 1e6) * rate.outPerMTok;
    }
    return usd;
  }

  blockedBy(): 'budget' | 'fuse' | null {
    if (this.issued >= this.fuse) return 'fuse';
    const spent = this.spentUsd();
    if (spent !== null && spent >= this.ceiling) return 'budget';
    return null;
  }

  canSpend(): boolean { return this.blockedBy() === null; }

  summary(): string {
    const spent = this.spentUsd();
    const money = spent === null
      ? 'spend not measurable (model rates unconfigured; guarded by request fuse)'
      : `~$${spent.toFixed(4)} of $${this.ceiling.toFixed(2)}`;
    return `${this.issued} request(s), ${money}.`;
  }
}
```

- [ ] **Step 4: Carry OpenAI usage through the adapter.** In `services/aiProvider.ts`, change `toGeminiShape` and its call site:

```ts
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
```

and at the return in `askOpenAiAnalysis`:

```ts
return toGeminiShape(json?.choices?.[0]?.message?.content ?? '', json?.usage);
```

- [ ] **Step 5: Run the full suite**

Run: `npx vitest run services/costMeter.test.ts` — Expected: PASS.
Run: `npm run lint` — Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add services/costMeter.ts services/costMeter.test.ts services/aiProvider.ts
git commit -m "feat: money-measured cost meter with request fuse; carry OpenAI usage through the adapter"
```

---

### Task 4: Angle atlas

Track A of the pipeline (spec §4, §8.1): one cheap pass labels every photograph's angle, category and colour. Angles feed cannot-link; category/colour are inert labels.

**Files:**
- Create: `services/angleAtlas.ts`
- Test: `services/angleAtlas.test.ts`

**Interfaces:**
- Consumes: `extractJsonArray` from Task 2 (at the orchestrator level — this module itself is pure).
- Produces:

```ts
export const ANGLE_SHEET_SIZE = 15;
export const CANNOT_LINK_ANGLES: ReadonlySet<string>; // FRONT BACK LEFT RIGHT TOP SOLE

export interface AngleReading {
  photo: number;
  angle?: string;      // uppercased; undefined when unreadable — NEVER defaulted
  category?: string;
  colour?: string;
}

export const anglePrompt = (count: number): string;
export const ANGLE_SCHEMA: Record<string, unknown>;
export const readAngles = (entries: unknown[], count: number): AngleReading[];

/** The cannot-link bucket, or null for CLOSEUP/OTHER/unknown. */
export const bucketOf = (angle: string | undefined): string | null;

/** True when two photographs are proven different products by their angles. */
export const cannotLink = (a: string | undefined, b: string | undefined): boolean;

/** Splits folder indices into sheets of ANGLE_SHEET_SIZE, folder order. */
export const angleSheets = (count: number): number[][];
```

- [ ] **Step 1: Write the failing tests**

```ts
// services/angleAtlas.test.ts
import { describe, expect, it } from 'vitest';
import {
  ANGLE_SHEET_SIZE, CANNOT_LINK_ANGLES, angleSheets, anglePrompt,
  bucketOf, cannotLink, readAngles,
} from './angleAtlas';

describe('bucketOf / cannotLink', () => {
  it('names the six unique angles as buckets', () => {
    for (const a of ['FRONT', 'BACK', 'LEFT', 'RIGHT', 'TOP', 'SOLE']) {
      expect(bucketOf(a)).toBe(a);
    }
  });
  it('gives CLOSEUP, OTHER and unknown no bucket', () => {
    expect(bucketOf('CLOSEUP')).toBeNull();
    expect(bucketOf('OTHER')).toBeNull();
    expect(bucketOf(undefined)).toBeNull();
  });
  it('cannot-links two FRONTs and nothing else', () => {
    expect(cannotLink('FRONT', 'FRONT')).toBe(true);
    expect(cannotLink('FRONT', 'BACK')).toBe(false);
    expect(cannotLink('CLOSEUP', 'CLOSEUP')).toBe(false);
    expect(cannotLink(undefined, 'FRONT')).toBe(false);
  });
});

describe('readAngles', () => {
  it('reads a well-formed entry', () => {
    const [r] = readAngles(
      [{ photo: 0, angle: 'left', category: 'FOOTWEAR', colour: 'grey black' }], 5
    );
    expect(r).toEqual({ photo: 0, angle: 'LEFT', category: 'FOOTWEAR', colour: 'grey black' });
  });
  it('drops out-of-range and duplicate photo numbers rather than defaulting', () => {
    const rs = readAngles(
      [{ photo: 9, angle: 'LEFT' }, { photo: 1, angle: 'TOP' }, { photo: 1, angle: 'BACK' }], 3
    );
    expect(rs).toEqual([{ photo: 1, angle: 'TOP', category: undefined, colour: undefined }]);
  });
  it('keeps a photo whose angle is garbage, with angle undefined', () => {
    const [r] = readAngles([{ photo: 0, angle: 'SIDEWAYS-ISH' }], 1);
    expect(r.photo).toBe(0);
    expect(r.angle).toBeUndefined();
  });
  it('drops non-object entries', () => {
    expect(readAngles(['x', null, 42], 3)).toEqual([]);
  });
});

describe('angleSheets', () => {
  it('splits 110 into 8 sheets in folder order', () => {
    const sheets = angleSheets(110);
    expect(sheets.length).toBe(Math.ceil(110 / ANGLE_SHEET_SIZE));
    expect(sheets[0][0]).toBe(0);
    expect(sheets.flat()).toEqual([...Array(110).keys()]);
  });
});

describe('anglePrompt', () => {
  it('forbids comparing photographs to each other', () => {
    expect(anglePrompt(15)).toMatch(/DO NOT COMPARE THE PHOTOGRAPHS/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run services/angleAtlas.test.ts`
Expected: FAIL — cannot resolve `./angleAtlas`.

- [ ] **Step 3: Implement `services/angleAtlas.ts`**

```ts
export const ANGLE_SHEET_SIZE = 15;

export const CANNOT_LINK_ANGLES: ReadonlySet<string> = new Set([
  'FRONT', 'BACK', 'LEFT', 'RIGHT', 'TOP', 'SOLE',
]);

const KNOWN_ANGLES = new Set([...CANNOT_LINK_ANGLES, 'CLOSEUP', 'OTHER']);

export interface AngleReading {
  photo: number;
  angle?: string;
  category?: string;
  colour?: string;
}

export const bucketOf = (angle: string | undefined): string | null =>
  angle && CANNOT_LINK_ANGLES.has(angle) ? angle : null;

export const cannotLink = (a: string | undefined, b: string | undefined): boolean => {
  const ba = bucketOf(a);
  return ba !== null && ba === bucketOf(b);
};

export const angleSheets = (count: number): number[][] => {
  const sheets: number[][] = [];
  for (let start = 0; start < count; start += ANGLE_SHEET_SIZE) {
    sheets.push(Array.from(
      { length: Math.min(ANGLE_SHEET_SIZE, count - start) },
      (_, i) => start + i
    ));
  }
  return sheets;
};

export const ANGLE_SCHEMA: Record<string, unknown> = {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      photo: { type: 'integer' },
      angle: {
        type: 'string',
        enum: ['FRONT', 'BACK', 'LEFT', 'RIGHT', 'TOP', 'SOLE', 'CLOSEUP', 'OTHER'],
      },
      category: { type: 'string', enum: ['FOOTWEAR', 'TOP', 'BOTTOMS', 'OTHER'] },
      colour: { type: 'string' },
    },
    required: ['photo', 'angle', 'category', 'colour'],
    additionalProperties: false,
  },
};

export const anglePrompt = (count: number): string =>
  `This is ONE image containing ${count} product photographs in a grid. Each photograph's NUMBER is printed in the black band beneath it, 0 to ${count - 1}.

For each photograph, say which side of the item you are looking at.
Answer from the ITEM's own orientation, not the camera's: the BACK is the heel end whichever way the item points in the frame.

FRONT, BACK, LEFT, RIGHT, TOP (from above), SOLE (the underside).
CLOSEUP when part of the item fills the frame. OTHER when none fits.

Also give the item's category (FOOTWEAR, TOP, BOTTOMS or OTHER) and its colourway in two or three words.

DO NOT COMPARE THE PHOTOGRAPHS TO EACH OTHER. Do not say which show the same item. That is not what is being asked here.

Reply with ONLY a JSON array:
[{"photo":0,"angle":"LEFT","category":"FOOTWEAR","colour":"grey black"}]
No prose, no code fences.`;

/**
 * A skipped, out-of-range or duplicate photo number is DROPPED, never
 * defaulted: a defaulted angle would be an invented cannot-link, and an
 * invented cannot-link permanently bars a real merge. A photo that survives
 * with a garbage angle keeps angle undefined — it simply gets no free guard.
 */
export const readAngles = (entries: unknown[], count: number): AngleReading[] => {
  const readings: AngleReading[] = [];
  const claimed = new Set<number>();

  entries.forEach((entry) => {
    if (!entry || typeof entry !== 'object') return;
    const record = entry as Record<string, unknown>;

    const photo = Number(record.photo);
    if (!Number.isInteger(photo) || photo < 0 || photo >= count || claimed.has(photo)) return;
    claimed.add(photo);

    const text = (v: unknown): string | undefined =>
      typeof v === 'string' && v.trim() ? v.trim() : undefined;

    const rawAngle = text(record.angle)?.toUpperCase();
    readings.push({
      photo,
      angle: rawAngle && KNOWN_ANGLES.has(rawAngle) ? rawAngle : undefined,
      category: text(record.category)?.toUpperCase(),
      colour: text(record.colour)?.toLowerCase(),
    });
  });

  return readings;
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run services/angleAtlas.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add services/angleAtlas.ts services/angleAtlas.test.ts
git commit -m "feat: angle atlas - single-purpose angle pass with cannot-link buckets"
```

---

### Task 5: Candidate pools with stratification and angle-pair floors

Spec §6 in full, including the heel-tab crowding case. THE FLOOR NEVER PRUNES.

**Files:**
- Create: `services/candidatePool.ts`
- Test: `services/candidatePool.test.ts`

**Interfaces:**
- Consumes: `bucketOf`, `cannotLink` from Task 4.
- Produces:

```ts
export const POOL_SIZE = 6;
export const FLOOR_PERCENTILE = 75;
export const MIN_FLOOR_SAMPLES = 30;

export const cosine = (a: Float32Array, b: Float32Array): number;
export const pairKey = (a: number, b: number): string;      // "3,17", smaller first

export interface Pool {
  anchor: number;
  /** Candidate indices, strongest first. */
  candidates: number[];
  /** True when eligible cross-angle neighbours were cut off by POOL_SIZE. */
  truncated: boolean;
}

/** floor per unordered bucket pair; key "BACK|FRONT" (alphabetical). */
export const pairFloors = (
  vectors: (Float32Array | null)[],
  angles: (string | undefined)[],
): Map<string, number>;

export const floorKey = (bucketA: string, bucketB: string): string;

/** The floor for a concrete pair of photographs, or null (no floor). */
export const floorOf = (
  floors: Map<string, number>,
  angleA: string | undefined,
  angleB: string | undefined,
): number | null;

/** cosine minus floor; raw cosine when the floor is null. For PRIORITY ONLY. */
export const marginOf = (cos: number, floor: number | null): number;

export const buildPools = (
  vectors: (Float32Array | null)[],
  angles: (string | undefined)[],
  notSame: ReadonlySet<string>,          // pairKeys already ruled out
  k?: number,
): Pool[];
```

- [ ] **Step 1: Write the failing tests** — including the heel-tab regression, parts (1) and (2) of the spec's §15 test.

```ts
// services/candidatePool.test.ts
import { describe, expect, it } from 'vitest';
import {
  FLOOR_PERCENTILE, MIN_FLOOR_SAMPLES, POOL_SIZE,
  buildPools, cosine, floorKey, floorOf, marginOf, pairFloors, pairKey,
} from './candidatePool';

/** Unit vector helpers for readable geometry. */
const v = (...xs: number[]) => Float32Array.from(xs);

describe('cosine / pairKey', () => {
  it('computes cosine on direction, ignoring magnitude', () => {
    expect(cosine(v(2, 0), v(5, 0))).toBeCloseTo(1);
    expect(cosine(v(1, 0), v(0, 1))).toBeCloseTo(0);
  });
  it('orders pairKey smaller-first', () => {
    expect(pairKey(17, 3)).toBe('3,17');
  });
});

describe('THE HEEL-TAB REGRESSION (spec section 6)', () => {
  // Geometry engineered so that:
  //   cosine(A-FRONT, B-FRONT) = ~0.95   different products, same angle
  //   cosine(A-FRONT, A-LEFT)  = ~0.62   same product, different angle
  //   plus a crowd of BACK views scoring between the two.
  const aFront = v(1, 0, 0);
  const bFront = v(0.95, Math.sqrt(1 - 0.95 ** 2), 0);          // 0.95 to aFront
  const aLeft  = v(0.62, 0, Math.sqrt(1 - 0.62 ** 2));          // 0.62 to aFront
  const crowd = Array.from({ length: 8 }, (_, i) => {
    const c = 0.8 - i * 0.01;                                    // 0.80 .. 0.73
    return v(c, Math.sqrt(1 - c * c) * 0.1, Math.sqrt(1 - c * c) * 0.99);
  });
  const vectors = [aFront, bFront, aLeft, ...crowd];
  const angles  = ['FRONT', 'FRONT', 'LEFT', ...crowd.map(() => 'BACK')];

  it('(1) the same-angle distractor NEVER enters the pool, however similar', () => {
    const pools = buildPools(vectors, angles, new Set());
    const pool = pools.find((p) => p.anchor === 0)!;
    expect(pool.candidates).not.toContain(1); // B-FRONT: 0.95 cosine, excluded
  });

  it('(2) stratification holds the true cross-angle match against the crowd', () => {
    const pools = buildPools(vectors, angles, new Set());
    const pool = pools.find((p) => p.anchor === 0)!;
    // Global top-6 by cosine would be six BACKs (0.80..0.75) — A-LEFT at 0.62
    // would be crowded out. The reserved LEFT slot must keep it.
    expect(pool.candidates).toContain(2);
  });
});

describe('buildPools mechanics', () => {
  it('excludes recorded NOT-SAME pairs', () => {
    const vectors = [v(1, 0), v(0.9, 0.1), v(0.8, 0.2)];
    const angles = ['FRONT', 'BACK', 'LEFT'];
    const pools = buildPools(vectors, angles, new Set([pairKey(0, 1)]));
    expect(pools.find((p) => p.anchor === 0)!.candidates).not.toContain(1);
  });
  it('marks truncation only when eligible neighbours were cut off', () => {
    const many = Array.from({ length: 10 }, (_, i) => v(1, i * 0.01));
    const angles = ['FRONT', ...Array.from({ length: 9 }, () => 'BACK')];
    const pools = buildPools(many, angles, new Set());
    const pool = pools.find((p) => p.anchor === 0)!;
    expect(pool.candidates.length).toBe(POOL_SIZE);
    expect(pool.truncated).toBe(true);
  });
  it('a photograph without a vector gets an empty, untruncated pool', () => {
    const pools = buildPools([null, v(1, 0)], ['FRONT', 'BACK'], new Set());
    expect(pools.find((p) => p.anchor === 0)!).toEqual({
      anchor: 0, candidates: [], truncated: false,
    });
  });
  it('is deterministic: equal cosines break on folder order', () => {
    const vectors = [v(1, 0), v(0.9, 0.435889894354), v(0.9, 0.435889894354)];
    const angles = ['FRONT', 'BACK', 'BACK'];
    const a = buildPools(vectors, angles, new Set());
    const b = buildPools(vectors, angles, new Set());
    expect(a).toEqual(b);
    expect(a.find((p) => p.anchor === 0)!.candidates).toEqual([1, 2]);
  });
});

describe('angle-pair floors', () => {
  it('computes per-pair floors only where the sample is big enough', () => {
    // 8 FRONTs and 8 BACKs -> 64 FRONT|BACK samples (>= MIN_FLOOR_SAMPLES).
    // 2 TOPs -> FRONT|TOP has 16 samples (< 30): no floor.
    const fronts = Array.from({ length: 8 }, (_, i) => v(1, i * 0.05, 0));
    const backs  = Array.from({ length: 8 }, (_, i) => v(0.3, 1, i * 0.05));
    const tops   = Array.from({ length: 2 }, (_, i) => v(0, i * 0.05, 1));
    const vectors = [...fronts, ...backs, ...tops];
    const angles = [
      ...fronts.map(() => 'FRONT'), ...backs.map(() => 'BACK'), ...tops.map(() => 'TOP'),
    ];
    const floors = pairFloors(vectors, angles);
    expect(floors.has(floorKey('FRONT', 'BACK'))).toBe(true);
    expect(floors.has(floorKey('FRONT', 'TOP'))).toBe(false);
  });
  it('floorOf returns null for unlabelled photographs and unsampled pairs', () => {
    const floors = new Map([[floorKey('FRONT', 'BACK'), 0.5]]);
    expect(floorOf(floors, 'FRONT', 'BACK')).toBe(0.5);
    expect(floorOf(floors, 'FRONT', undefined)).toBeNull();
    expect(floorOf(floors, 'FRONT', 'SOLE')).toBeNull();
  });
  it('marginOf falls back to raw cosine without a floor', () => {
    expect(marginOf(0.62, 0.5)).toBeCloseTo(0.12);
    expect(marginOf(0.62, null)).toBeCloseTo(0.62);
  });
  it('THE FLOOR NEVER PRUNES: a pool keeps candidates below every floor', () => {
    // One FRONT anchor, one LEFT candidate at low cosine; floors made
    // artificially high must not remove it (floors are not even an input
    // to buildPools - this test documents that fact).
    const pools = buildPools([v(1, 0), v(0.1, 1)], ['FRONT', 'LEFT'], new Set());
    expect(pools.find((p) => p.anchor === 0)!.candidates).toContain(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run services/candidatePool.test.ts`
Expected: FAIL — cannot resolve `./candidatePool`.

- [ ] **Step 3: Implement `services/candidatePool.ts`**

```ts
import { bucketOf } from './angleAtlas';

export const POOL_SIZE = 6;
export const FLOOR_PERCENTILE = 75;
export const MIN_FLOOR_SAMPLES = 30;

export const cosine = (a: Float32Array, b: Float32Array): number => {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (!normA || !normB) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
};

export const pairKey = (a: number, b: number): string =>
  a < b ? `${a},${b}` : `${b},${a}`;

export interface Pool {
  anchor: number;
  candidates: number[];
  truncated: boolean;
}

export const floorKey = (bucketA: string, bucketB: string): string =>
  bucketA < bucketB ? `${bucketA}|${bucketB}` : `${bucketB}|${bucketA}`;

/**
 * One floor per unordered pair of angle buckets, each on its own scale.
 * FRONT-to-LEFT cosines and FRONT-to-BACK cosines are different
 * distributions, and 0.62 can be exceptional in one while unremarkable in
 * the other - the heel-tab case in the spec. A pool of fewer than
 * MIN_FLOOR_SAMPLES yields no floor rather than a floor made of noise.
 */
export const pairFloors = (
  vectors: (Float32Array | null)[],
  angles: (string | undefined)[],
): Map<string, number> => {
  const samples = new Map<string, number[]>();

  for (let i = 0; i < vectors.length; i += 1) {
    const vi = vectors[i];
    const bi = bucketOf(angles[i]);
    if (!vi || !bi) continue;
    for (let j = i + 1; j < vectors.length; j += 1) {
      const vj = vectors[j];
      const bj = bucketOf(angles[j]);
      if (!vj || !bj || bi === bj) continue;
      const key = floorKey(bi, bj);
      const held = samples.get(key) ?? [];
      held.push(cosine(vi, vj));
      samples.set(key, held);
    }
  }

  const floors = new Map<string, number>();
  samples.forEach((pool, key) => {
    if (pool.length < MIN_FLOOR_SAMPLES) return;
    const sorted = [...pool].sort((x, y) => x - y);
    const index = Math.min(
      sorted.length - 1,
      Math.max(0, Math.ceil((FLOOR_PERCENTILE / 100) * sorted.length) - 1)
    );
    floors.set(key, sorted[index]);
  });
  return floors;
};

export const floorOf = (
  floors: Map<string, number>,
  angleA: string | undefined,
  angleB: string | undefined,
): number | null => {
  const ba = bucketOf(angleA);
  const bb = bucketOf(angleB);
  if (!ba || !bb || ba === bb) return null;
  return floors.get(floorKey(ba, bb)) ?? null;
};

/** For PRIORITY ORDERING only. Never used to remove a candidate. */
export const marginOf = (cos: number, floor: number | null): number =>
  floor === null ? cos : cos - floor;

/**
 * Stratified candidate selection - spec section 6, final form:
 *   1. remove same-angle photographs (cannot-link),
 *   2. remove recorded NOT-SAME pairs,
 *   3. reserve one slot per other angle bucket (best of each),
 *   4. fill the rest to k by global cosine rank.
 * NO floor is consulted here. The floor never prunes.
 */
export const buildPools = (
  vectors: (Float32Array | null)[],
  angles: (string | undefined)[],
  notSame: ReadonlySet<string>,
  k: number = POOL_SIZE,
): Pool[] =>
  vectors.map((vector, anchor) => {
    if (!vector) return { anchor, candidates: [], truncated: false };

    const anchorBucket = bucketOf(angles[anchor]);
    const scored: { index: number; score: number; bucket: string | null }[] = [];

    vectors.forEach((other, index) => {
      if (index === anchor || !other) return;
      const bucket = bucketOf(angles[index]);
      if (anchorBucket !== null && bucket === anchorBucket) return;   // cannot-link
      if (notSame.has(pairKey(anchor, index))) return;                // ruled out
      scored.push({ index, score: cosine(vector, other), bucket });
    });

    // Strongest first; folder order breaks exact ties for determinism.
    scored.sort((x, y) => (y.score - x.score) || (x.index - y.index));

    // Reserve the best candidate from every bucket present (unlabelled
    // photographs compete only in the fill).
    const reservedByBucket = new Map<string, number>();
    scored.forEach(({ index, bucket }) => {
      if (bucket && !reservedByBucket.has(bucket)) reservedByBucket.set(bucket, index);
    });
    const reserved = [...reservedByBucket.values()];

    // If buckets alone exceed k, keep the k strongest reservations - the
    // spec's named residual risk, deterministic by construction.
    const chosen = new Set<number>(
      reserved
        .sort((x, y) => {
          const sx = scored.find((s) => s.index === x)!.score;
          const sy = scored.find((s) => s.index === y)!.score;
          return (sy - sx) || (x - y);
        })
        .slice(0, k)
    );

    for (const { index } of scored) {
      if (chosen.size >= k) break;
      chosen.add(index);
    }

    const candidates = scored.filter((s) => chosen.has(s.index)).map((s) => s.index);
    return { anchor, candidates, truncated: scored.length > candidates.length };
  });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run services/candidatePool.test.ts`
Expected: PASS, including both heel-tab assertions.

- [ ] **Step 5: Commit**

```bash
git add services/candidatePool.ts services/candidatePool.test.ts
git commit -m "feat: stratified candidate pools with angle-pair floors; floor never prunes"
```

---

### Task 6: Anchor contact sheet

Spec §8.2 needs the anchor visually unmistakable. `buildContactSheet` is a uniform grid; add an anchor layout: anchor fills the left half, candidates grid on the right, numbered 0..N.

**Files:**
- Modify: `services/contactSheet.ts`
- Test: `services/contactSheet.test.ts` (create — the module has no test file today; test only the pure layout math, since vitest has no canvas)

**Interfaces:**
- Consumes: existing `Cell`, `SheetLayout`, `fitInside`, `LABEL_BAND`, private `decode` (same module).
- Produces:

```ts
/** Layout for one anchor + n candidates. Cell 0 is the anchor, left side. */
export const anchorSheetLayout = (candidates: number, pixels?: number): SheetLayout;

/** Draws it. photos[0] is the anchor. Returns base64 JPEG or null (no canvas). */
export const buildAnchorSheet = (photos: string[], pixels?: number): Promise<string | null>;
```

- [ ] **Step 1: Write the failing tests**

```ts
// services/contactSheet.test.ts
import { describe, expect, it } from 'vitest';
import { LABEL_BAND, anchorSheetLayout, sheetLayout } from './contactSheet';

describe('anchorSheetLayout', () => {
  it('gives the anchor the full left half', () => {
    const layout = anchorSheetLayout(6, 1280);
    const anchor = layout.cells[0];
    expect(anchor.label).toBe(0);
    expect(anchor.x).toBe(0);
    expect(anchor.width).toBeCloseTo(1280 * 0.45, 0);
    expect(anchor.height + LABEL_BAND).toBeLessThanOrEqual(layout.height);
  });
  it('numbers candidates 1..n on the right, none overlapping the anchor', () => {
    const layout = anchorSheetLayout(6, 1280);
    expect(layout.cells.length).toBe(7);
    layout.cells.slice(1).forEach((cell, i) => {
      expect(cell.label).toBe(i + 1);
      expect(cell.x).toBeGreaterThanOrEqual(layout.cells[0].width);
    });
  });
  it('handles a single candidate', () => {
    expect(anchorSheetLayout(1, 1280).cells.length).toBe(2);
  });
  it('leaves the plain grid layout untouched', () => {
    expect(sheetLayout(9).cells.length).toBe(9); // regression guard
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run services/contactSheet.test.ts`
Expected: FAIL — `anchorSheetLayout` is not exported.

- [ ] **Step 3: Implement in `services/contactSheet.ts`.** Add below `sheetLayout`:

```ts
/**
 * Layout for the identity question: the anchor large on the left (45% of the
 * width), candidates in a grid on the right. The anchor must be visually
 * unmistakable - the whole request is "compare everything to THIS".
 */
export const anchorSheetLayout = (
  candidates: number,
  pixels: number = SHEET_PIXELS
): SheetLayout => {
  const anchorWidth = Math.round(pixels * 0.45);
  const rightWidth = pixels - anchorWidth;

  const columns = candidates <= 2 ? 1 : 2;
  const rows = Math.ceil(candidates / columns);
  const cellWidth = Math.floor(rightWidth / columns);
  const cellHeight = Math.floor(cellWidth * 0.9);
  const height = Math.max(
    rows * (cellHeight + LABEL_BAND),
    Math.round(pixels * 0.6)
  );

  const cells: Cell[] = [
    { x: 0, y: 0, width: anchorWidth, height: height - LABEL_BAND, label: 0 },
  ];
  for (let i = 0; i < candidates; i += 1) {
    const column = i % columns;
    const row = Math.floor(i / columns);
    cells.push({
      x: anchorWidth + column * cellWidth,
      y: row * (cellHeight + LABEL_BAND),
      width: cellWidth,
      height: cellHeight,
      label: i + 1,
    });
  }
  return { width: pixels, height, cells };
};

/**
 * Draws an anchor sheet. photos[0] is the anchor; the rest are candidates in
 * order. Same contract as buildContactSheet: base64 JPEG, or null where there
 * is no canvas, in which case the caller sends the photographs separately.
 */
export const buildAnchorSheet = async (
  photos: string[],
  pixels: number = SHEET_PIXELS
): Promise<string | null> => {
  if (photos.length < 2) return null;
  if (typeof document === 'undefined' && typeof OffscreenCanvas === 'undefined') return null;
  return paint(anchorSheetLayout(photos.length - 1, pixels), photos);
};
```

Then refactor the drawing body of `buildContactSheet` into a private `paint(layout: SheetLayout, photos: string[]): Promise<string | null>` used by both — the canvas creation, background fill, decode loop, white mat, `drawImage`, label band and JPEG export move verbatim into `paint`; `buildContactSheet` becomes `sheetLayout(...)` + `paint(...)`.

- [ ] **Step 4: Run tests and lint**

Run: `npx vitest run services/contactSheet.test.ts` — Expected: PASS.
Run: `npm run lint` — Expected: clean.
Run: `npm test` — Expected: no regressions (v2 uses `buildContactSheet`).

- [ ] **Step 5: Commit**

```bash
git add services/contactSheet.ts services/contactSheet.test.ts
git commit -m "feat: anchor contact sheet layout for the identity question"
```

---

### Task 7: Identity question

Spec §8.2/§8.3: prompt, schema, reader with hard `because` truncation and drop-never-default discipline.

**Files:**
- Create: `services/identityQuestion.ts`
- Test: `services/identityQuestion.test.ts`

**Interfaces:**
- Consumes: nothing (pure).
- Produces:

```ts
export const BECAUSE_WORDS = 6;

export interface CandidateVerdict {
  photo: number;          // 1..count, the candidate's printed number
  same: boolean;
  sure: boolean;          // absent or non-boolean reads as NOT sure
  because?: string;       // truncated to BECAUSE_WORDS words
}

export const IDENTITY_SCHEMA: Record<string, unknown>;
export const identityPrompt = (candidates: number): string;
export const readIdentity = (entries: unknown[], candidates: number): CandidateVerdict[];
```

- [ ] **Step 1: Write the failing tests**

```ts
// services/identityQuestion.test.ts
import { describe, expect, it } from 'vitest';
import { BECAUSE_WORDS, identityPrompt, readIdentity } from './identityQuestion';

describe('identityPrompt', () => {
  const prompt = identityPrompt(6);
  it('makes NONE an expected answer', () => {
    expect(prompt).toMatch(/NONE OF THEM MAY BE/);
  });
  it('never mentions angles', () => {
    expect(prompt.toLowerCase()).not.toMatch(/\bangle/);
  });
  it('warns against broad similarity', () => {
    expect(prompt).toMatch(/BROAD SIMILARITY IS NOT EVIDENCE/);
  });
  it('names the sole as part of the colourway', () => {
    expect(prompt).toMatch(/SOLE IS PART OF THE COLOURWAY/);
  });
});

describe('readIdentity', () => {
  it('reads a well-formed verdict', () => {
    expect(readIdentity(
      [{ photo: 1, same: true, sure: true, because: 'same heel logo' }], 3
    )).toEqual([{ photo: 1, same: true, sure: true, because: 'same heel logo' }]);
  });
  it('treats a missing or non-boolean sure as NOT sure', () => {
    const [a] = readIdentity([{ photo: 1, same: true }], 2);
    expect(a.sure).toBe(false);
    const [b] = readIdentity([{ photo: 1, same: true, sure: 'yes' }], 2);
    expect(b.sure).toBe(false);
  });
  it('drops entries with no readable same field', () => {
    expect(readIdentity([{ photo: 1, sure: true }], 2)).toEqual([]);
  });
  it('drops photo 0 (the anchor cannot answer about itself), out-of-range and duplicates', () => {
    const verdicts = readIdentity([
      { photo: 0, same: true, sure: true },
      { photo: 4, same: true, sure: true },
      { photo: 2, same: false, sure: true },
      { photo: 2, same: true, sure: true },
    ], 3);
    expect(verdicts).toEqual([{ photo: 2, same: false, sure: true, because: undefined }]);
  });
  it(`truncates because to ${BECAUSE_WORDS} words`, () => {
    const [v] = readIdentity([{
      photo: 1, same: false, sure: true,
      because: 'one two three four five six seven eight nine',
    }], 2);
    expect(v.because).toBe('one two three four five six');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run services/identityQuestion.test.ts`
Expected: FAIL — cannot resolve `./identityQuestion`.

- [ ] **Step 3: Implement `services/identityQuestion.ts`.** The prompt text is in spec §8.2 — copy it VERBATIM from the spec (it is the reviewed artefact; do not paraphrase). Around it:

```ts
export const BECAUSE_WORDS = 6;

export interface CandidateVerdict {
  photo: number;
  same: boolean;
  sure: boolean;
  because?: string;
}

export const IDENTITY_SCHEMA: Record<string, unknown> = {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      photo: { type: 'integer', description: 'The number printed under the candidate.' },
      same: { type: 'boolean' },
      sure: { type: 'boolean' },
      because: { type: 'string', description: 'At most six words naming the feature.' },
    },
    required: ['photo', 'same', 'sure', 'because'],
    additionalProperties: false,
  },
};

export const identityPrompt = (candidates: number): string =>
  `Photograph 0, shown alone at the left, is the ANCHOR. Photographs 1 to ${candidates} are candidates. Numbers are printed beneath each.
  ...VERBATIM FROM SPEC SECTION 8.2...`;

export const readIdentity = (entries: unknown[], candidates: number): CandidateVerdict[] => {
  const verdicts: CandidateVerdict[] = [];
  const claimed = new Set<number>();

  entries.forEach((entry) => {
    if (!entry || typeof entry !== 'object') return;
    const record = entry as Record<string, unknown>;

    const photo = Number(record.photo);
    if (!Number.isInteger(photo) || photo < 1 || photo > candidates || claimed.has(photo)) return;
    if (typeof record.same !== 'boolean') return;   // dropped, never defaulted
    claimed.add(photo);

    const because =
      typeof record.because === 'string' && record.because.trim()
        ? record.because.trim().split(/\s+/).slice(0, BECAUSE_WORDS).join(' ')
        : undefined;

    verdicts.push({
      photo,
      same: record.same,
      sure: record.sure === true,                    // anything else is NOT sure
      because,
    });
  });

  return verdicts;
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run services/identityQuestion.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add services/identityQuestion.ts services/identityQuestion.test.ts
git commit -m "feat: identity question - anchor prompt, schema, drop-never-default reader"
```

---

### Task 8: Link graph — constrained union-find with provenance and outcomes

The heart of correctness: spec §3, §9, §10. Gets the property test.

**Files:**
- Create: `services/linkGraph.ts`
- Test: `services/linkGraph.test.ts`

**Interfaces:**
- Consumes: `cannotLink`, `bucketOf` from Task 4.
- Produces:

```ts
export interface Link {
  a: string; b: string;              // imageIds
  same: boolean;
  sure: boolean;
  because?: string;
  anchor: string;                    // imageId whose question produced this
  requestId: string;
}

export type AddResult =
  | 'merged' | 'already-together' | 'recorded-different'
  | 'refused-angle' | 'refused-different' | 'ignored-unsure';

export interface Provenance {
  to: string;
  kind: 'direct' | 'indirect';
  because?: string;
  hops?: number;
}

export class LinkGraph {
  constructor(ids: string[], angleOf: (id: string) => string | undefined);
  add(link: Link): AddResult;
  sameCluster(a: string, b: string): boolean;
  /** angle conflict OR recorded NOT-SAME between the two photographs' clusters */
  cannotJoin(a: string, b: string): boolean;
  isNotSame(a: string, b: string): boolean;
  /** pairs flagged for review: SAME asserted where a bar exists, or vice versa */
  contested(): ReadonlySet<string>;          // "idA idB" keys, sorted
  clusters(): string[][];                    // deterministic: by first member's folder order
  /** spanning-tree provenance for every member of the cluster containing id */
  provenanceOf(id: string): Map<string, Provenance>;
  /** all sure SAME links inside a cluster, for confidence display */
  directLinks(id: string): Link[];
}
```

Behaviour rules (spec §5, §9):
- `same:true, sure:true` → merge, unless it would put two same-bucket photos in one cluster (`refused-angle`) or a NOT-SAME exists between any cross-pair of the two clusters (`refused-different`). Refusals mark the pair contested.
- `same:false, sure:true` → record NOT-SAME. If the pair is already in one cluster: do NOT split; mark contested (`rule 4: disagreement splits` applies at merge time; an established cluster is flagged for review instead).
- Anything unsure → `ignored-unsure`, nothing recorded.
- Provenance: BFS over sure-SAME links from the cluster's first member (folder order); tree edges are `direct` with the link's `because`; other members reached are `indirect` with hop count.

- [ ] **Step 1: Write the failing tests**

```ts
// services/linkGraph.test.ts
import { describe, expect, it } from 'vitest';
import { LinkGraph, Link } from './linkGraph';

const link = (a: string, b: string, same: boolean, sure = true, because?: string): Link =>
  ({ a, b, same, sure, because, anchor: a, requestId: 'r' });

const graph = (ids: string[], angles: Record<string, string | undefined>) =>
  new LinkGraph(ids, (id) => angles[id]);

describe('the invariant (spec rule 1)', () => {
  it('refuses a direct same-angle merge at ANY confidence', () => {
    const g = graph(['a', 'b'], { a: 'FRONT', b: 'FRONT' });
    expect(g.add(link('a', 'b', true))).toBe('refused-angle');
    expect(g.sameCluster('a', 'b')).toBe(false);
  });
  it('refuses a TRANSITIVE merge that would collide angles', () => {
    const g = graph(['a', 'b', 'c', 'd'],
      { a: 'FRONT', b: 'LEFT', c: 'FRONT', d: 'BACK' });
    g.add(link('a', 'b', true));       // cluster {a,b}
    g.add(link('c', 'd', true));       // cluster {c,d}
    // joining b-d would put two FRONTs (a and c) in one cluster
    expect(g.add(link('b', 'd', true))).toBe('refused-angle');
  });
  it('CLOSEUP photographs carry no cannot-link', () => {
    const g = graph(['a', 'b'], { a: 'CLOSEUP', b: 'CLOSEUP' });
    expect(g.add(link('a', 'b', true))).toBe('merged');
  });

  it('PROPERTY: no cluster ever holds two same-bucket photos, under fuzz', () => {
    let seed = 42;
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 0x100000000;
    };
    const buckets = ['FRONT', 'BACK', 'LEFT', 'RIGHT', 'TOP', 'SOLE', undefined];
    for (let round = 0; round < 50; round += 1) {
      const ids = Array.from({ length: 30 }, (_, i) => `p${i}`);
      const angles: Record<string, string | undefined> = {};
      ids.forEach((id) => { angles[id] = buckets[Math.floor(rand() * buckets.length)]; });
      const g = graph(ids, angles);
      for (let n = 0; n < 200; n += 1) {
        const a = ids[Math.floor(rand() * ids.length)];
        const b = ids[Math.floor(rand() * ids.length)];
        if (a === b) continue;
        g.add(link(a, b, rand() < 0.7, rand() < 0.8));
      }
      g.clusters().forEach((cluster) => {
        const seen = new Set<string>();
        cluster.forEach((id) => {
          const bucket = angles[id];
          if (bucket === undefined) return;
          expect(seen.has(bucket)).toBe(false);
          seen.add(bucket);
        });
      });
    }
  });
});

describe('evidence discipline (spec rules 2-5)', () => {
  it('an unsure answer changes nothing', () => {
    const g = graph(['a', 'b'], { a: 'FRONT', b: 'BACK' });
    expect(g.add(link('a', 'b', true, false))).toBe('ignored-unsure');
    expect(g.add(link('a', 'b', false, false))).toBe('ignored-unsure');
    expect(g.sameCluster('a', 'b')).toBe(false);
    expect(g.isNotSame('a', 'b')).toBe(false);
  });
  it('a sure NOT-SAME bars a later merge and marks the retry contested', () => {
    const g = graph(['a', 'b'], { a: 'FRONT', b: 'BACK' });
    g.add(link('a', 'b', false));
    expect(g.add(link('a', 'b', true))).toBe('refused-different');
    expect(g.contested().size).toBe(1);
  });
  it('a NOT-SAME between clusters bars merging them through other members', () => {
    const g = graph(['a', 'b', 'c'], { a: 'FRONT', b: 'BACK', c: 'LEFT' });
    g.add(link('a', 'b', true));
    g.add(link('a', 'c', false));           // a and c are different products
    expect(g.add(link('b', 'c', true))).toBe('refused-different');
  });
  it('disagreement after a merge flags, never splits', () => {
    const g = graph(['a', 'b'], { a: 'FRONT', b: 'BACK' });
    g.add(link('a', 'b', true));
    g.add(link('a', 'b', false));
    expect(g.sameCluster('a', 'b')).toBe(true);   // not silently unwound
    expect(g.contested().size).toBe(1);            // but loudly flagged
  });
});

describe('provenance (spec section 9)', () => {
  it('separates direct joins from transitive ones, with hops', () => {
    const g = graph(['a', 'b', 'c'], { a: 'FRONT', b: 'BACK', c: 'LEFT' });
    g.add(link('a', 'b', true, true, 'same heel logo'));
    g.add(link('b', 'c', true, true, 'same tread'));
    const prov = g.provenanceOf('a');
    expect(prov.get('b')).toEqual({ to: 'a', kind: 'direct', because: 'same heel logo' });
    expect(prov.get('c')).toEqual({ to: 'b', kind: 'direct', because: 'same tread' });
    // a<->c were never directly compared:
    expect(g.directLinks('a').some((l) =>
      (l.a === 'a' && l.b === 'c') || (l.a === 'c' && l.b === 'a'))).toBe(false);
  });
  it('clusters come out in deterministic folder order', () => {
    const g = graph(['a', 'b', 'c'], {});
    g.add(link('c', 'b', true));
    expect(g.clusters()).toEqual([['a'], ['b', 'c']]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run services/linkGraph.test.ts`
Expected: FAIL — cannot resolve `./linkGraph`.

- [ ] **Step 3: Implement `services/linkGraph.ts`**

```ts
import { bucketOf } from './angleAtlas';

export interface Link {
  a: string; b: string;
  same: boolean;
  sure: boolean;
  because?: string;
  anchor: string;
  requestId: string;
}

export type AddResult =
  | 'merged' | 'already-together' | 'recorded-different'
  | 'refused-angle' | 'refused-different' | 'ignored-unsure';

export interface Provenance {
  to: string;
  kind: 'direct' | 'indirect';
  because?: string;
  hops?: number;
}

const idPair = (a: string, b: string): string => (a < b ? `${a} ${b}` : `${b} ${a}`);

export class LinkGraph {
  private order: Map<string, number>;
  private parent: Map<string, string>;
  private bucketsIn: Map<string, Set<string>>;   // root -> cannot-link buckets present
  private members: Map<string, string[]>;        // root -> ids
  private notSame = new Set<string>();           // idPair keys
  private contestedPairs = new Set<string>();
  private sameLinks: Link[] = [];                // every sure SAME accepted or refused-*
  private angleOf: (id: string) => string | undefined;

  constructor(ids: string[], angleOf: (id: string) => string | undefined) {
    this.angleOf = angleOf;
    this.order = new Map(ids.map((id, i) => [id, i]));
    this.parent = new Map(ids.map((id) => [id, id]));
    this.members = new Map(ids.map((id) => [id, [id]]));
    this.bucketsIn = new Map(ids.map((id) => {
      const bucket = bucketOf(angleOf(id));
      return [id, new Set(bucket ? [bucket] : [])];
    }));
  }

  private find(id: string): string {
    const held = this.parent.get(id);
    if (held === undefined || held === id) return id;
    const root = this.find(held);
    this.parent.set(id, root);
    return root;
  }

  sameCluster(a: string, b: string): boolean { return this.find(a) === this.find(b); }

  isNotSame(a: string, b: string): boolean { return this.notSame.has(idPair(a, b)); }

  private crossNotSame(rootA: string, rootB: string): boolean {
    const membersA = this.members.get(rootA) ?? [];
    const membersB = this.members.get(rootB) ?? [];
    return membersA.some((x) => membersB.some((y) => this.notSame.has(idPair(x, y))));
  }

  cannotJoin(a: string, b: string): boolean {
    const rootA = this.find(a);
    const rootB = this.find(b);
    if (rootA === rootB) return false;
    const bucketsA = this.bucketsIn.get(rootA)!;
    const bucketsB = this.bucketsIn.get(rootB)!;
    for (const bucket of bucketsB) if (bucketsA.has(bucket)) return true;
    return this.crossNotSame(rootA, rootB);
  }

  add(link: Link): AddResult {
    if (!link.sure) return 'ignored-unsure';
    const { a, b } = link;
    const pair = idPair(a, b);

    if (!link.same) {
      if (this.sameCluster(a, b)) {
        // Disagreement with an established cluster: flag, never split.
        this.contestedPairs.add(pair);
        return 'recorded-different';
      }
      this.notSame.add(pair);
      return 'recorded-different';
    }

    this.sameLinks.push(link);
    const rootA = this.find(a);
    const rootB = this.find(b);
    if (rootA === rootB) return 'already-together';

    const bucketsA = this.bucketsIn.get(rootA)!;
    const bucketsB = this.bucketsIn.get(rootB)!;
    for (const bucket of bucketsB) {
      if (bucketsA.has(bucket)) {
        this.contestedPairs.add(pair);
        return 'refused-angle';
      }
    }
    if (this.crossNotSame(rootA, rootB)) {
      this.contestedPairs.add(pair);
      return 'refused-different';
    }

    // Merge B into A, keeping the root with the earlier folder order so
    // cluster identity is deterministic.
    const first = (root: string) =>
      Math.min(...this.members.get(root)!.map((id) => this.order.get(id) ?? 0));
    const [into, from] = first(rootA) <= first(rootB) ? [rootA, rootB] : [rootB, rootA];

    this.parent.set(from, into);
    this.members.get(into)!.push(...this.members.get(from)!);
    this.members.delete(from);
    const bucketsInto = this.bucketsIn.get(into)!;
    this.bucketsIn.get(from)!.forEach((bucket) => bucketsInto.add(bucket));
    this.bucketsIn.delete(from);
    return 'merged';
  }

  contested(): ReadonlySet<string> { return this.contestedPairs; }

  clusters(): string[][] {
    const byOrder = (x: string, y: string) =>
      (this.order.get(x) ?? 0) - (this.order.get(y) ?? 0);
    return [...this.members.values()]
      .map((ids) => [...ids].sort(byOrder))
      .sort((x, y) => byOrder(x[0], y[0]));
  }

  directLinks(id: string): Link[] {
    const root = this.find(id);
    return this.sameLinks.filter(
      (l) => l.sure && l.same && this.find(l.a) === root && this.sameCluster(l.a, l.b)
    );
  }

  provenanceOf(id: string): Map<string, Provenance> {
    const root = this.find(id);
    const ids = this.members.get(root) ?? [id];
    const byOrder = [...ids].sort(
      (x, y) => (this.order.get(x) ?? 0) - (this.order.get(y) ?? 0)
    );
    const start = byOrder[0];

    // Adjacency over sure-SAME links inside this cluster.
    const edges = new Map<string, { to: string; because?: string }[]>();
    this.directLinks(start).forEach((l) => {
      edges.set(l.a, [...(edges.get(l.a) ?? []), { to: l.b, because: l.because }]);
      edges.set(l.b, [...(edges.get(l.b) ?? []), { to: l.a, because: l.because }]);
    });

    const provenance = new Map<string, Provenance>();
    const depth = new Map<string, number>([[start, 0]]);
    const queue = [start];
    while (queue.length) {
      const at = queue.shift()!;
      const next = (edges.get(at) ?? [])
        .sort((x, y) => (this.order.get(x.to) ?? 0) - (this.order.get(y.to) ?? 0));
      for (const { to, because } of next) {
        if (depth.has(to)) continue;
        depth.set(to, (depth.get(at) ?? 0) + 1);
        provenance.set(to, { to: at, kind: 'direct', because });
        queue.push(to);
      }
    }

    // Members connected only transitively through the tree: mark hop counts.
    provenance.forEach((p, member) => {
      const hops = depth.get(member) ?? 1;
      if (hops > 1) provenance.set(member, { ...p, kind: 'direct' });
    });
    return provenance;
  }
}
```

Note on `provenanceOf`: every tree edge IS a direct link (it came from `sameLinks`), so its kind stays `'direct'`; a member's *relationship to the cluster's anchor* being transitive is expressed by `hops` — set `hops: depth` on every entry with depth > 1 (adjust the last loop accordingly: `provenance.set(member, { ...p, hops })` when `hops > 1`). The review screen renders "joined to X — because" for the tree edge and "never compared directly with the rest" comes from `directLinks` absence, which Task 11 wires.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run services/linkGraph.test.ts`
Expected: PASS, including the 50-round fuzz.

- [ ] **Step 5: Commit**

```bash
git add services/linkGraph.ts services/linkGraph.test.ts
git commit -m "feat: constrained union-find with cannot-link, NOT-SAME bars, provenance"
```

---

### Task 9: Wave scheduler (pure parts)

Spec §7: priority ordering, disjoint wave building, skip logic. Pure functions in their own module so they are testable without any network.

**Files:**
- Create: `services/waveScheduler.ts`
- Test: `services/waveScheduler.test.ts`

**Interfaces:**
- Consumes: `Pool`, `marginOf`, `floorOf`, `cosine`, `pairKey` from Task 5; `LinkGraph` from Task 8.
- Produces:

```ts
export const WAVE_WIDTH = 8;

export interface LivePool {
  anchor: number;
  /** candidates not yet resolved against this anchor, strongest first */
  live: number[];
  /** margin of the best live candidate (priority rule 2) */
  bestMargin: number;
}

/**
 * Prunes each pool against the graph: a candidate already in the anchor's
 * cluster, or cannot-joinable with it, is resolved and drops out. An anchor
 * with nothing live left drops out entirely (the free skip).
 */
export const livePools = (
  pools: Pool[],
  idOf: (index: number) => string,
  graph: LinkGraph,
  margin: (anchor: number, candidate: number) => number,
): LivePool[];

/** Priority order: most live desc, best margin desc, folder order asc. */
export const byPriority = (a: LivePool, b: LivePool): number;

/**
 * Greedy disjoint wave: walk in priority order, take an anchor only when
 * {anchor + live candidates} is disjoint from everything already taken.
 */
export const buildWave = (queue: LivePool[], width?: number): LivePool[];
```

- [ ] **Step 1: Write the failing tests**

```ts
// services/waveScheduler.test.ts
import { describe, expect, it } from 'vitest';
import { LinkGraph } from './linkGraph';
import { WAVE_WIDTH, buildWave, byPriority, livePools } from './waveScheduler';
import { Pool } from './candidatePool';

const pool = (anchor: number, candidates: number[]): Pool =>
  ({ anchor, candidates, truncated: false });
const idOf = (i: number) => `p${i}`;
const flatMargin = () => 0.5;

describe('livePools', () => {
  it('drops candidates already resolved by transitivity', () => {
    const g = new LinkGraph(['p0', 'p1', 'p2'], () => undefined);
    g.add({ a: 'p0', b: 'p1', same: true, sure: true, anchor: 'p0', requestId: 'r' });
    const live = livePools([pool(0, [1, 2])], idOf, g, flatMargin);
    expect(live[0].live).toEqual([2]);
  });
  it('drops candidates barred by NOT-SAME or angle', () => {
    const angles: Record<string, string> = { p0: 'FRONT', p2: 'FRONT' };
    const g = new LinkGraph(['p0', 'p1', 'p2'], (id) => angles[id]);
    g.add({ a: 'p0', b: 'p1', same: false, sure: true, anchor: 'p0', requestId: 'r' });
    // p2 shares FRONT with p0 via clusters-of-one: cannotJoin is true
    const live = livePools([pool(0, [1, 2])], idOf, g, flatMargin);
    expect(live.length).toBe(0);   // both resolved -> anchor skipped entirely, free
  });
  it('keeps unresolved anchors with their live candidates', () => {
    const g = new LinkGraph(['p0', 'p1'], () => undefined);
    const live = livePools([pool(0, [1])], idOf, g, flatMargin);
    expect(live).toEqual([{ anchor: 0, live: [1], bestMargin: 0.5 }]);
  });
});

describe('byPriority', () => {
  it('orders by live count, then margin, then folder order', () => {
    const a = { anchor: 5, live: [1, 2, 3], bestMargin: 0.1 };
    const b = { anchor: 2, live: [1, 2], bestMargin: 0.9 };
    const c = { anchor: 1, live: [1, 2], bestMargin: 0.9 };
    expect([a, b, c].sort(byPriority).map((x) => x.anchor)).toEqual([5, 1, 2]);
  });
});

describe('buildWave', () => {
  it('takes only pairwise-disjoint pools', () => {
    const queue = [
      { anchor: 0, live: [1, 2], bestMargin: 0.9 },
      { anchor: 3, live: [2, 4], bestMargin: 0.8 },   // shares 2 with the first
      { anchor: 5, live: [6], bestMargin: 0.7 },
    ].sort(byPriority);
    const wave = buildWave(queue, 10);
    expect(wave.map((w) => w.anchor)).toEqual([0, 5]);
  });
  it('a candidate that is another wave-member anchor is an overlap', () => {
    const queue = [
      { anchor: 0, live: [3], bestMargin: 0.9 },
      { anchor: 3, live: [7], bestMargin: 0.8 },       // 3 is already in wave as a candidate
    ].sort(byPriority);
    expect(buildWave(queue, 10).map((w) => w.anchor)).toEqual([0]);
  });
  it('respects the width limit', () => {
    const queue = Array.from({ length: 20 }, (_, i) => ({
      anchor: i * 10, live: [i * 10 + 1], bestMargin: 0.5,
    }));
    expect(buildWave(queue, WAVE_WIDTH).length).toBe(WAVE_WIDTH);
  });
  it('is deterministic for a given queue', () => {
    const queue = [
      { anchor: 2, live: [5], bestMargin: 0.5 },
      { anchor: 1, live: [6], bestMargin: 0.5 },
    ].sort(byPriority);
    expect(buildWave(queue, 10)).toEqual(buildWave(queue, 10));
    expect(buildWave(queue, 10).map((w) => w.anchor)).toEqual([1, 2]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run services/waveScheduler.test.ts`
Expected: FAIL — cannot resolve `./waveScheduler`.

- [ ] **Step 3: Implement `services/waveScheduler.ts`**

```ts
import { Pool } from './candidatePool';
import { LinkGraph } from './linkGraph';

export const WAVE_WIDTH = 8;

export interface LivePool {
  anchor: number;
  live: number[];
  bestMargin: number;
}

export const livePools = (
  pools: Pool[],
  idOf: (index: number) => string,
  graph: LinkGraph,
  margin: (anchor: number, candidate: number) => number,
): LivePool[] => {
  const out: LivePool[] = [];
  for (const pool of pools) {
    const anchorId = idOf(pool.anchor);
    const live = pool.candidates.filter((candidate) => {
      const candidateId = idOf(candidate);
      if (graph.sameCluster(anchorId, candidateId)) return false;  // transitivity answered it
      if (graph.cannotJoin(anchorId, candidateId)) return false;   // angle or NOT-SAME bar
      if (graph.isNotSame(anchorId, candidateId)) return false;
      return true;
    });
    if (!live.length) continue;                                    // the free skip
    const bestMargin = Math.max(...live.map((c) => margin(pool.anchor, c)));
    out.push({ anchor: pool.anchor, live, bestMargin });
  }
  return out;
};

export const byPriority = (a: LivePool, b: LivePool): number =>
  (b.live.length - a.live.length) ||
  (b.bestMargin - a.bestMargin) ||
  (a.anchor - b.anchor);

export const buildWave = (queue: LivePool[], width: number = WAVE_WIDTH): LivePool[] => {
  const wave: LivePool[] = [];
  const taken = new Set<number>();
  for (const entry of queue) {
    if (wave.length >= width) break;
    const footprint = [entry.anchor, ...entry.live];
    if (footprint.some((index) => taken.has(index))) continue;
    footprint.forEach((index) => taken.add(index));
    wave.push(entry);
  }
  return wave;
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run services/waveScheduler.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add services/waveScheduler.ts services/waveScheduler.test.ts
git commit -m "feat: wave scheduler - priority ordering, free skips, disjoint waves"
```

---

### Task 10: Orchestrator — `groupFolderV3`

Ties everything together: tracks A and B, join, waves, cluster, classify, run log. Tested end-to-end with a scripted fake `ask` (the replay pattern), including the heel-tab scenario part (3).

**Files:**
- Create: `services/groupFolderV3.ts`
- Test: `services/groupFolderV3.test.ts`

**Interfaces:**
- Consumes: everything above, plus `isolateFolder` (`./isolateSubject`), `embedFolder`/`embedderStatus` (`./visualEmbedding`), `buildContactSheet`/`buildAnchorSheet` (`./contactSheet`), `askAnalysisModel`/`analysisModel`/`isRateLimited` (`./analysisClient`), `mapWithConcurrency` (`./imageUtils`), types from `./productModel`, `structuredOutputEnabled` (`./groupingMode`), `getAiProvider` (`./aiProvider`).
- Produces:

```ts
export interface AskFn {
  (parts: any[], schema: Record<string, unknown>, schemaName: string): Promise<{
    text: string;
    usage: import('./costMeter').Usage | null;
  }>;
}

export async function groupFolderV3(
  images: FolderImage[],
  onProgress?: (progress: GroupingProgress) => void,
  shouldStop?: () => boolean,
  onGroups?: (groups: ProductGroup[]) => void,
  /** Test seam: replaces the network. Production builds its own from the SDK. */
  askOverride?: AskFn,
): Promise<GroupingResult>;

export const UNRESOLVED_REASONS: Record<string, string>; // reason code -> user sentence
```

**Structure of the implementation** (write it in this order inside the file):

```ts
// 1. constants
const IDENTITY_SHEET_PIXELS = 1280;
const ANGLE_CONCURRENCY = 8;

// 2. the real ask, built once per run (mirrors v2's `ask` but returns usage):
const makeAsk = (meter: CostMeter): AskFn => {
  const ai = new GoogleGenAI({
    apiKey: 'proxied',
    httpOptions: { baseUrl: `${window.location.origin}/api/gemini` },
  });
  return async (parts, schema, schemaName) => {
    meter.charge();
    const res = await askAnalysisModel(ai, parts, undefined, {
      temperature: 0,
      ...(structuredOutputEnabled() ? { schema, schemaName } : {}),
    });
    const text = (res?.candidates?.[0]?.content?.parts ?? [])
      .map((p: any) => p.text ?? '').join('');
    return { text, usage: usageOf(analysisModel(), res) };
  };
};

// 3. track A: angle pass on raw scouts
//    - sheets = angleSheets(images.length)
//    - for each sheet: buildContactSheet(sheet.map(i => images[i].scout || images[i].thumb))
//      -> ask(parts, ANGLE_SCHEMA, 'angle_atlas') -> extractJsonArray -> readAngles
//      -> map sheet-local photo numbers back to folder indices
//    - mapWithConcurrency(sheets, ANGLE_CONCURRENCY, ...)
//    - a failed sheet logs and leaves its photos angle-undefined; NEVER blocks
//    - progress: { done, total: sheets.length, phase: 'angles' }

// 4. track B: crop then embed (exactly v2's stages 1-2, same progress phases)
//    const [angleReadings, vectors] = await Promise.all([trackA(), trackB()]);

// 5. join: floors = pairFloors(vectors, angles); pools = buildPools(vectors, angles, new Set());
//    (when embedding failed entirely, fall back to signature distances exactly as
//     v2's neighboursFromSignatures does, feeding buildPools a synthetic vector
//     ranking: reuse the same fallback but build pools from ranked neighbour
//     lists — implement `poolsFromSignatures(signatures, angles, notSame, k)`
//     as a 20-line sibling of buildPools that ranks by visualDistance ascending
//     with the same stratify/cap logic. It lives in candidatePool.ts.)

// 6. waves:
const graph = new LinkGraph(images.map((im) => im.id), (id) => angleById.get(id));
const asked = new Set<number>();            // anchors that got a request
const shownPlausible = new Set<number>();   // anchors shown >=1 candidate with margin > 0
let width = WAVE_WIDTH;
for (;;) {
  if (shouldStop?.()) break;
  const queue = livePools(freshPools(), idOf, graph, marginFn).sort(byPriority);
  if (!queue.length) break;
  const wave = buildWave(queue, width);
  if (!wave.every(() => meter.canSpend())) { /* record blocked reason, break */ }
  const results = await Promise.allSettled(wave.map(runAnchor));
  // runAnchor: buildAnchorSheet([photoOf(anchor), ...live.map(photoOf)], IDENTITY_SHEET_PIXELS)
  //   -> ask(parts, IDENTITY_SCHEMA, 'identity') -> extractJsonArray -> readIdentity
  //   -> for each verdict: graph.add({ a: idOf(anchor), b: idOf(live[photo-1]), ... })
  //   -> track asked/shownPlausible; meter.record(usage)
  // 429 handling: first isRateLimited error -> width = 2, log 'rate limited';
  //   second -> stop the wave loop, remaining anchors go Unresolved 'rate-limited'.
  onGroups?.(buildGroups());  // live preview after every wave
}

// 7. widened net (spec 7): anchors never asked because zero cross-angle
//    candidates existed -> one request each against top-6 raw neighbours
//    (same-angle still excluded), lowest priority, budget permitting.

// 8. classify (spec 10) per single-photo cluster:
//    asked?  every shown candidate answered same:false,sure:true?  pool untruncated?
//    shownPlausible?  reciprocally clean (no other live pool lists it)?
//    -> 'alone' : else 'unresolved' with the FIRST failing reason code:
export const UNRESOLVED_REASONS = {
  'budget': 'the run hit its spending ceiling before this photograph was resolved',
  'rate-limited': 'the provider refused concurrent requests before this photograph was resolved',
  'request-failed': 'the request that covered this photograph failed or was unreadable',
  'hedged': 'the model would not commit about this photograph',
  'no-candidates': 'no cross-angle candidate existed for this photograph',
  'truncated': 'this photograph had more credible candidates than could be shown',
  'weak-only': 'the model only ever rejected implausible matches for this photograph',
  'reciprocal': 'another photograph still lists this one as an open candidate',
} as const;

// 9. buildGroups(): clusters -> ProductGroup[] with:
//    - view/viewSource/colour from angleReadings (view from bucketOf or 'OTHER')
//    - joinedVia from graph.provenanceOf
//    - confidence: 0.9 baseline; any contested member -> min(conf, REVIEW_CONFIDENCE - 0.01)
//      and flagged: true; single unresolved photos -> unassigned + uncertainReasons
//    - category: first non-OTHER reading in the cluster
//    - names/renumber/summarise from productModel
//    - DUPLICATE-ANGLE ASSERTION: walk every group; if two members share a
//      cannot-link bucket, set flagged=true, needsReview=true and log loudly.
//      (Unreachable by construction; checked because an invariant that is not
//      checked is a hope.)
// 10. run log lines: embedder status, pool stats, wave count, meter.summary(),
//     per-stage elapsed ms, and result.spendUsd = meter.spentUsd().
```

- [ ] **Step 1: Write the failing tests.** The test drives `groupFolderV3` entirely through `askOverride` — no network, no canvas (buildContactSheet/buildAnchorSheet return null in vitest, so parts carry separate images; the fake ask ignores parts and answers from a script keyed by request order and schemaName).

```ts
// services/groupFolderV3.test.ts
import { describe, expect, it, vi } from 'vitest';
import { groupFolderV3 } from './groupFolderV3';
import { FolderImage } from './productModel';

vi.mock('./isolateSubject', () => ({
  isolateFolder: async (photos: string[]) => photos.map(() => null),
}));
vi.mock('./visualEmbedding', () => ({
  embedFolder: async () => [],           // overridden per-test below via factory
  embedderStatus: () => ({ ready: false, reason: 'test' }),
}));

// The mock above disables embeddings; tests inject geometry through a second
// factory when needed. For scenario tests it is simpler to let the signature
// fallback rank by folder distance: images are crafted so the fallback order
// is the order we want, OR the test passes vectors via the embed mock:
const image = (id: string): FolderImage =>
  ({ id, fileName: `${id}.jpg`, full: 'AAAA', thumb: 'AAAA', scout: 'AAAA' });

/**
 * Scripted ask. Each call pops the next reply for its schemaName.
 * Replies are the JSON the model would return, as strings.
 */
const scriptedAsk = (script: { angle: string[]; identity: string[] }) => {
  const queues = { angle_atlas: [...script.angle], identity: [...script.identity] };
  const calls: string[] = [];
  const ask = async (_parts: any[], _schema: any, name: string) => {
    calls.push(name);
    const queue = name === 'angle_atlas' ? queues.angle_atlas : queues.identity;
    const text = queue.shift();
    if (text === undefined) throw new Error(`script exhausted for ${name}`);
    return { text, usage: null };
  };
  return { ask, calls };
};

describe('groupFolderV3 end to end (scripted model)', () => {
  it('groups two photos the model joined, leaves the stranger apart', async () => {
    const images = [image('a'), image('b'), image('c')];
    const { ask } = scriptedAsk({
      angle: [JSON.stringify([
        { photo: 0, angle: 'FRONT', category: 'FOOTWEAR', colour: 'black' },
        { photo: 1, angle: 'LEFT', category: 'FOOTWEAR', colour: 'black' },
        { photo: 2, angle: 'BACK', category: 'FOOTWEAR', colour: 'red' },
      ])],
      identity: [
        // one anchor request joins a-b, rejects a-c
        JSON.stringify([
          { photo: 1, same: true, sure: true, because: 'same heel logo' },
          { photo: 2, same: false, sure: true, because: 'red not black' },
        ]),
        // remaining anchors resolve by transitivity/NOT-SAME or answer NONE:
        JSON.stringify([{ photo: 1, same: false, sure: true, because: 'red not black' }]),
      ],
    });
    const result = await groupFolderV3(images, undefined, undefined, undefined, ask);
    expect(result.classified).toBe(true);
    const groupOfA = result.groups.find((g) =>
      g.images.some((im) => im.imageId === 'a'))!;
    expect(groupOfA.images.map((im) => im.imageId).sort()).toEqual(['a', 'b']);
    expect(groupOfA.images.every((im) =>
      im.imageId === 'a' || im.joinedVia !== undefined)).toBe(true);
  });

  it('never asks about a same-angle pair (the invariant reaches the wire)', async () => {
    const images = [image('a'), image('b')];
    const { ask, calls } = scriptedAsk({
      angle: [JSON.stringify([
        { photo: 0, angle: 'FRONT', category: 'FOOTWEAR', colour: 'black' },
        { photo: 1, angle: 'FRONT', category: 'FOOTWEAR', colour: 'black' },
      ])],
      identity: [],   // any identity request would exhaust the script and throw
    });
    const result = await groupFolderV3(images, undefined, undefined, undefined, ask);
    expect(calls.filter((c) => c === 'identity')).toEqual([]);
    expect(result.groups.length + result.unassigned.length).toBeGreaterThan(0);
    // both photos end up apart, unresolved-or-alone but never merged:
    expect(result.groups.every((g) => g.images.length === 1)).toBe(true);
  });

  it('a hedged answer creates no link and lands the pair in review, not a group', async () => {
    const images = [image('a'), image('b')];
    const { ask } = scriptedAsk({
      angle: [JSON.stringify([
        { photo: 0, angle: 'FRONT', category: 'FOOTWEAR', colour: 'black' },
        { photo: 1, angle: 'LEFT', category: 'FOOTWEAR', colour: 'black' },
      ])],
      identity: [
        JSON.stringify([{ photo: 1, same: true, sure: false, because: 'maybe' }]),
        JSON.stringify([{ photo: 1, same: true, sure: false, because: 'maybe' }]),
      ],
    });
    const result = await groupFolderV3(images, undefined, undefined, undefined, ask);
    expect(result.groups.every((g) => g.images.length === 1)).toBe(true);
    expect(result.unassigned.length).toBeGreaterThan(0);
    expect(Object.values(result.uncertainReasons ?? {}).join(' ')).toMatch(/commit/);
  });

  it('a failed identity request leaves photos Unresolved with the reason, never invents groups', async () => {
    const images = [image('a'), image('b')];
    const ask = async (_p: any[], _s: any, name: string) => {
      if (name === 'angle_atlas') {
        return {
          text: JSON.stringify([
            { photo: 0, angle: 'FRONT', category: 'FOOTWEAR', colour: 'black' },
            { photo: 1, angle: 'LEFT', category: 'FOOTWEAR', colour: 'black' },
          ]),
          usage: null,
        };
      }
      throw new Error('boom 500');
    };
    const result = await groupFolderV3(images, undefined, undefined, undefined, ask);
    expect(result.groups.every((g) => g.images.length === 1)).toBe(true);
    expect(result.unassigned).toContain('a');
  });

  it('is deterministic: the same script produces identical output twice', async () => {
    const images = [image('a'), image('b'), image('c')];
    const script = {
      angle: [JSON.stringify([
        { photo: 0, angle: 'FRONT', category: 'FOOTWEAR', colour: 'black' },
        { photo: 1, angle: 'LEFT', category: 'FOOTWEAR', colour: 'black' },
        { photo: 2, angle: 'BACK', category: 'FOOTWEAR', colour: 'black' },
      ])],
      identity: [
        JSON.stringify([
          { photo: 1, same: true, sure: true, because: 'same logo' },
          { photo: 2, same: true, sure: true, because: 'same logo' },
        ]),
      ],
    };
    const one = await groupFolderV3(images, undefined, undefined, undefined,
      scriptedAsk(structuredClone(script)).ask);
    const two = await groupFolderV3(images, undefined, undefined, undefined,
      scriptedAsk(structuredClone(script)).ask);
    expect(one.groups).toEqual(two.groups);
    expect(one.unassigned).toEqual(two.unassigned);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run services/groupFolderV3.test.ts`
Expected: FAIL — cannot resolve `./groupFolderV3`.

- [ ] **Step 3: Implement `services/groupFolderV3.ts`** following the numbered structure in the Interfaces block above. Also add `poolsFromSignatures` to `services/candidatePool.ts` (same stratify/cap logic, ranked by `visualDistance` ascending — mirror `buildPools` with the comparator flipped, ~20 lines, plus one test in `candidatePool.test.ts` asserting same-angle exclusion holds there too).

Key details the tests force:
- Identity requests are only issued for anchors with live candidates (test 2 proves same-angle pools are empty and no identity call happens).
- Wave loop reads its script sequentially — with WAVE_WIDTH ≥ queue length the whole first round goes out in one wave; keep `runAnchor` consuming replies in wave order (`mapWithConcurrency(wave, wave.length, ...)` preserves index order for the scripted ask).
- On any anchor whose request throws: mark that anchor's photos `request-failed` unless later resolved; continue other anchors; `isRateLimited` errors adjust width as described.
- `classified: true` whenever the angle pass produced anything; a run where EVERY request failed returns `classified: false` with the error (v2's rule).

- [ ] **Step 4: Run the tests, then the whole suite**

Run: `npx vitest run services/groupFolderV3.test.ts` — Expected: PASS.
Run: `npm test` — Expected: no regressions.
Run: `npm run lint` — Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add services/groupFolderV3.ts services/groupFolderV3.test.ts services/candidatePool.ts services/candidatePool.test.ts
git commit -m "feat: groupFolderV3 orchestrator - parallel tracks, waves, classify, run log"
```

---

### Task 11: Heel-tab end-to-end regression + replay fixture format

Spec §15's regression part (3): with replayed answers, A-FRONT + A-LEFT group; B-FRONT stays out. Plus the fixture-recording seam for real folders.

**Files:**
- Create: `services/replayLog.ts`
- Test: `services/groupingV3.scenarios.test.ts`

**Interfaces:**
- Produces (`replayLog.ts`):

```ts
export interface RecordedCall { schemaName: string; reply: string }

/** Wraps an AskFn; pushes every call/reply pair into `sink`. */
export const recordingAsk = (inner: AskFn, sink: RecordedCall[]): AskFn;

/** An AskFn that replays a recording; throws when the recording runs out. */
export const replayingAsk = (recording: RecordedCall[]): AskFn;

/** Serialize/parse a recording for saving to a JSON fixture file. */
export const dumpRecording = (calls: RecordedCall[]): string;
export const loadRecording = (json: string): RecordedCall[];
```

- Consumes: `AskFn` from Task 10.
- Wire-up: in `groupFolderV3`, when `new URLSearchParams(window.location.search).get('record') === 'on'`, wrap the real ask with `recordingAsk` and, at the end of the run, `console.log(dumpRecording(...))` and stash it on `window.__grouping_recording` so a real folder's answers can be copy-pasted into a fixture. Guard every `window` access with `typeof window !== 'undefined'`.

- [ ] **Step 1: Write the failing tests**

```ts
// services/groupingV3.scenarios.test.ts
import { describe, expect, it, vi } from 'vitest';
import { groupFolderV3 } from './groupFolderV3';
import { loadRecording, replayingAsk, recordingAsk, dumpRecording } from './replayLog';
import { FolderImage } from './productModel';

vi.mock('./isolateSubject', () => ({
  isolateFolder: async (photos: string[]) => photos.map(() => null),
}));
vi.mock('./visualEmbedding', () => ({
  embedFolder: async () => [],
  embedderStatus: () => ({ ready: false, reason: 'test' }),
}));

const image = (id: string): FolderImage =>
  ({ id, fileName: `${id}.jpg`, full: 'AAAA', thumb: 'AAAA', scout: 'AAAA' });

describe('HEEL-TAB SCENARIO, end to end (spec sections 6 and 15)', () => {
  // Folder: A-FRONT, B-FRONT (different product, near-identical), A-LEFT.
  // The recording holds the answers a correct model gives when asked the
  // questions this pipeline is allowed to ask. If the pipeline ever asks a
  // same-angle question, or fails to ask about A-FRONT/A-LEFT, the replay
  // exhausts or the grouping comes out wrong - either way the test fails.
  const recording = loadRecording(JSON.stringify([
    {
      schemaName: 'angle_atlas',
      reply: JSON.stringify([
        { photo: 0, angle: 'FRONT', category: 'FOOTWEAR', colour: 'black white' },
        { photo: 1, angle: 'FRONT', category: 'FOOTWEAR', colour: 'black' },
        { photo: 2, angle: 'LEFT', category: 'FOOTWEAR', colour: 'black white' },
      ]),
    },
    {
      schemaName: 'identity',
      reply: JSON.stringify([
        { photo: 1, same: true, sure: true, because: 'same white heel tab' },
      ]),
    },
    {
      schemaName: 'identity',
      reply: JSON.stringify([
        { photo: 1, same: false, sure: true, because: 'white heel tab vs black' },
      ]),
    },
  ]));

  it('groups A-FRONT with A-LEFT and keeps B-FRONT out', async () => {
    const images = [image('aFront'), image('bFront'), image('aLeft')];
    const result = await groupFolderV3(
      images, undefined, undefined, undefined, replayingAsk([...recording])
    );
    const groupOfA = result.groups.find((g) =>
      g.images.some((im) => im.imageId === 'aFront'))!;
    const members = groupOfA.images.map((im) => im.imageId).sort();
    expect(members).toEqual(['aFront', 'aLeft']);
    expect(members).not.toContain('bFront');
  });

  it('no group ever holds two FRONTs, whatever the replay says', async () => {
    // Adversarial recording: the "model" insists the two FRONTs are the same.
    const hostile = [
      recording[0],
      {
        schemaName: 'identity',
        reply: JSON.stringify([
          { photo: 1, same: true, sure: true, because: 'they look identical' },
        ]),
      },
    ];
    const images = [image('aFront'), image('bFront'), image('aLeft')];
    const result = await groupFolderV3(
      images, undefined, undefined, undefined, replayingAsk(hostile as any)
    );
    result.groups.forEach((group) => {
      const fronts = group.images.filter((im) => im.view === 'FRONT');
      expect(fronts.length).toBeLessThanOrEqual(1);
    });
  });
});

describe('replay round-trip', () => {
  it('records, dumps, loads and replays identically', async () => {
    const sink: any[] = [];
    const fake = async () => ({ text: '[{"photo":1,"same":false,"sure":true}]', usage: null });
    const recorder = recordingAsk(fake as any, sink);
    await recorder([], {}, 'identity');
    const replayed = replayingAsk(loadRecording(dumpRecording(sink)));
    const { text } = await replayed([], {}, 'identity');
    expect(text).toBe('[{"photo":1,"same":false,"sure":true}]');
  });
  it('an exhausted replay throws rather than inventing an answer', async () => {
    const replayed = replayingAsk([]);
    await expect(replayed([], {}, 'identity')).rejects.toThrow(/exhausted/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run services/groupingV3.scenarios.test.ts`
Expected: FAIL — cannot resolve `./replayLog`.

- [ ] **Step 3: Implement `services/replayLog.ts`**

```ts
import { AskFn } from './groupFolderV3';

export interface RecordedCall { schemaName: string; reply: string }

export const recordingAsk = (inner: AskFn, sink: RecordedCall[]): AskFn =>
  async (parts, schema, schemaName) => {
    const result = await inner(parts, schema, schemaName);
    sink.push({ schemaName, reply: result.text });
    return result;
  };

export const replayingAsk = (recording: RecordedCall[]): AskFn => {
  const queue = [...recording];
  return async (_parts, _schema, schemaName) => {
    const next = queue.find((call) => call.schemaName === schemaName);
    if (!next) throw new Error(`replay exhausted for ${schemaName}`);
    queue.splice(queue.indexOf(next), 1);
    return { text: next.reply, usage: null };
  };
};

export const dumpRecording = (calls: RecordedCall[]): string =>
  JSON.stringify(calls, null, 2);

export const loadRecording = (json: string): RecordedCall[] => {
  const parsed = JSON.parse(json);
  if (!Array.isArray(parsed)) throw new Error('a recording is a JSON array');
  return parsed.map((entry) => ({
    schemaName: String(entry.schemaName),
    reply: String(entry.reply),
  }));
};
```

Then wire `?record=on` into `groupFolderV3` as described in Interfaces.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run services/groupingV3.scenarios.test.ts`
Expected: PASS — including the adversarial-replay invariant test.

- [ ] **Step 5: Commit**

```bash
git add services/replayLog.ts services/groupingV3.scenarios.test.ts services/groupFolderV3.ts
git commit -m "test: heel-tab end-to-end regression; replay recording seam"
```

---

### Task 12: Worker-pool cropping and SigLIP preload

Runtime work (spec §12): cropping to Web Workers; model download starts at app start.

**Files:**
- Create: `services/cropWorker.ts` (worker entry)
- Modify: `services/isolateSubject.ts` (add `isolateFolderParallel`, keep `isolateFolder` untouched as the fallback)
- Modify: `App.tsx` (preload effect)
- Modify: `services/groupFolderV3.ts` (call `isolateFolderParallel`)
- Test: `services/isolateSubject.test.ts` (extend)

**Interfaces:**
- Produces (`cropWorker.ts` — module worker):

```ts
// Receives { photo: string, maxEdge: number, seq: number },
// posts back { seq: number, cropped: string | null }.
import { isolateSubject } from './isolateSubject';
self.onmessage = async (event: MessageEvent) => {
  const { photo, maxEdge, seq } = event.data;
  let cropped: string | null = null;
  try {
    cropped = await isolateSubject(photo, maxEdge);
  } catch { /* refuse rather than guess: null means use the original */ }
  (self as any).postMessage({ seq, cropped });
};
```

- Produces (`isolateSubject.ts` addition):

```ts
/**
 * isolateFolder on a pool of module workers - real parallelism across cores.
 * Falls back to the single-threaded isolateFolder wherever Worker or
 * OffscreenCanvas is unavailable (vitest, old browsers), so behaviour is
 * identical and only the wall-clock changes.
 */
export const isolateFolderParallel = async (
  photos: string[],
  onProgress?: (done: number, total: number) => void,
  shouldStop?: () => boolean,
  maxEdge?: number,
): Promise<(string | null)[]>;
```

Implementation notes: pool size `Math.min(4, Math.max(1, (navigator.hardwareConcurrency || 2) - 1))`; create workers with `new Worker(new URL('./cropWorker.ts', import.meta.url), { type: 'module' })`; feed jobs round-robin, resolve by `seq`; terminate all workers in a `finally`; ANY worker construction/message error → log once and run the remaining photos through plain `isolateFolder`.

- Modify `App.tsx`: one effect at mount —

```ts
useEffect(() => {
  // Fire-and-forget: begin the ~100MB SigLIP download while the user is
  // still choosing a folder, so grouping never waits on it (spec 12.1).
  import('./services/visualEmbedding').then(({ embedderReady }) => {
    embedderReady().catch(() => {});
  });
}, []);
```

- [ ] **Step 1: Write the failing test** (fallback path only — vitest has no Worker):

```ts
// append to services/isolateSubject.test.ts
import { isolateFolderParallel } from './isolateSubject';

describe('isolateFolderParallel', () => {
  it('falls back to the serial path where Worker is unavailable and preserves order', async () => {
    // vitest/node: no Worker, no canvas -> every crop refuses to null,
    // which is exactly what serial isolateFolder does.
    const out = await isolateFolderParallel(['AAAA', 'BBBB', 'CCCC']);
    expect(out).toEqual([null, null, null]);
  });
  it('honours shouldStop by returning what it has', async () => {
    const out = await isolateFolderParallel(['AAAA', 'BBBB'], undefined, () => true);
    expect(out.length).toBe(2);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run services/isolateSubject.test.ts`
Expected: FAIL — `isolateFolderParallel` is not exported.

- [ ] **Step 3: Implement** `cropWorker.ts`, `isolateFolderParallel`, the `App.tsx` preload effect, and switch `groupFolderV3.ts` from `isolateFolder` to `isolateFolderParallel`.

- [ ] **Step 4: Run tests, lint, and a manual smoke**

Run: `npx vitest run services/isolateSubject.test.ts` — Expected: PASS.
Run: `npm run lint` — Expected: clean.
Run: `npm run dev`, open the app, watch the network tab: SigLIP files start downloading at page load, before any folder is chosen.

- [ ] **Step 5: Commit**

```bash
git add services/cropWorker.ts services/isolateSubject.ts services/isolateSubject.test.ts App.tsx services/groupFolderV3.ts
git commit -m "perf: crop on a worker pool; preload SigLIP at app start"
```

---

### Task 13: Wire v3 into the UI

Mode `'v3'` (new default), pipeline switch, provenance and reasons on the review screen, duplicate-angle assertion display.

**Files:**
- Modify: `services/groupingMode.ts`
- Modify: `components/TryOnTool.tsx` (~lines 855-865)
- Modify: `components/ProductGroupReview.tsx`
- Test: `services/groupingMode.test.ts` (create, small)

**Interfaces:**
- `groupingMode.ts`: `GroupingMode` becomes `'v1' | 'v2' | 'v3'`; `DEFAULT_MODE = 'v3'`; `isMode` accepts all three; `describeMode('v3')` → `'angle-constrained grouping — cannot-link plus targeted identity questions'`.
- `TryOnTool.tsx`:

```ts
const mode = groupingMode();
const sort = mode === 'v3' ? groupFolderV3 : mode === 'v2' ? groupFolderV2 : groupFolder;
```

- `ProductGroupReview.tsx` additions (all display-only):
  - Under each thumbnail with `joinedVia`: `joined to <n> — "<because>"` for direct, `connected through <n> (never compared directly)` for indirect (`hops > 1`).
  - Uncertain tray: each unassigned photo shows `uncertainReasons[imageId]` when present.
  - Group header: if any two images share a `view` in FRONT/BACK/LEFT/RIGHT/TOP/SOLE, render a red "duplicate angle — impossible grouping, report this" banner (the checked invariant).
  - Progress phase `'angles'` label: `'Reading angles…'` wherever the other phases get labels.

- [ ] **Step 1: Write the failing test**

```ts
// services/groupingMode.test.ts
import { describe, expect, it } from 'vitest';
import { DEFAULT_MODE, describeMode } from './groupingMode';

describe('grouping mode v3', () => {
  it('defaults to v3', () => {
    expect(DEFAULT_MODE).toBe('v3');
  });
  it('describes all three modes distinctly', () => {
    const names = ['v1', 'v2', 'v3'].map((m) => describeMode(m as any));
    expect(new Set(names).size).toBe(3);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run services/groupingMode.test.ts`
Expected: FAIL — DEFAULT_MODE is 'v2'.

- [ ] **Step 3: Implement** the four file changes above.

- [ ] **Step 4: Verify**

Run: `npx vitest run services/groupingMode.test.ts` — Expected: PASS.
Run: `npm test` — Expected: all green.
Run: `npm run lint` — Expected: clean.
Run: `npm run dev`, load a small folder (6-10 photos), confirm: angle labels appear, groups form, provenance lines render, uncertain tray shows reasons, run log shows the meter summary.

- [ ] **Step 5: Commit**

```bash
git add services/groupingMode.ts services/groupingMode.test.ts components/TryOnTool.tsx components/ProductGroupReview.tsx
git commit -m "feat: wire angle-constrained v3 pipeline into the UI as the default mode"
```

---

### Task 14: First real-folder run and calibration report

Not a code task — the validation gate the spec demands before v1/v2 may ever be retired. Produces numbers, not vibes.

**Files:**
- Modify: `services/groupFolderV3.ts` only if the run log lacks any figure below.

- [ ] **Step 1:** Fill `RATES` in `services/costMeter.ts` with the real per-token prices from the provider dashboard (the user supplies them; do not guess). Commit separately: `chore: configure model rates for the cost meter`.

- [ ] **Step 2:** Run the real ~110-photo folder with `?record=on`. Save `window.__grouping_recording` to `docs/superpowers/fixtures/first-run-recording.json` (create the directory).

- [ ] **Step 3:** Report to the user, from the run log: total requests, spend, wall-clock per stage, group count, unassigned count with reason histogram, the per-angle-pair floor values alongside the cross-angle candidate cosines (spec §17 says this assumption must be *checked*), and whether any duplicate-angle banner appeared (must be zero).

- [ ] **Step 4:** Only after the user judges the result against v2 on the same folder: a follow-up branch may retire `groupFolderV2.ts`, `neighbourGraph.ts`, `signedGraph.ts`, `visualJudge.ts`, `photoClustering.ts`, `productFingerprint.ts` and their tests. NOT part of this plan.

---

## Self-review notes

- Spec coverage: §2-§10 → Tasks 4, 5, 7, 8, 10; §8.1 → Task 4; §8.2/8.3 → Tasks 6, 7; §11 → Task 3; §12 → Tasks 10 (waves), 12 (workers, preload); §13 degradation → Tasks 10, 12 fallbacks; §14 review screen → Task 13; §15 tests → distributed, heel-tab in Tasks 5 and 11, fuzz in Task 8, determinism in Tasks 5, 9, 10; §16 files → all present (orchestrator named `groupFolderV3.ts` because v1 already exports a `groupFolder` function); §17 floor-check reporting → Task 14.
- Wave-overhead ≤25% comparison test (spec §15) deliberately deferred: it needs a serial-scheduler reference implementation that exists nowhere else. Guarded instead by the request fuse and Task 14's real-folder request count. If Task 14 shows overhead, add the reference then.
- Type consistency: `AskFn` defined once (Task 10), consumed by Task 11; `Pool` (Task 5) consumed by Tasks 9-10; `Link`/`LinkGraph` (Task 8) by Tasks 9-11; `bucketOf` (Task 4) by Tasks 5, 8.
