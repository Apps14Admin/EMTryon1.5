/**
 * THE ANGLE-CONSTRAINED PIPELINE, TIED TOGETHER.
 *
 * Two tracks start at t=0 and owe each other nothing until the join:
 *
 *   TRACK A (angles)   raw scout thumbnails, ~8 concurrent requests, never
 *                       blocks on the crop or the embedder.
 *   TRACK B (vectors)  crop locally, then embed locally, both free.
 *
 * JOIN turns angles + vectors into stratified candidate pools (cannot-link
 * absolute, the floor never prunes — see candidatePool.ts), and the WAVE
 * LOOP asks the model about disjoint anchors a handful at a time, applying
 * every answer to a constrained union-find before the next wave is built.
 * See docs/superpowers/specs/2026-08-30-angle-constrained-product-grouping-design.md
 * sections 4, 7 and 10 for the shape this file exists to implement.
 */

import { GoogleGenAI } from '@google/genai';
import {
  FolderImage,
  GroupedImage,
  GroupingProgress,
  GroupingResult,
  ProductGroup,
  REVIEW_CONFIDENCE,
  VIEW_NAMES,
  ViewName,
  Category,
  groupLabel,
  renumber,
} from './productModel';
import { askAnalysisModel, analysisModel, isRateLimited } from './analysisClient';
import { extractJsonArray } from './jsonReply';
import { CostMeter, Usage, usageOf } from './costMeter';
import {
  ANGLE_SCHEMA,
  anglePrompt,
  readAngles,
  angleSheets,
  bucketOf,
} from './angleAtlas';
import {
  Pool,
  buildPools,
  poolsFromSignatures,
  pairFloors,
  floorOf,
  marginOf,
  cosine,
  pairKey,
} from './candidatePool';
import { buildContactSheet, buildAnchorSheet } from './contactSheet';
import { IDENTITY_SCHEMA, identityPrompt, readIdentity } from './identityQuestion';
import {
  COHERENCE_MIN_GROUP,
  COHERENCE_SCHEMA,
  coherencePrompt,
  readCoherence,
  partitionByVerdicts,
} from './coherenceCheck';
import { LinkGraph } from './linkGraph';
import { WAVE_WIDTH, livePools, byPriority, buildWave, LivePool } from './waveScheduler';
import { mapWithConcurrency } from './imageUtils';
import { isolateFolderParallel } from './isolateSubject';
import { embedFolder, embedderStatus } from './visualEmbedding';
import { signatureOf, visualDistance, Signature } from './imageSignature';
import { structuredOutputEnabled } from './groupingMode';
import { recordingAsk, dumpRecording, RecordedCall } from './replayLog';

// --- 1. constants -----------------------------------------------------------

const IDENTITY_SHEET_PIXELS = 1280;
const ANGLE_CONCURRENCY = 8;
const WIDENED_NET_K = 6;

/**
 * Change C. User-confirmed dataset guarantee: every product in a folder has
 * AT LEAST TWO photographs. When true, the 'alone' classification (a
 * single-photo cluster confidently presented as its own product) is
 * disabled - a single is always a recall failure, never a product, so it is
 * surfaced as an 'orphan' for review instead of hidden inside a confident
 * one-photo group.
 */
export const NO_SINGLE_PHOTO_PRODUCTS = true;

export interface AskFn {
  (parts: any[], schema: Record<string, unknown>, schemaName: string): Promise<{
    text: string;
    usage: Usage | null;
  }>;
}

/** reason code -> the sentence shown to the user in the Uncertain tray. */
export const UNRESOLVED_REASONS: Record<string, string> = {
  budget: 'the run hit its spending ceiling before this photograph was resolved',
  'rate-limited': 'the provider refused concurrent requests before this photograph was resolved',
  'request-failed': 'the request that covered this photograph failed or was unreadable',
  hedged: 'the model would not commit about this photograph',
  'no-candidates': 'no cross-angle candidate existed for this photograph',
  truncated: 'this photograph had more credible candidates than could be shown',
  'weak-only': 'the model only ever rejected implausible matches for this photograph',
  reciprocal: 'another photograph still lists this one as an open candidate',
  orphan: 'every product in this folder has at least two photographs — no partner was found for this one',
};

type UnresolvedReason = keyof typeof UNRESOLVED_REASONS;

const describeError = (err: unknown): string => {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return 'the request failed';
};

const textOf = (res: any): string =>
  (res?.candidates?.[0]?.content?.parts ?? [])
    .map((part: any) => part.text ?? '')
    .join('');

/**
 * `?record=on` — grabs a real folder's answers so they can be replayed
 * offline. Guarded: `window` does not exist under vitest, and a browser with
 * search access blocked must not crash the run over a debug flag.
 */
const recordOn = (): boolean => {
  if (typeof window === 'undefined') return false;
  try {
    return new URLSearchParams(window.location.search).get('record') === 'on';
  } catch {
    return false;
  }
};

// --- 2. the real ask, built once per run ------------------------------------

const makeAsk = (): AskFn => {
  const ai = new GoogleGenAI({
    apiKey: 'proxied',
    httpOptions: { baseUrl: `${window.location.origin}/api/gemini` },
  });
  return async (parts, schema, schemaName) => {
    const res = await askAnalysisModel(ai, parts, undefined, {
      temperature: 0,
      ...(structuredOutputEnabled() ? { schema, schemaName } : {}),
    });
    return { text: textOf(res), usage: usageOf(analysisModel(), res) };
  };
};

export async function groupFolderV3(
  images: FolderImage[],
  onProgress?: (progress: GroupingProgress) => void,
  shouldStop?: () => boolean,
  onGroups?: (groups: ProductGroup[]) => void,
  /** Test seam: replaces the network. Production builds its own from the SDK. */
  askOverride?: AskFn,
): Promise<GroupingResult> {
  const log: string[] = [];
  if (!images.length) return { groups: [], unassigned: [], classified: true, log };

  const meter = new CostMeter();
  const baseAsk: AskFn = askOverride ?? makeAsk();
  const recording: RecordedCall[] = [];
  const ask: AskFn = recordOn() ? recordingAsk(baseAsk, recording) : baseAsk;

  const indexOfId = new Map(images.map((im, i) => [im.id, i]));
  const idOf = (i: number) => images[i].id;

  // --- track A: angle pass, on the raw scout thumbnails ---------------------
  //
  // Legible in an uncropped thumbnail — background removal helps identity
  // judgements, not orientation ones — so this track waits for neither the
  // crop nor the embedder (spec section 4).

  const anglesByIndex: (string | undefined)[] = new Array(images.length).fill(undefined);
  const categoryByIndex: (string | undefined)[] = new Array(images.length).fill(undefined);
  const colourByIndex: (string | undefined)[] = new Array(images.length).fill(undefined);
  let angleError: string | undefined;
  let anyAngleReading = false;

  const trackA = async (): Promise<void> => {
    const sheets = angleSheets(images.length);
    let done = 0;
    onProgress?.({ done: 0, total: sheets.length, phase: 'angles' });

    await mapWithConcurrency(sheets, ANGLE_CONCURRENCY, async (sheet) => {
      if (shouldStop?.()) return;
      try {
        const photos = sheet.map((i) => images[i].scout || images[i].thumb);
        const composite = await buildContactSheet(photos);
        const parts: any[] = [];
        if (composite) {
          parts.push({ inlineData: { mimeType: 'image/jpeg', data: composite } });
        } else {
          photos.forEach((p) => parts.push({ inlineData: { mimeType: 'image/jpeg', data: p } }));
        }
        parts.push({ text: anglePrompt(sheet.length) });

        meter.charge();
        const { text, usage } = await ask(parts, ANGLE_SCHEMA, 'angle_atlas');
        meter.record(usage);

        const entries = extractJsonArray(text);
        if (!entries) {
          log.push(`angle sheet [${sheet[0]}..${sheet[sheet.length - 1]}] came back unreadable`);
          if (!angleError) angleError = 'the angle pass came back unreadable';
          return;
        }
        const readings = readAngles(entries, sheet.length);
        if (readings.length) anyAngleReading = true;
        readings.forEach((reading) => {
          const folderIndex = sheet[reading.photo];
          if (folderIndex === undefined) return;
          anglesByIndex[folderIndex] = reading.angle;
          categoryByIndex[folderIndex] = reading.category;
          colourByIndex[folderIndex] = reading.colour;
        });
      } catch (err) {
        // A failed sheet leaves its photos angle-undefined. Never blocks.
        log.push(`angle sheet [${sheet[0]}..${sheet[sheet.length - 1]}] failed: ${describeError(err)}`);
        if (!angleError) angleError = describeError(err);
      } finally {
        done += 1;
        onProgress?.({ done, total: sheets.length, phase: 'angles' });
      }
    });
  };

  // --- track B: crop then embed, exactly v2's stages 1-2 --------------------
  //
  // Cropping is shared between what the wave loop sends the model and what
  // gets embedded, so it runs once, ahead of the embed step.

  const croppedPhotos = await isolateFolderParallel(
    images.map((im) => im.full || im.scout || im.thumb),
    (done, total) => onProgress?.({ done, total, phase: 'preparing' }),
    shouldStop
  );
  const fullOf = (i: number) => images[i].full || images[i].scout || images[i].thumb;
  /** What every later stage actually looks at: the crop where there is one. */
  const photoOf = (i: number) => croppedPhotos[i] ?? fullOf(i);

  let vectors: (Float32Array | null)[] = [];
  let signatures: (Signature | null)[] = [];
  let usingSignatures = false;

  const trackB = async (): Promise<void> => {
    vectors = await embedFolder(
      images.map((_, i) => photoOf(i)),
      (done, total) => onProgress?.({ done, total, phase: 'reading' }),
      shouldStop,
      ({ loaded, total }) =>
        onProgress?.({
          done: Math.round(loaded / 1e6),
          total: Math.round(total / 1e6),
          phase: 'loading',
          unit: 'mb',
        })
    );

    const embedded = vectors.filter(Boolean).length;
    if (embedded < 2) {
      // No usable embedding. Fall back to the cheap signatures rather than
      // ever treating "every cross-angle pair" as a candidate — spec 13.
      usingSignatures = true;
      signatures = await mapWithConcurrency(images, 6, (_, i) => signatureOf(photoOf(i)));
    }
  };

  await Promise.all([trackA(), trackB()]);

  if (shouldStop?.()) {
    return {
      groups: [],
      unassigned: images.map((im) => im.id),
      classified: anyAngleReading,
      stopped: true,
      log,
      spendUsd: meter.spentUsd(),
    };
  }

  const status = embedderStatus();
  log.push(
    usingSignatures
      ? `The local image model was unavailable${status.reason ? ` (${status.reason})` : ''}; ` +
          `falling back to thumbnail signatures for candidate ranking.`
      : `Embedded ${vectors.filter(Boolean).length} of ${images.length} photograph(s) locally ` +
          `on ${status.backend ?? 'this machine'}.`
  );

  if (!anyAngleReading) {
    // Every request in the angle pass failed. Never turned into one product
    // per photograph — that would hide the real problem behind a grouping
    // that is confidently wrong (spec 13, v2's rule).
    return {
      groups: [],
      unassigned: [],
      classified: false,
      error: angleError ?? 'every angle request failed',
      log,
      spendUsd: meter.spentUsd(),
    };
  }

  // --- join: floors + pools ---------------------------------------------------

  const floors = usingSignatures ? new Map<string, number>() : pairFloors(vectors, anglesByIndex);

  const notSameIdx = new Set<string>();
  // R4/A2: consumed when the request covering a pair COMPLETES or THROWS.
  // DIRECTIONAL - keyed `${anchorIdx}->${candIdx}` - because a merge now
  // needs two votes anchored from different members (Change A), and a
  // symmetric "asked" set would let one side's question silently consume
  // the other side's chance to ever ask its own. Recomputing pools each
  // round against this (plus NOT-SAME) is what terminates the wave loop on
  // hedged/failed answers.
  const askedPairs = new Set<string>();
  const askedKey = (anchor: number, candidate: number): string => `${anchor}->${candidate}`;

  const freshPools = (): Pool[] => {
    const pools = usingSignatures
      ? poolsFromSignatures(signatures, anglesByIndex, notSameIdx)
      : buildPools(vectors, anglesByIndex, notSameIdx);
    // Directional asked-filter: a candidate drops out of THIS anchor's pool
    // only once THIS anchor has asked about it. The reverse direction - the
    // candidate itself anchoring a question that includes this anchor -
    // still needs its own ask; that is how B's own anchor question ends up
    // providing the second vote for free (spec A2).
    return pools.map((pool) => ({
      ...pool,
      candidates: pool.candidates.filter((c) => !askedPairs.has(askedKey(pool.anchor, c))),
    }));
  };

  const plausibility = (anchor: number, candidate: number): 'above' | 'below' | 'no-floor' => {
    if (usingSignatures) return 'no-floor';
    const va = vectors[anchor];
    const vb = vectors[candidate];
    if (!va || !vb) return 'no-floor';
    const floor = floorOf(floors, anglesByIndex[anchor], anglesByIndex[candidate]);
    if (floor === null) return 'no-floor';
    return cosine(va, vb) > floor ? 'above' : 'below';
  };

  const marginFn = (anchor: number, candidate: number): number => {
    if (usingSignatures) return -visualDistance(signatures[anchor], signatures[candidate]);
    const va = vectors[anchor];
    const vb = vectors[candidate];
    if (!va || !vb) return -Infinity;
    return marginOf(cosine(va, vb), floorOf(floors, anglesByIndex[anchor], anglesByIndex[candidate]));
  };

  const graph = new LinkGraph(images.map((im) => im.id), (id) => anglesByIndex[indexOfId.get(id)!]);

  // --- bookkeeping the wave loop and classify (spec 10) share ----------------

  const requestedAnchors = new Set<number>();
  const failedAnchors = new Set<number>();
  const rateLimitedAnchors = new Set<number>();
  const budgetBlockedAnchors = new Set<number>();
  const hedgedIdx = new Set<number>();
  const shownPlausibleAnchors = new Set<number>();
  const truncatedByAnchor = new Map<number, boolean>();

  let waveCount = 0;

  // --- group building: shared by the live preview and the final result ------

  const contestedIds = (): Set<string> => {
    const out = new Set<string>();
    graph.contested().forEach((pair) => pair.split(' ').forEach((id) => out.add(id)));
    return out;
  };

  const buildGroupFor = (memberIds: string[]): ProductGroup => {
    const provenance = memberIds.length > 1 ? graph.provenanceOf(memberIds[0]) : new Map();
    const contestedSet = contestedIds();
    const touched = memberIds.some((id) => contestedSet.has(id));

    const groupedImages: GroupedImage[] = memberIds.map((id, idx) => {
      const i = indexOfId.get(id)!;
      const angle = anglesByIndex[i];
      const view: ViewName =
        angle && VIEW_NAMES.includes(angle as ViewName) ? (angle as ViewName) : 'OTHER';
      const viewSource: 'model' | 'fallback' = angle ? 'model' : 'fallback';

      let joinedVia: GroupedImage['joinedVia'];
      if (idx > 0) {
        const entry = provenance.get(id);
        if (entry) {
          const indirect = !!entry.hops && entry.hops > 1;
          joinedVia = indirect
            ? { to: entry.to, kind: 'indirect', hops: entry.hops }
            : { to: entry.to, kind: 'direct', because: entry.because };
        }
      }

      return { imageId: id, view, viewSource, colour: colourByIndex[i], joinedVia };
    });

    const category = (memberIds
      .map((id) => categoryByIndex[indexOfId.get(id)!])
      .find((c) => c && c !== 'OTHER') ?? 'OTHER') as Category;
    const colour = memberIds.map((id) => colourByIndex[indexOfId.get(id)!]).find(Boolean);

    return {
      id: 'tmp',
      name: groupLabel(0),
      category,
      colour,
      images: groupedImages,
      confidence: touched ? Math.min(0.9, REVIEW_CONFIDENCE - 0.01) : 0.9,
      needsReview: touched,
      flagged: touched,
    };
  };

  /** Cheap live preview: multi-photo clusters only, no classify pass. */
  const previewGroups = (): ProductGroup[] =>
    renumber(graph.clusters().filter((c) => c.length >= 2).map((c) => buildGroupFor(c)));

  // --- the identity request itself, shared by waves and the widened net -----

  const applyVerdicts = (anchor: number, live: number[], text: string): void => {
    live.forEach((c) => {
      if (plausibility(anchor, c) === 'above') shownPlausibleAnchors.add(anchor);
    });

    const entries = extractJsonArray(text);
    if (!entries) {
      failedAnchors.add(anchor);
      log.push(`identity reply for photo ${anchor} could not be read`);
      return;
    }

    readIdentity(entries, live.length).forEach((verdict) => {
      const candIdx = live[verdict.photo - 1];
      if (candIdx === undefined) return;

      graph.add({
        a: idOf(anchor),
        b: idOf(candIdx),
        same: verdict.same,
        sure: verdict.sure,
        because: verdict.because,
        anchor: idOf(anchor),
        requestId: `req-${anchor}-w${waveCount}`,
      });

      if (verdict.same === false && verdict.sure === true) {
        notSameIdx.add(pairKey(anchor, candIdx));
      }
      if (verdict.same === true && verdict.sure === false) {
        hedgedIdx.add(anchor);
        hedgedIdx.add(candIdx);
      }
    });
  };

  const runAnchor = async (lp: LivePool): Promise<void> => {
    const { anchor, live } = lp;
    requestedAnchors.add(anchor);
    try {
      const photos = [photoOf(anchor), ...live.map(photoOf)];
      const composite = await buildAnchorSheet(photos, IDENTITY_SHEET_PIXELS);
      const parts: any[] = [];
      if (composite) {
        parts.push({ inlineData: { mimeType: 'image/jpeg', data: composite } });
      } else {
        photos.forEach((p) => parts.push({ inlineData: { mimeType: 'image/jpeg', data: p } }));
      }
      parts.push({ text: identityPrompt(live.length) });

      meter.charge();
      const { text, usage } = await ask(parts, IDENTITY_SCHEMA, 'identity');
      meter.record(usage);

      applyVerdicts(anchor, live, text);
    } finally {
      // Consumed whether the request completed or threw — see R4/A2 above.
      // Directional: only THIS anchor's question about each candidate is
      // marked asked.
      live.forEach((c) => askedPairs.add(askedKey(anchor, c)));
    }
  };

  // --- 6. waves ---------------------------------------------------------

  let width = WAVE_WIDTH;
  let rateLimitStrikes = 0;

  for (;;) {
    if (shouldStop?.()) break;

    const rawPools = freshPools();
    rawPools.forEach((p) => truncatedByAnchor.set(p.anchor, p.truncated));

    const queue = livePools(rawPools, idOf, graph, marginFn).sort(byPriority);
    if (!queue.length) break;

    if (!meter.canSpend()) {
      const reason: UnresolvedReason = width < WAVE_WIDTH ? 'rate-limited' : 'budget';
      queue.forEach((lp) => {
        if (reason === 'rate-limited') rateLimitedAnchors.add(lp.anchor);
        else budgetBlockedAnchors.add(lp.anchor);
      });
      log.push(`identity waves stopped: ${reason} (${queue.length} anchor(s) unresolved)`);
      break;
    }

    const wave = buildWave(queue, width);
    waveCount += 1;

    const settled = await Promise.allSettled(wave.map((lp) => runAnchor(lp)));

    let hitRateLimitThisWave = false;
    settled.forEach((result, i) => {
      if (result.status !== 'rejected') return;
      const anchor = wave[i].anchor;
      if (isRateLimited(result.reason)) {
        rateLimitedAnchors.add(anchor);
        hitRateLimitThisWave = true;
      } else {
        failedAnchors.add(anchor);
        log.push(`identity request for photo ${anchor} failed: ${describeError(result.reason)}`);
      }
    });

    if (hitRateLimitThisWave) {
      rateLimitStrikes += 1;
      if (rateLimitStrikes === 1) {
        width = 2;
        log.push('rate limited by the provider; narrowing wave width to 2');
      } else {
        log.push('rate limited again; stopping the identity wave loop');
        livePools(freshPools(), idOf, graph, marginFn).forEach((lp) =>
          rateLimitedAnchors.add(lp.anchor)
        );
        onGroups?.(previewGroups());
        break;
      }
    }

    onGroups?.(previewGroups());
  }

  // --- 6.5. reciprocal round (A2) --------------------------------------------
  //
  // A merge now needs two votes anchored from different members (Change A).
  // Most pairs get their second vote for free, because the wave loop's own
  // priority order usually gets around to the other side's question too. The
  // ones that don't: batch the un-asked side of every still-pending pair into
  // one confirming-or-rejecting request each, before anything downstream ever
  // treats a lonely pending vote as a review hint or an orphan.

  if (meter.canSpend() && !shouldStop?.()) {
    const bySide = new Map<number, number[]>(); // un-asked anchor idx -> its pending partners

    graph.pendingPairs().forEach(({ a, b, anchor }) => {
      const askedFromIdx = indexOfId.get(anchor)!;
      const otherId = anchor === a ? b : a;
      const otherIdx = indexOfId.get(otherId)!;
      if (askedPairs.has(askedKey(otherIdx, askedFromIdx))) return; // that side already asked
      const partners = bySide.get(otherIdx) ?? [];
      if (!partners.includes(askedFromIdx)) partners.push(askedFromIdx);
      bySide.set(otherIdx, partners);
    });

    const sides = [...bySide.keys()].sort((x, y) => x - y);
    let reciprocated = false;
    for (const sideAnchor of sides) {
      if (shouldStop?.() || !meter.canSpend()) break;
      const partners = bySide.get(sideAnchor)!.slice(0, WIDENED_NET_K);
      if (!partners.length) continue;
      await runAnchor({ anchor: sideAnchor, live: partners, bestMargin: 0 });
      reciprocated = true;
    }
    if (reciprocated) onGroups?.(previewGroups());
  }

  // --- 7. coherence verification (Change B) -----------------------------------
  //
  // Change A's two-vote merges cut the false-merge rate but do not prove a
  // finished cluster is right. Once a cluster looks done (three photographs
  // or more - the point where a silent over-merge is expensive rather than a
  // lucky pair), ask the model to check its own claim on a dedicated contact
  // sheet, and split the cluster along its answer if it disagrees. The
  // LinkGraph itself is never mutated here (no detach/undo) - the split is
  // applied only when groups are finally built, via `verifiedPartitions`.

  const verifiedPartitions = new Map<string, string[][]>(); // cluster's first member id -> id partitions
  const coherenceFailedRoots = new Set<string>();            // stays one group, but forced under review

  if (!shouldStop?.()) {
    const toVerify = graph.clusters().filter((c) => c.length >= COHERENCE_MIN_GROUP);
    for (const memberIds of toVerify) {
      if (shouldStop?.() || !meter.canSpend()) break;
      const label = memberIds[0];
      try {
        const photos = memberIds.map((id) => photoOf(indexOfId.get(id)!));
        const composite = await buildContactSheet(photos);
        const parts: any[] = [];
        if (composite) {
          parts.push({ inlineData: { mimeType: 'image/jpeg', data: composite } });
        } else {
          photos.forEach((p) => parts.push({ inlineData: { mimeType: 'image/jpeg', data: p } }));
        }
        parts.push({ text: coherencePrompt(memberIds.length) });

        meter.charge();
        const { text, usage } = await ask(parts, COHERENCE_SCHEMA, 'coherence');
        meter.record(usage);

        const entries = extractJsonArray(text);
        if (!entries) {
          log.push(`coherence reply for product ${label} could not be read`);
          coherenceFailedRoots.add(label);
          continue;
        }

        const verdicts = readCoherence(entries, memberIds.length);
        const partition = partitionByVerdicts(memberIds.length, verdicts);
        if (partition.length > 1) {
          verifiedPartitions.set(label, partition.map((idxs) => idxs.map((i) => memberIds[i])));
          log.push(`verification split product ${label} into ${partition.length}`);
        }
      } catch (err) {
        // Unreadable reply or a failed request: the cluster stays as-is,
        // forced under review. Never blocks the run (spec Change B step 4).
        log.push(`coherence check for product ${label} failed: ${describeError(err)}`);
        coherenceFailedRoots.add(label);
      }
    }
  }

  // --- 7.5. widened net: anchors that never had a cross-angle candidate -----

  const rankNeighboursRaw = (anchor: number): number[] => {
    const anchorBucket = bucketOf(anglesByIndex[anchor]);
    const scored: { index: number; score: number }[] = [];
    for (let j = 0; j < images.length; j += 1) {
      if (j === anchor) continue;
      const bucket = bucketOf(anglesByIndex[j]);
      if (anchorBucket !== null && bucket === anchorBucket) continue;
      if (notSameIdx.has(pairKey(anchor, j))) continue;
      if (askedPairs.has(askedKey(anchor, j))) continue;
      let score: number;
      if (usingSignatures) {
        score = -visualDistance(signatures[anchor], signatures[j]);
      } else {
        const va = vectors[anchor];
        const vb = vectors[j];
        if (!va || !vb) continue;
        score = cosine(va, vb);
      }
      scored.push({ index: j, score });
    }
    scored.sort((x, y) => y.score - x.score || x.index - y.index);
    return scored.slice(0, WIDENED_NET_K).map((s) => s.index);
  };

  if (meter.canSpend() && !shouldStop?.()) {
    // Change C: this net now covers every remaining single, not only the
    // ones that never had a cross-angle candidate at all - an orphan whose
    // pool was exhausted by NOT-SAME answers gets the same one extra try,
    // against neighbours it has never been asked about from this direction.
    const singleton = graph
      .clusters()
      .filter((c) => c.length === 1)
      .map((c) => indexOfId.get(c[0])!)
      .sort((a, b) => a - b);

    let widened = false;
    for (const anchor of singleton) {
      if (shouldStop?.() || !meter.canSpend()) break;
      const ranked = rankNeighboursRaw(anchor);
      if (!ranked.length) continue;
      await runAnchor({ anchor, live: ranked, bestMargin: 0 });
      widened = true;
    }
    if (widened) onGroups?.(previewGroups());
  }

  // --- 8/9. classify + build the final result --------------------------------

  const classifyAlone = (i: number, listedIn: Set<number>): 'alone' | UnresolvedReason => {
    if (budgetBlockedAnchors.has(i)) return 'budget';
    if (rateLimitedAnchors.has(i)) return 'rate-limited';
    if (failedAnchors.has(i)) return 'request-failed';
    if (hedgedIdx.has(i)) return 'hedged';
    if (!requestedAnchors.has(i)) return 'no-candidates';
    if (truncatedByAnchor.get(i)) return 'truncated';
    if (!shownPlausibleAnchors.has(i)) return 'weak-only';
    if (listedIn.has(i)) return 'reciprocal';
    // Change C: the dataset guarantee is that every real product has at
    // least two photographs, so a photograph that survives every other
    // check and still stands alone is never treated as a one-photo product
    // - it is a recall failure the pipeline should surface, not hide.
    return NO_SINGLE_PHOTO_PRODUCTS ? 'orphan' : 'alone';
  };

  const clusters = graph.clusters();
  const finalLive = livePools(freshPools(), idOf, graph, marginFn);
  const listedIn = new Set<number>();
  finalLive.forEach((lp) => lp.live.forEach((c) => listedIn.add(c)));

  const groups: ProductGroup[] = [];
  const unassigned: string[] = [];
  const uncertainReasons: Record<string, string> = {};

  const forceReview = (g: ProductGroup): ProductGroup => {
    g.flagged = true;
    g.needsReview = true;
    g.confidence = Math.min(g.confidence, REVIEW_CONFIDENCE - 0.01);
    return g;
  };

  const pushMember = (memberIds: string[], split: boolean): void => {
    if (memberIds.length >= 2) {
      const g = buildGroupFor(memberIds);
      groups.push(split ? forceReview(g) : g);
      return;
    }
    const id = memberIds[0];
    const i = indexOfId.get(id)!;
    const verdict = classifyAlone(i, listedIn);
    if (verdict === 'alone') {
      const g = buildGroupFor(memberIds);
      groups.push(split ? forceReview(g) : g);
    } else {
      unassigned.push(id);
      uncertainReasons[id] = UNRESOLVED_REASONS[verdict];
    }
  };

  clusters.forEach((memberIds) => {
    // Change B: a cluster the coherence check split gets built partition by
    // partition instead of whole - each sub-group forced under review. A
    // cluster it merely failed to verify (unreadable/failed request) stays
    // whole, also forced under review. Everything else is unaffected.
    const partitions = verifiedPartitions.get(memberIds[0]);
    if (partitions) {
      partitions.forEach((ids) => pushMember(ids, true));
      return;
    }
    if (coherenceFailedRoots.has(memberIds[0])) {
      pushMember(memberIds, true);
      return;
    }
    pushMember(memberIds, false);
  });

  // Duplicate-angle assertion. Unreachable by construction (cannot-link is
  // absolute in LinkGraph.add) — checked anyway, loudly, because an
  // invariant that is not checked is a hope (spec section 14).
  groups.forEach((g) => {
    const seen = new Set<string>();
    let duplicate = false;
    g.images.forEach((im) => {
      const bucket = bucketOf(im.view);
      if (!bucket) return;
      if (seen.has(bucket)) duplicate = true;
      seen.add(bucket);
    });
    if (duplicate) {
      g.flagged = true;
      g.needsReview = true;
      // eslint-disable-next-line no-console
      console.error(
        `[groupFolderV3] DUPLICATE-ANGLE INVARIANT VIOLATED in group "${g.name}": two members ` +
          `share a cannot-link angle bucket. This should be unreachable by construction.`
      );
    }
  });

  const renumbered = renumber(groups);

  log.push(`${waveCount} identity wave(s) issued.`);
  log.push(meter.summary());

  if (recordOn() && typeof window !== 'undefined') {
    const dumped = dumpRecording(recording);
    // eslint-disable-next-line no-console
    console.log(dumped);
    (window as any).__grouping_recording = dumped;
  }

  return {
    groups: renumbered,
    unassigned,
    classified: true,
    log,
    uncertainReasons: Object.keys(uncertainReasons).length ? uncertainReasons : undefined,
    spendUsd: meter.spentUsd(),
  };
}
