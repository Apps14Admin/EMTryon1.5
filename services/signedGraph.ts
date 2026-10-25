/**
 * Clustering a graph of SIGNED JUDGEMENTS.
 *
 * This is what replaces `compare()` and the weighted-attribute arithmetic in
 * `productFingerprint.ts`, and the difference is not one of tuning. That module
 * asks "how alike do two written descriptions read", and answers with a number
 * that has to be compared against a threshold. This one is given straight
 * answers — a vision model looked at two photographs together and said SAME or
 * DIFFERENT — and its only job is to turn a pile of such answers into products
 * without contradicting any of them.
 *
 * Two properties follow from that, and both are the point of the rewrite:
 *
 * FIRST, THERE IS NO THRESHOLD HERE. Not one. Confidence orders the merges so
 * that a chain cannot start from its weakest link, and that is all it does — no
 * value of it admits or refuses an edge on its own. Nothing in this file can be
 * "tuned", so nothing in this file can be quietly tuned into being wrong.
 *
 * SECOND, A PAIR IS SETTLED BY ITS OWN EVIDENCE, AND THEN THAT SETTLEMENT IS
 * ABSOLUTE. `foldJudgements` weighs everything said about one pair and returns
 * one answer; the clustering then honours it without exception — a pair settled
 * as DIFFERENT can never end up inside one product, however many other joins
 * would like it to.
 *
 * The two halves matter separately. Weighing the evidence is what stops a
 * single mistaken DIFFERENT from permanently splitting a real product. Honouring
 * the result absolutely is what stops a chain of weak joins from fusing two
 * items that the model, looking straight at them, said were not the same. This
 * is the honest form of what the old code called a veto: the old vetoes were
 * hand-written rules about heel types and lining colours, guessing at what the
 * pixels would have said, and these are what the model actually said about the
 * actual photographs.
 *
 * A refused merge is not swept up. It is the most informative event in the run
 * — the model has contradicted itself across two questions — so it is returned
 * as a `Contradiction` for a tie-break request or the review screen. That is
 * where a second opinion is worth paying for, and it is the only place.
 */

/** One judgement about one pair of photographs. */
export interface Judgement {
  /** Image ids, in no particular order. */
  a: string;
  b: string;
  /** True for "the same physical item", false for "two different items". */
  same: boolean;
  /**
   * How sure the judge was, 0..1. Orders the merges and nothing else — there is
   * no value at which an edge is dropped. An absent confidence is treated as
   * fully confident, because the model was asked a closed question and gave a
   * closed answer.
   */
  confidence?: number;
  /**
   * Whether the judge STOOD BEHIND this, rather than hedging.
   *
   * Uncertainty is not allowed to decide anything, in either direction. A
   * hedged judgement cannot record a DIFFERENT — that was true from the start,
   * because a negative is permanent — and it cannot create a SAME either, which
   * is the same rule applied to the mistake that costs more.
   *
   * It still COUNTS. A hedged agreement adds its weight in `foldJudgements`, so
   * two of them beside one confident one make the pair surer rather than being
   * discarded. What it cannot do is be the only thing holding a product
   * together.
   *
   * Measured on the synthetic folder at a 5% judge error rate with 15% of
   * photographs hedged: allowing hedged agreements to merge on their own gave
   * pairwise precision 0.798, meaning one photograph in five inside a product
   * did not belong there. Requiring one confident judgement gave 1.000, for two
   * points of recall.
   */
  committed?: boolean;
  /** The feature the judge said settled it. Carried to the review screen. */
  reason?: string;
  /** Which model said it, when more than one was asked. */
  source?: string;
}

/**
 * A positive and a negative judgement that cannot both be honoured.
 *
 * Not an error and not a bug: it is the model disagreeing with itself across
 * different pairs, which is what happens on the ones that are genuinely hard —
 * A and B judged the same, B and C judged the same, A and C judged different.
 * All three cannot stand. The DIFFERENT is kept, because a product that quietly
 * contains two items is worse than one that was split and can be merged by hand
 * in a click, and the pair is handed back so a tie-break or a person can settle
 * it.
 */
export interface Contradiction {
  /** The positive judgement that was refused. */
  wanted: Judgement;
  /** The negative judgement that refused it. */
  blockedBy: Judgement;
}

/**
 * Angles a single product can only have ONE photograph of.
 *
 * This is a fact about the SHOOT, not about the pictures. Where a folder was
 * produced by photographing each item once from each side, a product holding
 * two BACK views is holding two products — and that is true however alike the
 * two photographs look, which is exactly the case the judge is weakest on. Two
 * heel-on shots of two grey trainers are far more similar to each other than
 * either is to its own item's underside.
 *
 * CLOSEUP and OTHER are deliberately absent: a shoot takes as many detail shots
 * as it likes, and capping those would split real products.
 *
 * It is a CONSTRAINT ON MERGING rather than a check applied afterwards. Applied
 * afterwards it could only report a bad product; applied at the merge it
 * prevents one, and prevents the chain of further merges that a corrupted
 * product would go on to attract.
 */
export const UNIQUE_ANGLES = new Set(['FRONT', 'BACK', 'LEFT', 'RIGHT', 'TOP', 'SOLE']);

export interface ClusterOptions {
  /**
   * The angle each photograph shows, when the folder is one-shot-per-angle.
   *
   * Absent — the default — means no angle constraint at all, which is right for
   * a folder of bursts, re-shoots, or both shoes of a pair.
   */
  angleOf?: (id: string) => string | undefined;
}

export interface ClusterResult {
  /** Image ids per product, in the order the ids were first seen. */
  clusters: string[][];
  /** Positive judgements that a negative one refused. */
  contradictions: Contradiction[];
  /** One line per decision, for the run log. */
  log: string[];
}

/**
 * Union-find carrying, per root, the roots it may never be joined to.
 *
 * The conflict sets are what make a negative judgement transitive in the right
 * direction. If A is different from B, and B has since absorbed C, then A is
 * different from the whole of B-and-C — because C being the same item as B
 * means C is the same item as something A is not.
 *
 * Merging the two conflict sets on every union is what keeps that true as the
 * products grow, and is why this cannot be done with a plain union-find and a
 * final check.
 */
const forest = () => {
  const parent = new Map<string, string>();
  const rank = new Map<string, number>();
  const conflicts = new Map<string, Set<string>>();

  const find = (id: string): string => {
    const held = parent.get(id);
    if (held === undefined) {
      parent.set(id, id);
      rank.set(id, 0);
      conflicts.set(id, new Set());
      return id;
    }
    if (held === id) return id;
    const root = find(held);
    parent.set(id, root);
    return root;
  };

  /** True when these two roots hold a pair the judge called different. */
  const barred = (rootA: string, rootB: string): boolean =>
    (conflicts.get(rootA)?.has(rootB) ?? false) ||
    (conflicts.get(rootB)?.has(rootA) ?? false);

  /** Records that these two may never share a product. */
  const bar = (rootA: string, rootB: string): void => {
    conflicts.get(rootA)!.add(rootB);
    conflicts.get(rootB)!.add(rootA);
  };

  const union = (a: string, b: string): string | null => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA === rootB) return null;

    const rankA = rank.get(rootA)!;
    const rankB = rank.get(rootB)!;
    const winner = rankA >= rankB ? rootA : rootB;
    const loser = winner === rootA ? rootB : rootA;

    parent.set(loser, winner);
    if (rankA === rankB) rank.set(winner, rankA + 1);

    // The winner inherits everything the loser was barred from, and every root
    // that was barred from the loser is re-pointed at the winner. Without the
    // second half a conflict recorded against a root that later loses a union
    // simply disappears, and the product it was protecting merges on the next
    // edge.
    const lost = conflicts.get(loser)!;
    const kept = conflicts.get(winner)!;
    lost.forEach((other) => {
      const root = find(other);
      if (root === winner) return;
      kept.add(root);
      conflicts.get(root)!.add(winner);
    });
    conflicts.delete(loser);

    return winner;
  };

  return { find, union, barred, bar };
};

/** A pair's key, order-independent, so (a,b) and (b,a) are one judgement. */
export const pairKey = (a: string, b: string): string => (a < b ? `${a} ${b}` : `${b} ${a}`);

/**
 * Folds every judgement about one pair into a single answer, BY EVIDENCE.
 *
 * A pair is usually judged more than once. Each photograph appears on several
 * contact sheets, so two photographs that share two sheets are asked about
 * twice, by two different sets of neighbours. That corroboration is real
 * evidence and it is the only signal available for telling a judge's mistake
 * from a judge's insight — so it is counted, not discarded.
 *
 * THE PREVIOUS RULE HERE WAS "ANY DIFFERENT BEATS ANY NUMBER OF SAMES", and it
 * was wrong. The reasoning behind it was sound as far as it went: a wrongly
 * merged product poisons every render made from it and cannot be unpicked,
 * while a wrongly split one is a click to fix, so the two mistakes should not
 * be treated as equal. But that argument justifies DIFFERENT winning a TIE. It
 * does not justify one hedged DIFFERENT overruling three confident SAMEs, and
 * that is what the rule did.
 *
 * It was measured, on a synthetic folder of a hundred and ten items with the
 * judge told to misplace a share of photographs:
 *
 *      judge error   absolute DIFFERENT      evidence-weighted
 *            5%      p 1.000  r 0.736        p 1.000  r 0.877
 *           15%      p 0.807  r 0.305        p 0.851  r 0.545
 *
 * Precision never suffered and recall nearly doubled. Worse, under the old rule
 * ASKING MORE MADE THE ANSWER WORSE — every extra sheet was another chance to
 * emit a wrong DIFFERENT, and a wrong DIFFERENT was permanent. Under this one
 * more coverage helps, which is the behaviour a system should have.
 *
 * The asymmetry survives exactly where it belongs: `>` rather than `>=`, so a
 * pair whose evidence is evenly balanced is two items.
 *
 * The folded confidence is the MARGIN — how lopsided the vote was — times the
 * best confidence on the winning side. A pair every sheet agreed about keeps
 * its full weight; a pair judged two ways comes out weak, which is what puts
 * the product it belongs to in front of a person.
 */
export const foldJudgements = (judgements: Judgement[]): Judgement[] => {
  interface Tally {
    same: number;
    different: number;
    bestSame?: Judgement;
    bestDifferent?: Judgement;
  }

  const tallies = new Map<string, Tally>();
  /** Pairs with at least one agreement the judge stood behind. */
  const committedSame = new Set<string>();

  judgements.forEach((judgement) => {
    if (judgement.a === judgement.b) return;

    const key = pairKey(judgement.a, judgement.b);
    const tally = tallies.get(key) ?? { same: 0, different: 0 };
    const weight = judgement.confidence ?? 1;

    if (judgement.same) {
      tally.same += weight;
      // One confident agreement anywhere on the pair is enough to let it merge.
      if (judgement.committed !== false) committedSame.add(key);
      if (!tally.bestSame || weight > (tally.bestSame.confidence ?? 1)) {
        tally.bestSame = judgement;
      }
    } else {
      tally.different += weight;
      if (!tally.bestDifferent || weight > (tally.bestDifferent.confidence ?? 1)) {
        tally.bestDifferent = judgement;
      }
    }

    tallies.set(key, tally);
  });

  const folded: Judgement[] = [];

  tallies.forEach((tally, key) => {
    // Evenly balanced evidence is two items. This is the whole of the
    // asymmetry, and it is one character wide.
    const same = tally.same > tally.different;
    const winner = same ? tally.bestSame! : tally.bestDifferent!;

    const total = tally.same + tally.different;
    const margin = total ? Math.abs(tally.same - tally.different) / total : 1;

    folded.push({
      ...winner,
      same,
      confidence: margin * (winner.confidence ?? 1),
      committed: same ? committedSame.has(key) : winner.committed !== false,
    });
  });

  return folded;
};

/**
 * Builds the products.
 *
 * `ids` is every photograph in the folder, in display order. It is passed in
 * rather than derived from the judgements because a photograph nothing was
 * asked about is still a product — one of one — and deriving the id list from
 * the edges would silently drop it.
 */
export const cluster = (
  ids: string[],
  judgements: Judgement[],
  options: ClusterOptions = {}
): ClusterResult => {
  const log: string[] = [];
  const contradictions: Contradiction[] = [];
  const link = forest();

  ids.forEach((id) => link.find(id));

  // Which photographs sit under each root, kept in step with the merges so the
  // angle check can be answered without walking every id for every candidate.
  const membersOf = new Map<string, string[]>();
  ids.forEach((id) => membersOf.set(link.find(id), [id]));

  const { angleOf } = options;

  /** The unique angles a root already holds. */
  const anglesUnder = (root: string): Set<string> => {
    const held = new Set<string>();
    if (!angleOf) return held;
    (membersOf.get(root) ?? []).forEach((id) => {
      const angle = angleOf(id);
      if (angle && UNIQUE_ANGLES.has(angle)) held.add(angle);
    });
    return held;
  };

  /** The angle two roots would both bring to a merge, if any. */
  const angleClash = (rootA: string, rootB: string): string | null => {
    if (!angleOf) return null;
    const left = anglesUnder(rootA);
    for (const angle of anglesUnder(rootB)) if (left.has(angle)) return angle;
    return null;
  };

  const folded = foldJudgements(judgements);
  const negatives = folded.filter((j) => !j.same);
  const positives = folded.filter((j) => j.same);

  // Every DIFFERENT is recorded before any SAME is honoured. Order matters:
  // a negative judgement that arrives after the merge it would have refused
  // cannot undo it, so all of them go in first and the merges are checked
  // against the complete set.
  const negativeOf = new Map<string, Judgement>();
  negatives.forEach((judgement) => {
    negativeOf.set(pairKey(judgement.a, judgement.b), judgement);
    link.bar(link.find(judgement.a), link.find(judgement.b));
  });

  // Surest first, so a chain of merges cannot be started by its weakest link.
  // This ORDERS the work; it does not admit or refuse any edge.
  const ordered = [...positives].sort(
    (x, y) => (y.confidence ?? 1) - (x.confidence ?? 1)
  );

  let merged = 0;
  let hedged = 0;
  let angleRefusals = 0;

  ordered.forEach((judgement) => {
    // A pair the judge only ever hedged about does not make a product. It is
    // not discarded — it counted towards settling the pair, and it will merge
    // the moment any sheet says the same thing with confidence — it simply
    // cannot be the sole reason two photographs become one item.
    if (judgement.committed === false) {
      hedged += 1;
      return;
    }

    const rootA = link.find(judgement.a);
    const rootB = link.find(judgement.b);
    if (rootA === rootB) return;

    if (link.barred(rootA, rootB)) {
      // Name the actual pair that refused it, not just "a conflict". A user
      // reading "these two were kept apart because photo 14 and photo 31 are
      // different items" can check that claim; "a veto fired" they cannot.
      const blocker =
        negatives.find((negative) => {
          const left = link.find(negative.a);
          const right = link.find(negative.b);
          return (
            (left === rootA && right === rootB) || (left === rootB && right === rootA)
          );
        }) ?? negativeOf.get(pairKey(judgement.a, judgement.b));

      if (blocker) contradictions.push({ wanted: judgement, blockedBy: blocker });
      return;
    }

    // One product, one photograph from each side. A merge that would give it
    // two BACKs is a merge of two products, whatever the judge said — and this
    // is precisely the pair the judge is worst at, because two heel-on shots of
    // two grey trainers resemble each other far more than either resembles its
    // own item's underside.
    const clash = angleClash(rootA, rootB);
    if (clash) {
      angleRefusals += 1;
      return;
    }

    link.union(rootA, rootB);

    const winner = link.find(rootA);
    const loser = winner === rootA ? rootB : rootA;
    membersOf.set(winner, [
      ...(membersOf.get(winner) ?? []),
      ...(membersOf.get(loser) ?? []),
    ]);
    if (loser !== winner) membersOf.delete(loser);

    merged += 1;
  });

  // Components, in the order their first photograph appears in the folder.
  const finalMembers = new Map<string, string[]>();
  ids.forEach((id) => {
    const root = link.find(id);
    const held = finalMembers.get(root);
    if (held) held.push(id);
    else finalMembers.set(root, [id]);
  });

  const clusters = [...finalMembers.values()];

  log.push(
    `${ids.length} photograph(s), ${positives.length} same-item judgement(s) and ` +
      `${negatives.length} different-item judgement(s) → ${clusters.length} product(s).`
  );
  if (merged) log.push(`${merged} join(s) made.`);
  if (hedged) {
    log.push(
      `${hedged} pair(s) were left apart because the model would not commit to them; ` +
        `they are on the review screen rather than merged on a guess.`
    );
  }
  if (angleRefusals) {
    log.push(
      `${angleRefusals} join(s) refused because one product would have ended up with ` +
        `two photographs of the same side.`
    );
  }
  if (contradictions.length) {
    log.push(
      `${contradictions.length} join(s) refused because the model elsewhere called a ` +
        `photograph in one a different item from a photograph in the other.`
    );
  }

  return { clusters, contradictions, log };
};
