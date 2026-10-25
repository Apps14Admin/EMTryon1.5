/**
 * COHERENCE VERIFICATION OF A FINISHED GROUP.
 *
 * The wave loop (with Change A's two-vote merges) is careful about how it
 * joins photographs, but "careful going in" is not the same guarantee as
 * "correct coming out" — a real folder still produced groups that were
 * confidently wrong. This is the belt: once a cluster looks finished (three
 * photographs or more — the point at which a silent over-merge is expensive
 * rather than a lucky pair), ask the model to check its own claim on a
 * dedicated contact sheet, and split the cluster if the answer disagrees.
 *
 * Deliberately split-biased (spec rule 6): a photograph the model can't place
 * becomes its own singleton rather than staying folded into the claimed
 * group, and the good, common case — everyone answers "A" — costs one extra
 * request and changes nothing.
 */

export const COHERENCE_MIN_GROUP = 3;

export const coherencePrompt = (count: number): string =>
  `This is ONE image containing ${count} photographs in a grid, numbered 0 to
${count - 1} in the black band beneath each. An automated system believes
they ALL show THE SAME individual physical product, photographed from
different sides. Your job is to CHECK that claim.

Give every photograph a letter. Photographs of the same physical item share
a letter; a photograph of a DIFFERENT item gets a different letter. If they
really are all one item, answer every photograph "A" — that is the common
case and a perfectly good answer.

Judge colourways and construction, never the background:
- a different colourway, sole colour or tread, panel or stripe shape or
  tone, logo colour or placement, lining or lace colour means a DIFFERENT
  letter.
- EVERY PHOTOGRAPH SHOWS THE EDGES OF NEIGHBOURING SIDES. A front view
  shows the leading edge of BOTH side panels; a heel view shows how the
  heel colour is split; a top view shows both sides' upper edges. Colours
  and stripes must CONTINUE across these seams between photographs of one
  item. A contradiction at a seam means different letters.

"sure": false when a photograph is too dark, cropped or ambiguous to place.

Reply with ONLY a JSON array, one object per photograph:
[{"photo":0,"item":"A","sure":true},{"photo":1,"item":"A","sure":true}]
No prose, no code fences.`;

export const COHERENCE_SCHEMA: Record<string, unknown> = {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      photo: { type: 'integer', description: 'The number printed beneath each photograph, 0-based.' },
      item: { type: 'string', description: 'A letter shared by photographs of the same physical item.' },
      sure: { type: 'boolean' },
    },
    required: ['photo', 'item', 'sure'],
    additionalProperties: false,
  },
};

export interface CoherenceVerdict { photo: number; item: string; sure: boolean }

/**
 * Same reader discipline as `readIdentity`: drop what can't be trusted
 * rather than default it. `photo` is 0-based here (every photograph gets a
 * verdict, unlike identity's 1-based candidates), out-of-range or duplicate
 * numbers are dropped, `item` is uppercased and trimmed with empty dropped,
 * and `sure` absent or non-boolean reads as NOT sure.
 */
export const readCoherence = (entries: unknown[], count: number): CoherenceVerdict[] => {
  const verdicts: CoherenceVerdict[] = [];
  const claimed = new Set<number>();

  entries.forEach((entry) => {
    if (!entry || typeof entry !== 'object') return;
    const record = entry as Record<string, unknown>;

    const photo = Number(record.photo);
    if (!Number.isInteger(photo) || photo < 0 || photo >= count || claimed.has(photo)) return;

    if (typeof record.item !== 'string') return;
    const item = record.item.trim().toUpperCase();
    if (!item) return;
    claimed.add(photo);

    verdicts.push({
      photo,
      item,
      sure: record.sure === true,   // anything else is NOT sure
    });
  });

  return verdicts;
};

/**
 * Splits a cluster by verdict letters. Returns the partition as an array of
 * index-arrays (folder order inside each, partitions ordered by first
 * member). A photo with NO verdict becomes its own singleton partition —
 * split-safe: an unreadable photograph never gets to hide inside a group it
 * was never actually placed in. All-one-letter is a single partition, the
 * good and common case.
 */
export const partitionByVerdicts = (
  count: number,
  verdicts: CoherenceVerdict[],
): number[][] => {
  const itemOf = new Map<number, string>();
  verdicts.forEach((v) => itemOf.set(v.photo, v.item));

  const groups = new Map<string, number[]>();
  for (let photo = 0; photo < count; photo += 1) {
    const item = itemOf.get(photo);
    // A missing verdict gets a key no real letter can collide with, so it
    // always lands in its own singleton partition.
    const key = item !== undefined ? `L${item}` : `S${photo}`;
    const list = groups.get(key) ?? [];
    list.push(photo);
    groups.set(key, list);
  }

  return [...groups.values()]
    .map((list) => [...list].sort((a, b) => a - b))
    .sort((a, b) => a[0] - b[0]);
};
