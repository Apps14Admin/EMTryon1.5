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
  `Photograph 0, shown alone at the left, is the ANCHOR. Photographs 1 to ${candidates} are
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

EVERY PHOTOGRAPH SHOWS THE EDGES OF NEIGHBOURING SIDES — USE THEM. A FRONT
view shows the first stretch of BOTH side panels and the toe of the
midsole; a BACK view shows the rear of both sides and how the heel colour
is split; a TOP view shows both sides' upper edges, the tongue and the
laces; a SOLE view shows the outsole every side view shows in profile.
Whatever colour or stripe appears at such an edge MUST CONTINUE in any
other photograph of the same item: a front showing blue on the side panels'
leading edge can only match a side photograph whose panel carries that
blue; a heel split black-and-white can only match side views split the same
way. Before answering SAME across two different views, name one feature
that crosses the seam between them and check it continues. If the seam
contradicts, the answer is DIFFERENT, however alike the two shoes look
overall.

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
No prose, no code fences.`;

/**
 * Both readers drop entries they cannot parse rather than defaulting them. A
 * defaulted answer is an invented judgement that enters the graph
 * indistinguishable from a real one. `sure` absent (or non-boolean) is read
 * as NOT sure. `because` is capped in the prompt and truncated here
 * regardless.
 */
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
