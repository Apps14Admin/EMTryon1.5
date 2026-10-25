/**
 * GROUPING A FOLDER BY LOOKING AT IT.
 *
 * The pipeline this replaces read every photograph into thirty-five text
 * fields, threw the pixels away, and then tried to recover "same physical
 * object" by weighing the words against each other. That cannot work on a
 * folder of near-identical items, because by the time two black trainers have
 * been honestly described their descriptions are the same description. Every
 * threshold, veto tier, correlated-field rule and special case in
 * `productFingerprint.ts` was a patch on that one loss, and each patch that
 * fixed one folder broke another.
 *
 * This pipeline never converts a photograph into words at all.
 *
 *   1. CROP. The background comes off locally, where it can be identified
 *      confidently, so that neither the embedding nor the judge spends itself
 *      on the room the photograph was taken in.
 *   2. EMBED, locally and free. A SigLIP vector per photograph, computed in the
 *      browser. Decides nothing — it only proposes what is worth looking at.
 *   3. PLAN. Neighbourhoods, not a chain: each photograph goes on three sheets
 *      with the photographs most likely to be the same item, so a product whose
 *      angles are far apart is still assembled, and so every pair is asked about
 *      more than once.
 *   4. ASK. Each sheet is composited into ONE labelled picture and the model is
 *      asked which photographs show the same object. A sheet of nine answers
 *      thirty-six pairs in one request.
 *   5. CLUSTER. The answers are signed — SAME and DIFFERENT both come from a
 *      model that had the photographs in front of it — and `signedGraph.ts`
 *      turns them into products without contradicting any of them.
 *   6. TIE-BREAK. Where two sheets disagreed about a pair, and only there, the
 *      OTHER provider is asked about that pair alone.
 *
 * WHAT IS NOT HERE, ON PURPOSE: no similarity threshold, no attribute weights,
 * no veto table, no angle rule, no vocabulary arithmetic. There is nothing in
 * this file to tune, which is the point. The judgements come from the model
 * looking at the pictures, and the only code decision left is how to honour a
 * set of judgements without contradicting one — which is a solved problem with
 * a right answer rather than a knob.
 */

import { GoogleGenAI } from '@google/genai';
import { mapWithConcurrency } from './imageUtils';
import { signatureOf, visualDistance, Signature } from './imageSignature';
import { buildContactSheet } from './contactSheet';
import { isolateFolder } from './isolateSubject';
import {
  COVERAGE,
  SHEET_SIZE,
  neighboursOf,
  planSheets,
} from './neighbourGraph';
import { embedFolder, embedderStatus } from './visualEmbedding';
import {
  Judgement,
  cluster,
  Contradiction,
  pairKey,
} from './signedGraph';
import {
  JUDGE_SCHEMA,
  JUDGE_TEMPERATURE,
  SURE,
  TIE_BREAK_SCHEMA,
  extractArray,
  judgePrompt,
  readTieBreak,
  readVerdicts,
  tieBreakPrompt,
  toJudgements,
  Verdict,
} from './visualJudge';
import {
  Category,
  FolderImage,
  GroupedImage,
  GroupingProgress,
  GroupingResult,
  ProductGroup,
  REVIEW_CONFIDENCE,
  VIEW_NAMES,
  ViewName,
  analysisModel,
  askAnalysisModel,
  groupLabel,
  renumber,
  summarise,
} from './productGrouper';
import { getAiProvider, setAiProvider, AiProvider } from './aiProvider';
import { embeddingEnabled, oneShotPerAngle, structuredOutputEnabled } from './groupingMode';

/** Sheets in flight at once. */
export const CONCURRENCY = 4;

/**
 * Most pairs a disagreement is worth paying a second provider to settle.
 *
 * A contradiction is genuinely rare — it needs the model to have joined a pair
 * whose two halves it separated elsewhere — so on a healthy folder this budget
 * is barely touched. It exists because a folder can be pathological, and an
 * unbounded "ask about every disagreement" would double the run without being
 * asked.
 */
export const MAX_TIE_BREAKS = 12;

const textOf = (res: any): string =>
  (res?.candidates?.[0]?.content?.parts ?? [])
    .map((part: any) => part.text ?? '')
    .join('');

const describeError = (err: unknown): string => {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return 'the request failed';
};

/**
 * How sure we are that a group really is one product.
 *
 * A GROUP IS ONLY AS STRONG AS THE WEAKEST JUDGEMENT HOLDING IT TOGETHER. Six
 * photographs joined into a ring by six confident judgements is a different
 * thing from six photographs joined in a line by five, one of which the model
 * hedged on — and the second is exactly the shape of a group that has quietly
 * swallowed a second item.
 *
 * So the score is the bottleneck: the weakest edge on the strongest spanning
 * tree of the group. Redundancy then lifts it — pairs judged directly, over
 * pairs that exist — because a group whose every pair was confirmed is not
 * relying on any single edge at all.
 */
export const groupConfidence = (
  ids: string[],
  judgements: Map<string, Judgement>,
  contradicted: boolean
): number => {
  if (ids.length < 2) return contradicted ? 0.5 : 0.8;

  const inside: Judgement[] = [];
  for (let i = 0; i < ids.length; i += 1) {
    for (let j = i + 1; j < ids.length; j += 1) {
      const held = judgements.get(pairKey(ids[i], ids[j]));
      if (held?.same) inside.push(held);
    }
  }

  if (!inside.length) return 0.4;

  // Maximum spanning tree, strongest edge first. The last edge it needs is the
  // bottleneck — remove it and the group falls into two.
  const parent = new Map<string, string>();
  const find = (id: string): string => {
    const held = parent.get(id);
    if (held === undefined || held === id) {
      parent.set(id, id);
      return id;
    }
    const root = find(held);
    parent.set(id, root);
    return root;
  };

  const ordered = [...inside].sort((x, y) => (y.confidence ?? 1) - (x.confidence ?? 1));
  let bottleneck = 1;
  let joined = 1;

  ordered.forEach((judgement) => {
    if (joined >= ids.length) return;
    const rootA = find(judgement.a);
    const rootB = find(judgement.b);
    if (rootA === rootB) return;
    parent.set(rootA, rootB);
    bottleneck = Math.min(bottleneck, judgement.confidence ?? 1);
    joined += 1;
  });

  // A group the judgements do not actually connect — it was assembled through
  // photographs that are not all in it — is reported as weak rather than as
  // whatever its strongest edge happened to be.
  if (joined < ids.length) return Math.min(bottleneck, 0.5);

  const possible = (ids.length * (ids.length - 1)) / 2;
  const density = inside.length / possible;

  const score = bottleneck * (0.75 + 0.25 * density);
  return contradicted ? Math.min(score, REVIEW_CONFIDENCE - 0.01) : score;
};

/**
 * Neighbour lists from the local signatures, for when the embedder is not
 * available.
 *
 * Strictly worse — a difference hash compares framing, and two angles of one
 * shoe share no framing — but it keeps the folder working on a machine that
 * cannot run the model, and the model still makes every actual judgement. The
 * cost of the fallback is more sheets and slightly worse recall, not a wrong
 * grouping.
 */
const neighboursFromSignatures = (
  signatures: (Signature | null)[],
  k: number
): number[][] =>
  signatures.map((signature, i) => {
    if (!signature) return [];
    const scored: { index: number; distance: number }[] = [];
    signatures.forEach((other, j) => {
      if (i === j || !other) return;
      scored.push({ index: j, distance: visualDistance(signature, other) });
    });
    scored.sort((x, y) => x.distance - y.distance);
    return scored.slice(0, k).map((entry) => entry.index);
  });

export async function groupFolderV2(
  images: FolderImage[],
  onProgress?: (progress: GroupingProgress) => void,
  shouldStop?: () => boolean,
  onGroups?: (groups: ProductGroup[]) => void
): Promise<GroupingResult> {
  const log: string[] = [];

  if (!images.length) return { groups: [], unassigned: [], classified: true, log };

  const ai = new GoogleGenAI({
    apiKey: 'proxied',
    httpOptions: { baseUrl: `${window.location.origin}/api/gemini` },
  });

  const ask = async (
    parts: any[],
    schema: Record<string, unknown>,
    schemaName: string
  ): Promise<string> => {
    // The schema is sent only when it has been confirmed to work against the
    // configured model. See `structuredOutputEnabled`: a rejected schema is not
    // a worse answer, it is a 400 on every request in the run.
    const text = textOf(
      await askAnalysisModel(ai, parts, undefined, {
        temperature: JUDGE_TEMPERATURE,
        ...(structuredOutputEnabled() ? { schema, schemaName } : {}),
      })
    );
    if (!text.trim()) throw new Error(`'${analysisModel()}' answered with no text`);
    return text;
  };

  const original = (i: number) => images[i].scout || images[i].thumb;

  // --- 1. crop away the room ----------------------------------------------
  //
  // Before anything looks at these photographs, the background comes off where
  // it can be identified confidently. It matters more than its size suggests:
  // the embedding clusters on whatever varies most in a photograph, and in a
  // stockroom that is the room. Two different shoes on one red table are pulled
  // together by the table; one shoe on the table and again on a white sheet is
  // pushed apart by it. Both are backwards, and the judge cannot repair either,
  // because the judge only ever sees the sheets the embedding proposed.
  //
  // It also buys resolution for free. A shoe filling a fifth of its frame gets
  // a fifth of its cell on the contact sheet, and a tread pattern is not
  // resolvable at that size.
  //
  // Local, no model, no request. Refuses rather than guesses: `null` means the
  // photograph is used exactly as it arrived.

  onProgress?.({ done: 0, total: images.length, phase: 'assigning' });

  // The FULL copy goes in, not the scout. Cropping the already-downscaled copy
  // was the first version of this and it threw away most of what cropping is
  // for: see the note on ordering in `isolateSubject.ts`.
  const cropped = await isolateFolder(
    images.map((image) => image.full || image.scout || image.thumb),
    (done, total) => onProgress?.({ done, total, phase: 'preparing' }),
    shouldStop
  );

  const trimmed = cropped.filter(Boolean).length;
  if (trimmed) {
    log.push(`${trimmed} of ${images.length} photograph(s) cropped to the product.`);
  }

  /** What every later stage actually looks at: the crop where there is one. */
  const photoOf = (i: number) => cropped[i] ?? original(i);

  // --- 2. embed, locally --------------------------------------------------

  const vectors = embeddingEnabled()
    ? await embedFolder(
        images.map((_, i) => photoOf(i)),
        (done, total) => onProgress?.({ done, total, phase: 'reading' }),
        shouldStop,
        // The one-time model download. Silence here is what a full progress bar
        // reading "110 of 110" and never moving actually was: the crop had
        // finished and a hundred megabytes were arriving with nothing said
        // about it, which is indistinguishable from a hang.
        ({ loaded, total }) =>
          onProgress?.({
            done: Math.round(loaded / 1e6),
            total: Math.round(total / 1e6),
            phase: 'loading',
            unit: 'mb',
          })
      )
    : images.map(() => null);

  const embedded = vectors.filter(Boolean).length;
  const status = embedderStatus();

  let neighbours: number[][];

  if (embedded >= 2) {
    log.push(
      `Embedded ${embedded} of ${images.length} photograph(s) locally on ` +
        `${status.backend ?? 'this machine'} — no request, no quota.` +
        (status.backend === 'wasm'
          ? ' This machine has no WebGPU, so that stage ran on the CPU and was' +
            ' several times slower than it needs to be.'
          : '')
    );
    neighbours = neighboursOf(vectors, SHEET_SIZE - 1);
  } else {
    // No model. Fall back to the cheap signatures so the folder still runs.
    log.push(
      (embeddingEnabled()
        ? `The local image model was unavailable${status.reason ? ` (${status.reason})` : ''}, `
        : 'The local image model was switched off with ?embed=off, ') +
        `so photographs were paired up by their thumbnails instead. Grouping is unaffected — ` +
        `the model still judges every pair — but more requests are needed.`
    );
    const signatures = await mapWithConcurrency(images, 6, (_, i) => signatureOf(photoOf(i)));
    neighbours = neighboursFromSignatures(signatures, SHEET_SIZE - 1);
  }

  if (shouldStop?.()) {
    return {
      groups: [],
      unassigned: images.map((image) => image.id),
      classified: true,
      stopped: true,
      log,
    };
  }

  // --- 3. plan the sheets -------------------------------------------------

  const { sheets, thin } = planSheets(neighbours, SHEET_SIZE, COVERAGE);

  log.push(
    `${images.length} photograph(s) laid out on ${sheets.length} contact sheet(s) of up to ` +
      `${SHEET_SIZE}, each photograph appearing on ${COVERAGE} of them.`
  );
  if (thin.length) {
    log.push(`${thin.length} photograph(s) could only be shown once.`);
  }

  // --- 4. ask ------------------------------------------------------------

  const judgements: Judgement[] = [];
  const verdictOf = new Map<string, Verdict>();
  const failures: string[] = [];
  let stopped = false;
  let fatal: string | null = null;
  let asked = 0;

  const provider = getAiProvider();

  const runSheet = async (sheet: number[]): Promise<void> => {
    if (stopped || fatal) return;
    if (shouldStop?.()) {
      stopped = true;
      return;
    }

    const photos = sheet.map(photoOf);
    const composite = await buildContactSheet(photos);

    // A sheet that came back empty, or too small to be a real JPEG, is not sent
    // as one. An empty `inlineData` is refused by the API as a malformed
    // request, which fails the whole run rather than this one sheet — so the
    // cheap check happens here instead.
    const usableSheet = composite && composite.length > 1024 ? composite : null;

    const parts: any[] = [];
    if (usableSheet) {
      parts.push({ inlineData: { mimeType: 'image/jpeg', data: usableSheet } });
    } else {
      // No canvas. The photographs go separately, which costs more and compares
      // worse, but the question asked is the same one.
      photos.forEach((photo) =>
        parts.push({ inlineData: { mimeType: 'image/jpeg', data: photo } })
      );
    }
    parts.push({ text: judgePrompt(sheet.length) });

    let reply: string;
    try {
      reply = await ask(parts, JUDGE_SCHEMA, 'sheet_grouping');
    } catch (err) {
      // A spent quota or a refused key fails every other sheet too. Stop rather
      // than spending the rest of the folder proving it.
      //
      // What was SENT travels with the failure. Without it a 400 is untraceable
      // from the screen: the reply names no argument, and nothing else records
      // whether the request carried one composited image or nine separate ones,
      // how large it was, or which options were attached.
      fatal =
        `${describeError(err)} [the request held ` +
        `${usableSheet ? '1 contact sheet' : `${photos.length} separate photos`}` +
        `${usableSheet ? ` of ${Math.round(usableSheet.length / 1365)}KB` : ''}` +
        `, temperature ${JUDGE_TEMPERATURE}` +
        `, ${structuredOutputEnabled() ? 'with' : 'without'} a response schema]`;
      throw err;
    }

    const entries = extractArray(reply);
    if (!entries) {
      failures.push('A sheet came back with no grouping in it.');
      return;
    }

    const verdicts = readVerdicts(entries, sheet.length);
    verdicts.forEach((verdict) => {
      const id = images[sheet[verdict.photo]]?.id;
      if (id && !verdictOf.has(id)) verdictOf.set(id, verdict);
    });

    judgements.push(
      ...toJudgements(verdicts, (photo) => images[sheet[photo]]?.id, provider)
    );

    asked += 1;
    onProgress?.({ done: asked, total: sheets.length, phase: 'assigning' });
    onGroups?.(
      build(cluster(images.map((image) => image.id), judgements, clusterOptions())).groups
    );
  };

  // --- building the products from a clustering ---------------------------

  /**
   * The angle each photograph shows, from whichever sheet named one.
   *
   * Passed to the clustering only when the folder is declared one-shot-per-
   * angle; otherwise the constraint is absent entirely rather than merely
   * lenient.
   */
  const angleOf = (id: string): string | undefined => verdictOf.get(id)?.angle;

  const clusterOptions = () => (oneShotPerAngle() ? { angleOf } : {});

  const build = (
    result: ReturnType<typeof cluster>
  ): { groups: ProductGroup[]; contradictions: Contradiction[] } => {
    const folded = new Map<string, Judgement>();
    judgements.forEach((judgement) => {
      const key = pairKey(judgement.a, judgement.b);
      const held = folded.get(key);
      if (!held || (!judgement.same && held.same)) folded.set(key, judgement);
    });

    const contested = new Set<string>();
    result.contradictions.forEach(({ wanted, blockedBy }) => {
      [wanted.a, wanted.b, blockedBy.a, blockedBy.b].forEach((id) => contested.add(id));
    });

    const groups = renumber(
      result.clusters.map((ids, i) => {
        const touched = ids.some((id) => contested.has(id));
        const confidence = groupConfidence(ids, folded, touched);

        const entries: GroupedImage[] = ids.map((id) => {
          const verdict = verdictOf.get(id);
          return {
            imageId: id,
            // The angle both labels the thumbnail and, when the folder is a
            // one-shot-per-angle shoot, constrains what may merge.
            view: (VIEW_NAMES.includes(verdict?.angle as ViewName)
              ? verdict!.angle
              : 'OTHER') as ViewName,
            viewSource: verdict?.angle ? 'model' : 'fallback',
            colour: verdict?.colour,
            reason: verdict?.because,
          };
        });

        const category = (ids
          .map((id) => verdictOf.get(id)?.category)
          .find((value) => value && value !== 'OTHER') ?? 'OTHER') as Category;

        return summarise({
          id: `product-${i + 1}`,
          name: groupLabel(i),
          category,
          colour: ids.map((id) => verdictOf.get(id)?.colour).find(Boolean),
          images: entries,
          confidence,
          needsReview: touched || confidence < REVIEW_CONFIDENCE,
          flagged: touched,
        });
      })
    );

    return { groups, contradictions: result.contradictions };
  };

  try {
    // The first sheet goes alone, so the others do not each rediscover which
    // model answers.
    if (sheets.length) await runSheet(sheets[0]);

    let next = 1;
    const worker = async () => {
      for (;;) {
        if (stopped || fatal) return;
        const index = next;
        next += 1;
        if (index >= sheets.length) return;
        await runSheet(sheets[index]);
      }
    };

    const settled = await Promise.allSettled(
      Array.from({ length: Math.min(CONCURRENCY, Math.max(1, sheets.length - 1)) }, worker)
    );
    const broke = settled.find((result) => result.status === 'rejected');
    if (broke) throw (broke as PromiseRejectedResult).reason;
  } catch (err) {
    fatal = describeError(err);
  }

  if (!judgements.length && fatal) {
    // Nothing came back. Never turned into one product per photograph: that
    // hides a real failure behind a grouping that is confidently wrong.
    return { groups: [], unassigned: [], classified: false, error: fatal, log };
  }

  if (fatal) log.push(`Stopped early: ${fatal}`);
  failures.forEach((failure) => log.push(failure));

  // --- 5. cluster ---------------------------------------------------------

  let result = cluster(images.map((image) => image.id), judgements, clusterOptions());
  log.push(...result.log);

  // --- 6. tie-break, only where two sheets disagreed ----------------------
  //
  // This is where the second provider earns its keep, and the only place. A
  // contradiction is a pair one sheet joined and another separated — the model
  // disagreeing with itself, which is the definition of a hard pair. Asking the
  // OTHER provider about that pair ALONE settles it with a judge that has not
  // already committed to either answer, and costs one small request each.
  //
  // Asking both providers about everything would cost twice the run for an
  // answer that agrees with itself on the easy pairs, which are almost all of
  // them.

  if (!stopped && !fatal && result.contradictions.length) {
    onProgress?.({ done: 0, total: result.contradictions.length, phase: 'verifying' });

    const indexOf = new Map(images.map((image, i) => [image.id, i]));
    const shortlist = result.contradictions.slice(0, MAX_TIE_BREAKS);
    const other: AiProvider = provider === 'openai' ? 'gemini' : 'openai';

    let settled = 0;

    const decided = await mapWithConcurrency(shortlist, 3, async (contradiction) => {
      const { a, b } = contradiction.wanted;
      const left = indexOf.get(a);
      const right = indexOf.get(b);
      if (left === undefined || right === undefined) return null;

      // Two photographs on a 1024px sheet is 512 pixels each — the largest any
      // photograph gets anywhere in this pipeline, and correctly so: this pair
      // is the one the model has already answered two ways.
      const composite = await buildContactSheet([photoOf(left), photoOf(right)], 1024);

      const parts: any[] = [];
      if (composite) parts.push({ inlineData: { mimeType: 'image/jpeg', data: composite } });
      else {
        parts.push({ inlineData: { mimeType: 'image/jpeg', data: photoOf(left) } });
        parts.push({ inlineData: { mimeType: 'image/jpeg', data: photoOf(right) } });
      }
      parts.push({ text: tieBreakPrompt() });

      // The provider is swapped for the request and put back straight after,
      // so a failure cannot leave the application pointed at the wrong one.
      setAiProvider(other);
      try {
        const verdict = readTieBreak(await ask(parts, TIE_BREAK_SCHEMA, 'tie_break'));
        if (!verdict) return null;
        settled += 1;
        return {
          a,
          b,
          same: verdict.same,
          confidence: SURE,
          reason: verdict.because,
          source: other,
        } as Judgement;
      } catch {
        // A tie-break is an improvement, never a dependency. The pair stays
        // contested and goes to the review screen, which is the honest outcome.
        return null;
      } finally {
        setAiProvider(provider);
      }
    });

    const settledJudgements = decided.filter((j): j is Judgement => !!j);

    if (settledJudgements.length) {
      // A tie-break outranks both earlier answers, so the pair's earlier
      // judgements are dropped rather than folded against it — folding would
      // let the old DIFFERENT beat the new SAME by the standing rule, which is
      // right for two equal opinions and wrong for a deliberate re-ask.
      const overruled = new Set(settledJudgements.map((j) => pairKey(j.a, j.b)));
      const kept = judgements.filter((j) => !overruled.has(pairKey(j.a, j.b)));

      judgements.length = 0;
      judgements.push(...kept, ...settledJudgements);

      result = cluster(images.map((image) => image.id), judgements, clusterOptions());
    }

    log.push(
      `${result.contradictions.length ? result.contradictions.length : 'No'} pair(s) were judged ` +
        `both ways; ${settled} of ${shortlist.length} asked again were settled by ${other}.`
    );
  }

  const { groups } = build(result);

  return {
    groups,
    unassigned: [],
    classified: true,
    stopped: stopped || undefined,
    log,
  };
}
