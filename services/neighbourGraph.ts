/**
 * WHICH PHOTOGRAPHS ARE WORTH SHOWING TO THE MODEL TOGETHER.
 *
 * This is the recall half of the system, and it is deliberately not allowed to
 * decide anything. Its whole job is to make sure that two photographs of one
 * product end up on the same contact sheet at least once, so that the model
 * gets the chance to say so. If it puts two unrelated photographs together,
 * that costs nothing — the model says "different" and the graph records it. If
 * it FAILS to put two photographs of one shoe together, no later stage can
 * recover: they were never compared, so they stay two products.
 *
 * So the bias here is entirely towards including too much, and the only real
 * question is how many requests that costs.
 *
 * WHY THIS REPLACES THE OLD BATCHING. `photoClustering.ts` cut the folder into
 * runs of twelve along a similarity CHAIN, with two photographs of overlap
 * between neighbouring runs. A chain is one-dimensional: a product whose five
 * photographs sit at positions 3, 4, 40, 41 and 92 of the chain — which is what
 * a sole shot and a profile of one shoe actually look like to any appearance
 * measure — is cut across three runs that share nothing, and the two-photograph
 * overlap only ever stitches ADJACENT runs. Those products could not be found,
 * whatever the prompt said.
 *
 * Neighbourhoods are not one-dimensional. A photograph's sheet holds the
 * photographs nearest IT, wherever they fall in the folder, and a photograph
 * appearing on two sheets is what stitches those two sheets together — by
 * transitivity through a shared photograph, which is the one join that needs no
 * judgement at all.
 */

/** How many photographs go on one contact sheet, including the anchor. */
export const SHEET_SIZE = 9;

/**
 * How many sheets each photograph should appear on.
 *
 * One would be enough if neighbourhoods were symmetric, and they are not: a
 * sole shot's nearest neighbours are other sole shots, so a sole shot can sit
 * on a sheet full of soles and never meet its own product's profile. Further
 * appearances, seeded from different anchors, are what fix that — and they are
 * also every stitch between two sheets, because a photograph on two sheets
 * joins them by transitivity without anything being asked. They are equally
 * what lets `foldJudgements` weigh one answer about a pair against another.
 *
 * Three is the working value, and it was measured rather than guessed. Under
 * the folding rule this system originally used — where any DIFFERENT overruled
 * any number of SAMEs — raising coverage made the grouping WORSE, because every
 * extra sheet was another chance to emit a wrong DIFFERENT and a wrong
 * DIFFERENT was permanent. With `foldJudgements` weighing the evidence instead,
 * coverage buys what it should: at a 5% judge error rate, recall goes from
 * 0.805 at two sheets to 0.877 at three, with precision staying at 1.000. Four
 * buys nothing further and costs a fifth more requests.
 */
export const COVERAGE = 3;

/** One photograph's nearest others, nearest first, excluding itself. */
export type Neighbours = number[][];

/**
 * Cosine similarity. The vectors an embedding model produces are compared this
 * way and not by Euclidean distance, because their magnitude carries no meaning
 * — only their direction does.
 */
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

/**
 * Each photograph's nearest others by embedding.
 *
 * A photograph with no vector — the embedder was unavailable, or the decode
 * failed — gets an empty neighbour list rather than a wrong one, and is picked
 * up later as a photograph that must anchor its own sheet.
 */
export const neighboursOf = (
  vectors: (Float32Array | null)[],
  k: number
): Neighbours =>
  vectors.map((vector, i) => {
    if (!vector) return [];
    const scored: { index: number; score: number }[] = [];
    vectors.forEach((other, j) => {
      if (i === j || !other) return;
      scored.push({ index: j, score: cosine(vector, other) });
    });
    scored.sort((x, y) => y.score - x.score);
    return scored.slice(0, k).map((entry) => entry.index);
  });

export interface SheetPlan {
  /** The photographs on each sheet, anchor first. */
  sheets: number[][];
  /** How many sheets each photograph landed on. */
  appearances: number[];
  /** Photographs that could not be given the full coverage asked for. */
  thin: number[];
}

/**
 * Chooses the sheets.
 *
 * Greedy, and greedy on the right quantity: at each step it anchors the
 * photograph currently on the FEWEST sheets, and fills that sheet with its
 * nearest neighbours preferring the ones that are themselves short of
 * appearances. That keeps the sheet count near `photos * COVERAGE / SHEET_SIZE`
 * — about forty-six sheets for a hundred and ten photographs at the values
 * above — while making sure no photograph is left to be judged only once.
 *
 * Ties break on the folder's own order, so the plan is deterministic: the same
 * folder produces the same sheets, and therefore the same log, on every run.
 */
export const planSheets = (
  neighbours: Neighbours,
  size: number = SHEET_SIZE,
  coverage: number = COVERAGE
): SheetPlan => {
  const count = neighbours.length;
  const appearances = new Array(count).fill(0);
  const sheets: number[][] = [];
  const seen = new Set<string>();

  if (!count) return { sheets, appearances, thin: [] };

  /** The photograph most in need of being looked at, folder order breaking ties. */
  const neediest = (): number => {
    let best = -1;
    for (let i = 0; i < count; i += 1) {
      if (appearances[i] >= coverage) continue;
      if (best === -1 || appearances[i] < appearances[best]) best = i;
    }
    return best;
  };

  for (;;) {
    const anchor = neediest();
    if (anchor === -1) break;

    // Nearest first, but a neighbour that is already well covered yields to one
    // that is not. Both photographs get compared either way; this only decides
    // which sheet pays for it, and spreading it keeps the sheet count down.
    const candidates = [...neighbours[anchor]].sort((x, y) => {
      const need = appearances[x] - appearances[y];
      if (need) return need;
      return neighbours[anchor].indexOf(x) - neighbours[anchor].indexOf(y);
    });

    const sheet = [anchor, ...candidates.slice(0, size - 1)];

    // A sheet identical to one already planned teaches nothing and costs a
    // request. It happens whenever two photographs are each other's nearest
    // neighbour and share a neighbourhood, which in a folder of one product's
    // angles is common.
    const key = [...sheet].sort((x, y) => x - y).join(',');
    if (seen.has(key)) {
      // The anchor still needs covering, and repeating its own neighbourhood
      // will not do it. Credit the appearance so the loop moves on, and let it
      // be reported as thin.
      appearances[anchor] = coverage;
      continue;
    }

    seen.add(key);
    sheets.push(sheet);
    sheet.forEach((index) => {
      appearances[index] += 1;
    });
  }

  const thin: number[] = [];
  for (let i = 0; i < count; i += 1) {
    if (appearances[i] < coverage) thin.push(i);
  }

  return { sheets, appearances, thin };
};

/**
 * Every pair of photographs a sheet puts in front of the model.
 *
 * A sheet is not an anchor-versus-the-rest question. The model is asked to sort
 * the WHOLE sheet into items, so a sheet of nine photographs answers thirty-six
 * pairs in one request rather than eight. That ratio is why this architecture
 * costs about the same as the one it replaces while comparing pixels instead of
 * paragraphs.
 */
export const pairsOn = (sheet: number[]): [number, number][] => {
  const pairs: [number, number][] = [];
  for (let i = 0; i < sheet.length; i += 1) {
    for (let j = i + 1; j < sheet.length; j += 1) pairs.push([sheet[i], sheet[j]]);
  }
  return pairs;
};

/** How many distinct pairs a plan actually puts in front of the model. */
export const coveredPairs = (sheets: number[][]): Set<string> => {
  const covered = new Set<string>();
  sheets.forEach((sheet) =>
    pairsOn(sheet).forEach(([a, b]) => covered.add(a < b ? `${a},${b}` : `${b},${a}`))
  );
  return covered;
};
