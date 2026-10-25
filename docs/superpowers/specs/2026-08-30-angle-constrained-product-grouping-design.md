# Angle-Constrained Product Grouping

**Date:** 2026-08-30
**Status:** design approved, not implemented
**Replaces:** `groupFolderV2.ts` (visual/contact-sheet pipeline), `productGrouper.ts` v1 (attribute pipeline)

---

## 1. The goal

A folder of roughly 110 product photographs contains roughly 20 physical
products. Each product was photographed from several sides. The system must
return one group per physical product, holding that product's photographs and
no others.

The success criterion, stated exactly:

> ONE real physical product = ONE group containing all of its different-angle
> photographs, and NO photographs from other products.

**Product identity, not visual similarity.** Two different products that look
90% alike are two groups. Two photographs of one product that share almost no
visible surface — a profile and an underside — are one group. Colour, shape,
material and pattern similarity are not evidence of identity and must never be
treated as such.

**Under $0.20 of AI spend per 110-photograph folder.** This is a hard
architectural constraint, not a target. The architecture must make free local
evidence do as much work as possible and spend money only where a request can
materially change a grouping decision.

**Under 2 minutes wall-clock for a 110-photograph folder**, under normal
conditions. Also a hard constraint. Cost must not be bought with serialization:
independent local work runs on worker threads, independent requests run
concurrently, and independent stages overlap. Section 12 states precisely what
is guaranteed, what is not, and what the realistic worst case is.

These three pull against each other, and where they conflict the resolution is
stated rather than fudged. The largest such conflict is in section 7: the
cheapest possible scheduler is strictly serial and would take five minutes.

---

## 2. What the dataset guarantees

The shoot protocol produces **at most one photograph per angle per product**. A
product may have a front, a left, a right, a back, a top and a sole; it may have
only three of those; it will never have two fronts.

This is the single most valuable fact available, and the whole architecture is
built on it. Its content is precisely one implication and no more:

> **Two photographs labelled the same angle cannot be the same product.**

It is a **cannot-link** relation. It is not, and must never be used as, evidence
that two photographs from *different* angles are the same product. FRONT #7 and
BACK #7 have no relationship whatsoever by virtue of their positions.

**Why this is worth building on:** the pairs it eliminates are exactly the most
dangerous pairs in the folder. Two front views of two similar grey trainers are
the most confusable thing a judge will ever be shown, and they are also the
highest-cosine false neighbours any embedding will produce. Cannot-link deletes
them before anything paid looks at them, for nothing.

**Angles that carry cannot-link:** FRONT, BACK, LEFT, RIGHT, TOP, SOLE.
**Angles that do not:** CLOSEUP, OTHER. A product legitimately has two
close-ups. Those photographs lose the free guard and must earn every link from
the model.

---

## 3. Non-negotiable rules

1. **Cannot-link is absolute.** No merge may place two same-angle photographs in
   one group. No confidence overrides it.
2. **Only a confident model judgement creates a link.** Cosine similarity never
   merges anything, however high. Free evidence removes work; it never decides
   identity.
3. **No forced assignment.** There is no step anywhere that places leftover
   photographs into groups to make counts line up.
4. **Disagreement splits.** A pair judged SAME from one framing and NOT-SAME
   from another does not merge.
5. **Never invent certainty.** Where evidence is insufficient — for any reason,
   including limits of candidate recall — the outcome is Unresolved, not a
   confident answer.
6. **Free text is inert.** `because`, `category` and `colour` are shown to the
   user and read by no decision anywhere.

---

## 4. Pipeline

Three tracks start at t=0 and are independent of each other. Nothing waits on
anything it does not actually need.

```
110 photographs
  |
  +===== TRACK A ===================================================
  |  1. ANGLE PASS      ~8 requests, concurrent
  |     Runs on the RAW SCOUT THUMBS. Angle is legible without background
  |     removal, so this track waits for neither the crop nor the embedder.
  |
  +===== TRACK B ===================================================
  |  0a. CROP           local, $0, Web Workers  (isolateSubject.ts)
  |  0b. SigLIP EMBED   local, $0               (visualEmbedding.ts)
  |      needs the crops; the model DOWNLOAD overlaps track B and A both
  |
  +===== JOIN (needs angles from A and vectors from B) =============
  |
  +-- 2. CANDIDATES      local, $0    DELETE same-angle pairs; reserve one
  |                                   slot per other angle bucket; fill to ~6
  |                                   by cosine rank; angle-pair floors for
  |                                   priority and labelling only
  |
  +-- 3. IDENTITY        WAVES        anchor + up to 6 candidates per request,
  |                                   ~8-10 disjoint anchors issued at once:
  |                                   "which of these, if any, is the SAME
  |                                    physical item as photograph 0? NONE
  |                                    is a normal answer."
  |
  +-- 4. CLUSTER         local, $0    honour SAME / NOT-SAME / cannot-link,
  |                                   retain provenance
  |
  +-- 5. CLASSIFY        local, $0    Grouped / Confirmed Alone / Unresolved
```

**Why track A can start first.** The angle question asks which side of the item
is facing the camera. That is legible in an uncropped thumbnail — background
removal helps identity judgements, not orientation ones. Running it on the raw
scout removes the whole crop-then-embed chain from the critical path of the one
stage that must finish before candidates can be built.

There is no verification stage. The failure that most needs verifying —
over-merging — is prevented by rule 1 at zero cost, so paid verification would
buy little. Budget is better spent on discovery.

---

## 5. Evidence model

| Tier | Cost | May remove a candidate | May create a link |
|---|---|---|---|
| Angle cannot-link | free | yes, absolutely | never |
| SigLIP cosine | free | yes (ranking only — the floor never prunes) | **never** |
| Model, `same` + `sure` | paid | yes (records NOT-SAME) | **yes** |
| Model, hedged | paid | no | no — held as a review hint |

Answer handling:

| Model answer | Effect |
|---|---|
| `same:true,  sure:true` | identity link created |
| `same:true,  sure:false` | no link; recorded as a review hint |
| `same:false, sure:true` | NOT-SAME recorded; prunes this pair permanently |
| `same:false, sure:false` | nothing recorded |

---

## 6. Candidate generation

### The failure this stage exists to survive

Consider two products, both mostly black:

- **Product A, FRONT** — black upper, **WHITE heel tab**
- **Product B, FRONT** — black upper, **BLACK heel tab**

Different physical products. Nearly identical silhouettes, nearly identical
surfaces. SigLIP will score them **very high** — say 0.95.

Now the true match:

- **Product A, FRONT** against **Product A, LEFT** — the same shoe, from a side
  that shares almost no visible surface with the front. SigLIP scores it **0.62**.

So in this folder, and folders like it:

> **cosine(A-FRONT, B-FRONT) = 0.95 — different products**
> **cosine(A-FRONT, A-LEFT) = 0.62 — the same product**

**Overall visual similarity ranks a different product above the right one.**
Every part of candidate generation is built around surviving this, and any
mechanism that cannot survive it is a bug regardless of how reasonable it looks.

### Consequence 1: cannot-link prevents the crowding

A-FRONT and B-FRONT are both FRONT, so they are cannot-linked and **removed from
each other's candidate pools before ranking**. The 0.95 pair cannot displace the
0.62 pair, because the 0.95 pair is not a candidate at all. This is the same
mechanism as section 2, doing a second job: it deletes the highest-scoring
distractors, which is precisely where an embedding is most confidently wrong.

### Consequence 2: pools are stratified across angle buckets

Removing same-angle distractors is not sufficient. A-FRONT's remaining
neighbours could still be dominated by, say, twenty BACK views of twenty
products, pushing A-LEFT out of a top-6 list ranked globally.

So a pool **reserves at least one slot for every other angle bucket** before
filling the remainder by global rank. A photograph's candidates therefore always
span the angles available in the folder, and no single bucket can monopolize
them.

### Consequence 3: the floor never prunes

An earlier version of this design calibrated one global floor from the
same-angle negatives and dropped candidates beneath it. **That is wrong, and the
example above is why:** the negatives sit at 0.95 and the true positive at 0.62,
so a 90th-percentile floor would delete every real match in the folder. The
error is comparing two distributions that are not on one scale — changing angle
moves the vector further than changing product does.

The floor therefore does **not** prune candidates. Pools are built by rank and
stratification alone, and the floor is confined to two jobs that cannot cost
recall:

1. **Priority ordering** (section 7) — which anchors are asked first.
2. **Outcome labelling** (section 10) — whether a photograph with no confident
   link is *Confirmed Alone* or merely *Unresolved*.

And it is computed **per angle-pair**, never globally:

```
for each unordered pair of distinct angle buckets (X, Y):
    pool      = cosine(p, q) for every p in X, q in Y
    floor(X,Y) = percentile(pool, 75)
```

Each such pool is roughly 95% different-product pairs, since only one photograph
in Y matches any given photograph in X. FRONT-to-SOLE and FRONT-to-LEFT get
their own scales, which is the whole point — 0.62 may be exceptional among
FRONT-to-LEFT pairs while being unremarkable among FRONT-to-BACK ones.

A pair below its own angle-pair floor is still asked about if rank admits it. It
is simply asked *later*, and a photograph whose every candidate sits below its
floor cannot be called Confirmed Alone.

Fewer than 30 samples in an angle-pair pool disables that pair's floor. Its
candidates then sort by raw cosine and can never be Confirmed Alone.

**Candidate selection, final form:**

1. **Remove same-angle photographs.** Cannot-link. Free, absolute.
2. **Remove recorded NOT-SAME pairs.** Accumulates during the run.
3. **Reserve one slot per other angle bucket**, best candidate from each.
4. **Fill the remaining slots to K = 6** by global cosine rank.

**Pool truncation is recorded.** If a photograph had more cross-angle
neighbours than K, its pool is marked truncated. Section 10 depends on this.

---

## 7. The scheduler

Not a loop over photographs. A priority queue over *unresolved* photographs.
The request ceiling is a fuse, never a quota: if the folder resolves in 25
requests, the run makes 25.

### The serial scheduler is too slow, and the fix costs money

The cheapest possible scheduler issues one request, applies its answers, and
recomputes every pool before choosing the next anchor. Every answer therefore
informs every subsequent skip, and the request count is minimal.

It is also **strictly sequential**: 45–65 round-trips at 3–6s each is
**2.5 to 6.5 minutes**, which fails section 1's runtime constraint outright.

The resolution is **wave scheduling**, and it is an explicit trade of a little
money for a lot of time.

```
zero credible candidates  ->  Unresolved (no request; see section 10)

while queue non-empty AND budget remains:
    build a WAVE, up to 10 anchors:
        walk the queue in priority order
        take an anchor only if its candidate pool is DISJOINT from every
          pool already in this wave
        skip, free, any anchor whose remaining candidates are already:
            - in the same cluster (transitivity already answered it), or
            - cannot-linked to it (angle, or a recorded NOT-SAME)
    issue the wave concurrently
    apply all answers; union-find; propagate; re-prune every pool
```

**Disjointness is what makes a wave nearly free.** Two anchors whose candidate
pools do not overlap cannot teach each other anything within the wave — the
answer to one could not have caused the other to be skipped. So a disjoint wave
issues exactly the requests a serial run would have issued, in a tenth the time.
Overlap is where the serial version saves money, and overlapping anchors are
precisely what the disjointness test defers to the next wave.

**The cost is bounded and small.** Transitive closure across a wave boundary is
the only saving lost: an anchor that a serial run would have skipped because an
answer arriving mid-wave placed all its candidates. Expect **10–20% more
requests** than the serial minimum — roughly 5–10 extra on a 110-photograph
folder, which the budget absorbs. It is stated here rather than discovered later.

**Determinism survives.** Wave composition is a pure function of queue state and
the priority ordering below, both total. The same answers produce the same
waves.

### Priority ordering, stated exactly

Recomputed after each request, since applying answers changes every pool. In
order, highest first:

1. **Most unanswered candidates**, descending. A pool of six live candidates can
   resolve six pairs in one request; a pool of one resolves one.
2. **Best remaining candidate's margin above its angle-pair floor**, descending
   (raw cosine where that pair's floor is disabled). Among equal-sized pools,
   the one with the strongest candidate is likeliest to produce a link, and a
   link collapses more future work than a rejection. The margin rather than the
   raw cosine, because raw cosines from different angle pairs are not on one
   scale — 0.62 can be exceptional FRONT-to-LEFT while 0.80 is unremarkable
   FRONT-to-BACK (section 6). This is the floor's priority job, and its only
   scheduling influence: it reorders questions and never removes one.
3. **Folder order**, ascending. A total tie-break, so the ordering is total and
   the run is reproducible.

**Determinism is a requirement, not a nicety.** Given the same photographs and
the same model answers, the run must issue the same requests in the same order
and produce the same groups. The replay harness in section 15 is worthless
otherwise: a change to the clusterer could not be distinguished from a change in
scheduling. Every ordering in this system therefore terminates in a total
tie-break on folder order.

**Transitivity harvests.** A six-photograph product needs five links, not fifteen
comparisons. One request whose anchor matches three candidates buys three links
plus, by transitivity, the three pairs among those candidates. As clusters form,
more popped photographs are skipped outright, and the call count decays.

**Highest yield first** is not cosmetic. It front-loads the requests that
collapse the most remaining work, so a budget that runs out runs out on the
least informative questions.

**Widened net, lowest priority.** If the queue empties and budget remains, a
photograph that was Unresolved for lack of cross-angle candidates — every
neighbour same-angle or already ruled out — may be asked once against its top
six surviving neighbours regardless of rank position. This spends leftover
budget on the only work still outstanding, and never competes with primary
questions.

---

## 8. Prompts and contracts

### 8.1 Angle pass

Sheets of ~15 photographs, ~180-token prompt. Single-purpose by design: it must
not be tempted into identity work, because identity answers from a sheet chosen
for cheapness would be answers about photographs never selected as candidates.

```
This is ONE image containing N product photographs in a grid. Each photograph's
NUMBER is printed in the black band beneath it, 0 to N-1.

For each photograph, say which side of the item you are looking at.
Answer from the ITEM's own orientation, not the camera's: the BACK is the heel
end whichever way the item points in the frame.

FRONT, BACK, LEFT, RIGHT, TOP (from above), SOLE (the underside).
CLOSEUP when part of the item fills the frame. OTHER when none fits.

Also give the item's category and its colourway in two or three words.

DO NOT COMPARE THE PHOTOGRAPHS TO EACH OTHER. Do not say which show the same
item. That is not what is being asked here.

Reply with ONLY a JSON array:
[{"photo":0,"angle":"LEFT","category":"FOOTWEAR","colour":"grey black"}]
No prose, no code fences.
```

### 8.2 Identity question

One anchor drawn larger, up to six candidates. **The word "angle" does not
appear.** Angles did their work in candidate generation; showing them here would
invite the inference "different angle, therefore probably the same item", which
section 2 forbids. The rule is kept pure by making the information unavailable
rather than by asking the model to ignore it.

```
Photograph 0, shown alone at the left, is the ANCHOR. Photographs 1 to N are
candidates. Numbers are printed beneath each.

FOR EACH CANDIDATE, ANSWER ONE QUESTION: is it a photograph of THE SAME
INDIVIDUAL PHYSICAL ITEM as photograph 0?

NONE OF THEM MAY BE. That is a normal and common answer. These candidates were
chosen because they looked broadly similar, not because any is a match.
Answering "no" to every one is expected on many sheets and costs nothing.

SAME item:
- the same object from another side, distance, rotation, or crop. A profile, a
  heel-on view and an underside of one shoe share almost no visible surface and
  are one shoe.
- a close-up of part of the object, and the object it is part of.
- the same object in different light, on a different surface, laced differently.

DIFFERENT items - this folder is full of near-identical products, so this is
the answer that needs care:
- a different colourway of the same model.
- THE SOLE IS PART OF THE COLOURWAY. Black upper on a white outsole and black
  upper on a black outsole are two products.
- a different outsole tread, or the same tread with colour in different places.
- a different stripe, panel or overlay - in shape OR in tone.
- a logo in a different colour, size or position.
- a different lining, collar, tongue or lace colour.
- a different eyelet count, heel tab, toe bumper or shaft height.

BROAD SIMILARITY IS NOT EVIDENCE. "Both are mostly black trainers with a similar
shape" describes half this folder. Identity lives in the SMALL DISTINCTIVE
DETAILS: a white heel tab against a black one, a logo's exact colour and place,
the tread's geometry, the collar lining's tone. One such detail differing, with
the rest alike, means DIFFERENT items — that is what a colourway is. Judge on
the details you can actually see, never on overall impression.

THE BACKGROUND IS NOT EVIDENCE. A shared table, shelf, carpet, hand, box or
price tag tells you nothing. Two items on one table are two items.

DO NOT EXPLAIN A COLOUR DIFFERENCE AWAY AS LIGHTING unless the WHOLE photograph
is shifted the same way. Light moves every part together; a colourway changes
one part and leaves the rest alone.

A PART YOU CANNOT SEE IS NOT A PART THAT DIFFERS. A collar out of frame is a
missing observation, not a difference.

"sure": true only when you would stake the catalogue on it. False when the
photograph is too dark, too cropped or too small, when the detail you needed is
not visible, or when you are choosing between two near-identical products
rather than recognising one. "false" costs nothing; a confident wrong answer is
expensive.

"because": AT MOST SIX WORDS. Name the feature, nothing more:
"black outsole vs white", "same heel logo", "different stripe shape".

Reply with ONLY a JSON array, one object per candidate:
[{"photo":1,"same":true,"sure":true,"because":"same black collar lining"},
 {"photo":2,"same":false,"sure":true,"because":"white midsole, anchor black"}]
No prose, no code fences.
```

`because` is capped in the prompt **and truncated by the reader regardless**.
Output tokens are the expensive half of a request, and a model that starts
explaining itself is a model spending the budget on prose.

### 8.3 Reader discipline

Both readers **drop** entries they cannot parse rather than defaulting them. A
defaulted answer is an invented judgement that enters the graph indistinguishable
from a real one. `sure` absent is read as *not sure*.

---

## 9. Clustering and provenance

Constrained union-find. A merge is attempted only for a `same:true, sure:true`
link, and is refused when it would place two same-angle photographs in one
group, or when a NOT-SAME is recorded between any cross-pair of the two
clusters.

Transitivity groups photographs. It does not license claiming the model
verified a pair it never saw.

```ts
interface Link {
  a: string; b: string;
  same: boolean;
  sure: boolean;
  because?: string;      // <= 6 words, inert
  anchor: string;        // whose question produced this
  requestId: string;
}

interface GroupedImage {
  // ...existing fields
  joinedVia?: {
    to: string;
    kind: 'direct' | 'indirect';
    because?: string;    // present only when kind === 'direct'
    hops?: number;       // chain length when indirect
  };
}
```

Every group retains the spanning tree of direct links holding it together, plus
the list of member pairs never directly compared. The review screen renders
`joined to 4 - "black collar lining"` against `connected through 4 - never
compared directly`.

---

## 10. Outcome taxonomy

Three outcomes, and conflating any two of them is a correctness bug.

### Grouped
Two or more photographs joined by confident links, no cannot-link violated.

### Confirmed Alone
A genuine one-photograph product. Requires **all four** to hold:

1. The photograph received an identity request (not skipped, not truncated by
   budget).
2. Every candidate shown was answered `same:false, sure:true`. A single hedge
   disqualifies.
3. Its candidate pool was **not truncated** — no cross-angle neighbour was
   pushed out of the pool by K without being shown.
3b. At least one candidate shown sat **above its angle-pair floor** — the model
   was shown at least one genuinely plausible match and still said no. A
   photograph whose every candidate was weak has only rejected weak candidates,
   which proves nothing about the strong one that may never have surfaced.
4. **Reciprocally clean:** no other photograph still lists this one as an
   unanswered credible candidate.

### Unresolved -> Uncertain tray
Everything else, each carrying its reason:

- budget ceiling reached
- request failed or came back unreadable
- model hedged
- **zero cross-angle candidates** — every neighbour was same-angle or already
  ruled out. This is a statement by *embeddings and bucket sizes*, and
  embeddings are not permitted to decide identity. It is a recall limitation,
  not evidence of solitude
- **no candidate above its angle-pair floor was ever shown** — the model only
  ever rejected implausible matches (Confirmed Alone condition 3b failing)
- pool truncated with unshown credible candidates remaining

The distinction that matters: a photograph shown as Confirmed Alone asserts
"this is a one-photograph product". A photograph in Uncertain asserts only "the
system could not establish this". The second is often the honest answer and the
system must prefer it.

---

## 11. Budget

**Ceiling: $0.20 per folder, measured in money.** Request count is a secondary
fuse (90) against a pathological folder, never a definition of the budget —
payload sizes and model rates vary, so a fixed call count is not a reliable
proxy for spend.

Requires plumbing that does not exist today:

- `server.js` forwards Gemini `usageMetadata`
- the OpenAI adapter carries an equivalent (it currently reshapes responses to
  `{candidates:[{content:{parts:[{text}]}}]}` and discards usage)
- `costMeter.ts` holds per-model rates, accumulates actual usage, and gates
  **before** each request

Rates are configuration, filled from the provider dashboard. They are not to be
guessed.

Expected shape of a 110-photograph run:

| Stage | Requests |
|---|---|
| Angle pass | ~8 |
| Identity, after skips | ~35-55 |
| Wave-boundary overhead (section 7), +10-20% | ~5-10 |
| **Total** | **~50-73** |

---

## 12. Runtime

**Target: under 2 minutes for 110 photographs.** What follows separates what the
architecture guarantees from what it cannot, because the second half depends on
machines and providers this code does not control.

### Expected timeline — warm model cache, WebGPU, healthy API

| t | Track A | Track B |
|---|---|---|
| 0s | angle pass issued, 8 concurrent | crop starts on workers |
| ~8s | angles complete | cropping continues |
| ~15s | idle | crop done, embed starts |
| ~35s | | vectors done |
| ~36s | JOIN: angle-pair floors + candidate pools (<1s) | |
| ~36-75s | identity waves, ~6 waves of ~10 concurrent | |
| ~76s | cluster + classify (<1s) | |

**≈ 75 seconds.** Meets the target with roughly 40% headroom.

### Bottlenecks, ranked

1. **SigLIP cold download, ~100MB.** 30-90s on a normal connection, and it
   blocks all of track B. **Mitigation: preload at application start**, not at
   folder submit — the download then overlaps the user choosing and uploading
   their folder, and is usually finished before grouping is even requested.
   After the first run the browser cache makes it free.
2. **WASM embedding fallback.** `visualEmbedding.ts` states it is several times
   slower than WebGPU. On a machine without WebGPU, embedding alone can be
   60-150s and the target is unreachable. **Not fixable in this design.**
   Reported in the run log, with `?embed=off` offered as the escape: it drops to
   the cheap signature distances, which is fast but costs recall and money.
3. **Cropping.** Per-pixel JS loops, currently at `mapWithConcurrency(photos, 4)`
   on the main thread — which interleaves rather than parallelizes, since it is
   one thread. **Mitigation: move to Web Workers**, giving real parallelism
   across cores and unblocking the UI. Expect 15-25s on four workers.
4. **Identity request latency.** Addressed by wave scheduling (section 7).
   Serial would be 2.5-6.5 minutes; waves bring it to 35-45s.

### What is guaranteed

- No stage waits on work it does not need. Track A never waits for the crop or
  the embedder.
- No independent request is issued sequentially. Angle sheets go out together;
  identity anchors go out in waves.
- No CPU-bound local work runs on the main thread.
- Per-stage elapsed times are reported in the run log, so a slow run names its
  own bottleneck instead of being a mystery.

### What is NOT guaranteed, and the realistic worst case

| Cause | Effect | Worst case |
|---|---|---|
| Provider latency beyond ~6s/request | waves stretch | +60s |
| Rate limiting (429) | waves forcibly serialize — this is the one failure that defeats the whole strategy | 3-5 min |
| Cold model download, no preload | track B blocked | +30-90s |
| No WebGPU (WASM path) | embedding dominates | 2.5-4 min |
| Low-core machine | crop workers do not parallelize | +20-40s |

**Honest summary: under 2 minutes is achievable and expected on a warm cache,
WebGPU-capable machine with a healthy API — and is not guaranteeable in
general.** The realistic worst case is 3-5 minutes, and the dominant causes are
provider rate limiting and the WASM fallback, neither of which this architecture
can remove. What it can do, and does, is never be the cause itself: every delay
in the list above originates outside this code.

If the first real folder run exceeds the target, the run log will already say
which of these five it was.

---

## 13. Degradation

Every fallback costs recall or money. None costs correctness.

| Failure | Behaviour |
|---|---|
| No WebGPU | WASM, slower, logged |
| No embedder at all | Candidates from `imageSignature` distances. Worse recall, more requests. **Never** falls back to "all cross-angle pairs are candidates" — that would silently blow the budget |
| Angle pass fails for a sheet | Those photographs get no angle, so no cannot-link. They still run, without the free guard. Never blocks |
| Malformed model reply | Entry dropped, never defaulted |
| API fails mid-run | Established groups kept; remainder Unresolved with the reason |
| Budget reached | Same. Checked before the request, not after |

Nothing fabricates a grouping to finish cleanly.

---

## 14. Review screen

- **Provenance line per photograph** — direct vs indirect, with the model's own
  six words on direct links
- **Angle badge** — existing `view` field
- **Duplicate-angle assertion** — rule 1 makes this impossible; if it ever
  appears the group is flagged loudly. An invariant that is not checked is a hope
- **Mislabelled-angle hint** — when an Unresolved photograph's nearest
  neighbour is a same-angle photograph inside a group, the angle label may be
  wrong and the split may be spurious. Surfaced, never acted on. Free
- **Uncertain tray** shows each photograph's *reason*, not just its presence
- **Run log** — requests made, estimated spend, where it stopped and why

---

## 15. Testing

There is no answer key: the user has declined labelling. Tests therefore score
invariants and behaviour, which is where the named failures live.

- **Property test, fuzzed** — across random judgement streams, no group ever
  contains two same-angle photographs. This is the central requirement and gets
  a property test, not an example
- **No forced assignment** — a photograph with only hedged evidence never lands
  in a group
- **Outcome taxonomy** — each of the four Confirmed Alone conditions, tested
  failing independently, yields Unresolved
- **Provenance** — every group's direct-link spanning tree connects it; indirect
  pairs are marked indirect with correct hop counts
- **Scheduler** — skip logic fires; call count decays as clusters form; the
  ceiling truncates before a request, not after
- **Wave disjointness** — no two anchors in one wave share a candidate; a wave
  never exceeds its size limit; an anchor deferred for overlap is picked up in a
  later wave rather than dropped
- **Wave overhead is bounded** — on synthetic folders, the wave scheduler issues
  no more than 25% more requests than the serial scheduler would for the same
  answers. This is the trade section 7 makes explicit, and it needs a number
  guarding it or it will drift
- **Determinism** — the same photographs and the same model answers produce the
  same request sequence and the same groups, across repeated runs. The replay harness below and section 7's ordering both depend on this
- **Floor discipline** — floors are computed per angle-pair; an under-sampled
  pair (<30) disables its floor rather than producing one from noise; and NO
  code path uses a floor to remove a candidate from a pool. The last part is a
  test because it was a design error once already
- **Heel-tab regression (the crowding case)** — a synthetic folder in which
  cosine(A-FRONT, B-FRONT) = 0.95 for two DIFFERENT products and
  cosine(A-FRONT, A-LEFT) = 0.62 for the SAME product. The test asserts:
  (1) B-FRONT never appears in A-FRONT's candidate pool (cannot-link),
  (2) A-LEFT DOES appear in A-FRONT's pool (stratification holds against a
  crowd of higher-cosine cross-angle distractors), and (3) with replayed model
  answers, A-FRONT and A-LEFT group together while B-FRONT stays apart. This
  encodes the exact failure the user described and must never regress
- **Parsers** — malformed input dropped, never defaulted; missing `sure` reads
  as not sure
- **Cost meter** — accumulates from usage; blocks at the ceiling

**Replay harness.** One live run records every API response to a fixture.
Replaying it offline is free and deterministic, so a change to the clusterer or
scheduler is measured against fixed model answers and any difference in output
is attributable to the change. It does not establish truth. It makes every
subsequent change measurable rather than anecdotal, and it costs one folder run.

---

## 16. Files

**New**, one job each:

| File | Job |
|---|---|
| `services/angleAtlas.ts` | angle pass, cannot-link sets |
| `services/candidatePool.ts` | candidate generation, pruning, truncation record |
| `services/identityQuestion.ts` | anchor prompt, parse, `because` truncation |
| `services/linkGraph.ts` | constrained union-find, provenance, group build |
| `services/costMeter.ts` | rates, accumulation, pre-call gate |
| `services/groupFolder.ts` | orchestrator, wave scheduler, stage timings |
| `services/cropWorker.ts` | Web Worker entry for background removal |

**Reused unchanged:** `visualEmbedding.ts`, `imageSignature.ts`

**Extended:**
- `contactSheet.ts` — anchor layout; currently a uniform grid with no way to
  emphasise a cell
- `aiProvider.ts` and `server.js` — usage passthrough for the cost meter
- `isolateSubject.ts` — the pixel work moves behind a worker pool. The algorithm
  is unchanged; only where it runs changes
- application startup — SigLIP preload begins at app start rather than at folder
  submit, so the ~100MB download overlaps the user's own upload time
  (section 12, bottleneck 1)

**Extracted:** shared types and UI helpers out of the 2,507-line
`productGrouper.ts` into `services/productModel.ts`, so the new pipeline does
not import from the old one

**Retired, but not yet:** `groupFolderV2.ts`, `neighbourGraph.ts`,
`signedGraph.ts`, `visualJudge.ts`, `photoClustering.ts`, `productFingerprint.ts`
and their tests. Deleted only after the new pipeline has run on a real folder
and beaten them there. All are uncommitted work in progress, so deletion is
cheap — but deleting the fallback before the replacement is proven leaves
nothing that works.

---

## 17. Known risks

**Angle labelling is load-bearing.** A photograph labelled LEFT when it is RIGHT
lands in the wrong bucket and may be cannot-linked to its own product's other
side, forcing a spurious split. The user reports angle labelling is currently
reliable. The failure is bounded: it causes over-splitting, never over-merging,
and section 14's free hint surfaces the likely cases.

**SigLIP cross-angle recall is unmeasured.** If a product's profile and underside
are not near each other in embedding space, the pair never becomes a candidate
and the product fragments. The widened-net pass (section 7) partially covers
this; a systematic weakness would show up as many Unresolved photographs, which
is at least a visible failure.

**Cross-angle similarity is often LOWER than similar-product same-angle
similarity, and the design must never forget it.** The heel-tab case in
section 6: two different mostly-black products photographed from the front can
score 0.95 while one product's front and side score 0.62. An earlier draft
calibrated a global pruning floor from same-angle pairs, which would have
deleted every true match in such a folder; that is why the floor never prunes
and why pools are stratified across angle buckets. The residual risk is
K itself: a folder crowded enough that six slots cannot hold a reserved
candidate from every angle bucket will drop buckets, and the dropped bucket may
hold the true match. K is a named constant; raising it costs money linearly and
is the first dial to try if real folders fragment.

**Model rates are unknown at design time.** The $0.20 ceiling is enforced by the
cost meter, so an unexpectedly expensive model produces a truncated run rather
than an unexpected bill — but it produces a *worse* run, and the rate config
must be filled with real numbers before the ceiling means anything.

**No answer key.** Invariant tests plus the replay harness cannot tell us the
grouping is correct, only that it is self-consistent and that changes are
attributable. Correctness remains a human judgement made in the review screen.

**Rate limiting defeats wave scheduling.** The entire runtime argument rests on
issuing ~10 requests concurrently. A provider that returns 429 forces backoff,
backoff serializes the waves, and the run returns to the 2.5-6.5 minute figure
the wave design existed to avoid. There is no architectural defence: the work is
genuinely parallel and the provider is genuinely refusing to do it in parallel.
Wave width should therefore be a single named constant, easily lowered, and the
run log must distinguish "slow" from "rate limited" so the cause is visible
rather than inferred.

**Three hard constraints, one of which must yield first.** Accuracy, $0.20 and
2 minutes cannot all be guaranteed simultaneously on an unknown machine and an
unknown provider. The order of sacrifice is fixed and deliberate: **runtime
degrades first** (a slow run is still correct), **then cost** (the ceiling
truncates and the remainder is honestly reported as Unresolved), **and accuracy
never** — no stage may invent a grouping to meet a budget or a deadline. Every
mechanism in this document is consistent with that order.
