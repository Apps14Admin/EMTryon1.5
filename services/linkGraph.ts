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
  | 'refused-angle' | 'refused-different' | 'ignored-unsure' | 'pending';

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
  // Change A: a merge needs two independently-anchored sure-SAME votes. The
  // first sure SAME for a pair parks here rather than merging; a second vote
  // anchored from the OTHER member confirms it (a second vote from the same
  // anchor is a repeat of the same framing, not corroboration).
  private pendingSame = new Map<string, Link>(); // idPair -> the one vote so far
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
      if (this.pendingSame.delete(pair)) {
        // One framing said SAME, the other said DIFFERENT: the merge never
        // happens, but silently dropping the pending vote would hide a real
        // disagreement (spec rule 4, disagreement splits/flags).
        this.contestedPairs.add(pair);
      }
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

    // Change A: the pair survived every refusal, but a merge still needs a
    // SECOND sure-SAME vote anchored from the other member before it goes
    // through - one sure judgment chained five one-vote merges into a single
    // group of six different products in the real folder that motivated
    // this change.
    const pending = this.pendingSame.get(pair);
    if (!pending) {
      this.pendingSame.set(pair, link);
      return 'pending';
    }
    if (pending.anchor === link.anchor) {
      // Same framing asked (or answered) twice - not corroboration.
      return 'pending';
    }
    this.pendingSame.delete(pair);

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

  /** Pairs holding exactly one sure-SAME vote - the orchestrator's reciprocal
   * round asks the un-asked side about these before treating them as review
   * hints or, worse, orphans. */
  pendingPairs(): { a: string; b: string; anchor: string }[] {
    return [...this.pendingSame.values()].map(({ a, b, anchor }) => ({ a, b, anchor }));
  }

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

    // BFS from the cluster's first member (folder order). Every tree edge is
    // a 'direct' link (it came straight from a sure-SAME Link) with that
    // link's `because`. Entries reached at depth > 1 additionally carry
    // `hops: depth` to signal the relationship to the anchor is transitive;
    // depth-1 entries carry no `hops` field at all.
    const provenance = new Map<string, Provenance>();
    const depth = new Map<string, number>([[start, 0]]);
    const queue = [start];
    while (queue.length) {
      const at = queue.shift()!;
      const atDepth = depth.get(at) ?? 0;
      const next = (edges.get(at) ?? [])
        .sort((x, y) => (this.order.get(x.to) ?? 0) - (this.order.get(y.to) ?? 0));
      for (const { to, because } of next) {
        if (depth.has(to)) continue;
        const toDepth = atDepth + 1;
        depth.set(to, toDepth);
        const entry: Provenance = { to: at, kind: 'direct', because };
        if (toDepth > 1) entry.hops = toDepth;
        provenance.set(to, entry);
        queue.push(to);
      }
    }
    return provenance;
  }
}
