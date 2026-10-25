/**
 * THE ONE QUESTION THE SYSTEM ACTUALLY ASKS.
 *
 * The old pipeline asked the model to CATALOGUE each photograph — thirty-five
 * fields about heels, linings, tread patterns and lace colours — and then tried
 * to recover identity by comparing the catalogues with weighted arithmetic. It
 * could not work, and the reason is stated in the old code's own comments: the
 * information needed to separate two near-identical trainers is destroyed at
 * the moment a photograph becomes a paragraph. Every threshold, veto tier and
 * special case in `productFingerprint.ts` is a patch on that loss.
 *
 * This asks the question directly instead. Here are nine photographs in one
 * picture; which of them show the same physical object. The model never
 * describes anything, so nothing is lost in translation, and the answer is the
 * judgement itself rather than evidence for a rule to weigh.
 *
 * WHAT MAKES THE ANSWER USEFUL IS THAT IT IS SIGNED. Two photographs the model
 * gives different letters are not merely "not yet joined" — they are a
 * RECORDED DIFFERENT, from a judge that had both in front of it, and
 * `signedGraph.ts` will let that refuse a merge that some other sheet wanted.
 * That is where the old system's vetoes should have come from all along: not
 * from a table of hand-written rules about what a heel type implies, but from
 * the model having looked at the two shoes and said they are not the same shoe.
 *
 * A photograph the model marks unsure emits no DIFFERENT at all. An uncertain
 * negative is the one answer that can do real damage — it permanently bars a
 * merge — so uncertainty is spent on splitting rather than on joining, and the
 * pair goes to the review screen instead.
 */

import { Judgement } from './signedGraph';

/** One photograph's place in a sheet's answer. */
export interface Verdict {
  /** Position on the sheet, as painted on the image. */
  photo: number;
  /** The item letter. Two photographs sharing one are the same physical object. */
  item: string;
  /** The feature that settled it, in the model's own words. */
  because?: string;
  /** False when the model would not commit. Such a photograph emits no DIFFERENT. */
  sure: boolean;
  /**
   * What kind of thing it is, and its colourway.
   *
   * THESE ARE OUTPUTS. They name the product on the review screen and nothing
   * else — no comparison, no threshold and no merge anywhere in this system
   * reads them. That restriction is the whole lesson of the architecture this
   * replaces, where attributes like these WERE the identity function and could
   * not carry it. Asked for here because the model is already looking at the
   * photograph and a label is nearly free; deliberately inert afterwards.
   */
  category?: string;
  colour?: string;
  /**
   * Which side of the item this photograph was taken from.
   *
   * Unlike `category` and `colour`, this one IS read — but only when the folder
   * is declared to be a one-photograph-per-angle shoot, which is a fact about
   * how the photographs were made rather than anything visible in them. See
   * `UNIQUE_ANGLES` and `anglesAllow` in `signedGraph.ts`.
   *
   * It is also what the review screen labels each thumbnail with, which v2 lost
   * when it stopped asking for angles at all.
   */
  angle?: string;
}

/**
 * The exact shape a sheet's answer must take.
 *
 * Written as standard JSON Schema and translated for Gemini by
 * `toGeminiSchema`. Note the OUTER type: an ARRAY, one entry per photograph. A
 * schema declared as a single OBJECT against a request carrying nine
 * photographs gets one object back describing one of them, and the other eight
 * answers are simply never produced — a failure that looks like a model being
 * unhelpful and is actually the schema saying "give me one".
 *
 * `sure` is required rather than optional on purpose. A model allowed to omit
 * it omits it, and every photograph then defaults to committed — which is the
 * one default that can do harm, because a committed wrong letter emits a
 * DIFFERENT that bars a real join.
 */
export const JUDGE_SCHEMA: Record<string, unknown> = {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      photo: { type: 'integer', description: 'The number printed under the photograph.' },
      item: { type: 'string', description: 'A letter. The same letter means the same physical item.' },
      because: { type: 'string', description: 'The feature that settled it, in a few words.' },
      sure: { type: 'boolean', description: 'False when the photograph cannot be placed confidently.' },
      category: { type: 'string', enum: ['FOOTWEAR', 'TOP', 'BOTTOMS', 'OTHER'] },
      colour: { type: 'string', description: 'Colourway in two or three words, dominant first.' },
      angle: {
        type: 'string',
        enum: ['FRONT', 'BACK', 'LEFT', 'RIGHT', 'TOP', 'SOLE', 'CLOSEUP', 'OTHER'],
      },
    },
    required: ['photo', 'item', 'because', 'sure', 'category', 'colour', 'angle'],
    additionalProperties: false,
  },
};

/** The shape of a tie-break answer. */
export const TIE_BREAK_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    same: { type: 'boolean' },
    because: { type: 'string' },
    sure: { type: 'boolean' },
  },
  required: ['same', 'because', 'sure'],
  additionalProperties: false,
};

/**
 * Sampling temperature for every judgement request.
 *
 * Zero. This is a closed question with a right answer, not a piece of writing —
 * there is nothing here that variety improves. It also makes a run reproducible,
 * which matters more than it sounds: without it, re-running a folder to check
 * whether a change helped compares two different samples rather than two
 * different pipelines.
 */
export const JUDGE_TEMPERATURE = 0;

/** Confidence given to a join the model committed to. */
export const SURE = 0.9;
/** Confidence given to a join the model hedged on. Orders merges; refuses nothing. */
export const UNSURE = 0.35;

export const judgePrompt = (count: number): string =>
  `This is ONE image containing ${count} product photographs laid out in a grid. Each photograph has its NUMBER printed in the black band directly beneath it, from 0 to ${count - 1}.

SORT THE PHOTOGRAPHS BY WHICH PHYSICAL OBJECT THEY SHOW.

Give every photograph a letter. Two photographs get the SAME letter when they show THE SAME INDIVIDUAL PHYSICAL ITEM. They get DIFFERENT letters when they show two different items.

There are TWO ways to get this wrong and they do not cost the same. Putting two items under one letter corrupts a product that is later used to generate imagery, and nobody can unpick it afterwards. Splitting one item across two letters is a click to undo. So where the evidence is genuinely balanced, split — but do NOT manufacture differences to feel safe, because a folder shattered into fragments is its own failure. Two checklists near the end of these instructions exist to stop each mistake in turn, and you must run BOTH before you answer.

WHAT IS ONE ITEM:
- The same object photographed from another angle. A shoe's profile, its back, its top and its underside look nothing like each other and are one shoe.
- The same object at another distance, in another light, on another background, at another rotation, or cropped differently.
- A close-up of part of an object, together with the object it is part of.
- The same object with wear, dust, creasing or a lace tied differently, or standing on a different surface.

THE SURFACE AND THE SETTING ARE NOT EVIDENCE. These photographs were taken in a shop, so many of them share a table, a shelf, a carpet or a strip of daylight. TWO ITEMS ON ONE TABLE ARE STILL TWO ITEMS, and one item moved to another table is still one item. The colour of the surface, the background, the lighting and any hand, box, tag or price label in the frame tell you NOTHING about which item you are looking at. Judge the footwear alone.

WHAT IS TWO ITEMS — the general rule:
- A DIFFERENT COLOURWAY of the same model. Same shape, same brand, different colours: two items.
- THE SOLE IS PART OF THE COLOURWAY. A black shoe on a WHITE outsole and a black shoe on a BLACK outsole are TWO DIFFERENT PRODUCTS, however identical the uppers are.
- A different OUTSOLE TREAD, or a sole unit coloured differently at the heel end.
- A different STRIPE, PANEL or OVERLAY shape, or the same one in a different colour or tone.
- A different LOGO, or the same logo in a different place, at a different size, or in a different colour.
- A different LINING, COLLAR or TONGUE colour.
- A different lace colour, heel tab, eyelet count or toe bumper.

SPECIFIC PAIRS THAT HAVE ALREADY BEEN CONFUSED IN THIS EXACT FOLDER. These are worked examples of the rule above, NOT a complete list — a pair resembling none of them can still be two items, and you must still judge every pair on the general rule:

1. COLLAR LINING TONE. Look directly into the ankle collar opening. A grey trainer with a BLACK interior collar lining is a DIFFERENT ITEM from a grey trainer with a GREY or matching interior lining. This sits in shadow and is easy to skip; do not skip it.

2. MIDSOLE AGAINST AN ALL-BLACK SHOE. A black shoe with a WHITE or light-coloured MIDSOLE is a DIFFERENT ITEM from an all-black or triple-black shoe with a BLACK midsole. Never group them because both uppers are black.

3. OUTSOLE TREAD AND COLOUR LAYOUT. A blue outsole with rounded or oval white pod cutouts is a DIFFERENT ITEM from a plain black outsole with horizontal channel treads. A solid one-colour sole is DIFFERENT from a two-tone sole, or from one with a central white pod. Different tread geometry, or a different distribution of rubber colour, means different items.

4. OVERLAY AND STRIPE TONE. Compare side-profile stripes and overlays. A grey shoe with a light grey or silver side stripe is a DIFFERENT ITEM from a grey shoe with a cream, beige or pinkish stripe and midsole.

5. TONE SHIFTS ON DARK AND GREEN UPPERS. An olive upper paired with a dark green midsole or outsole is a DIFFERENT ITEM from an olive upper paired with a solid black midsole or outsole.

6. BRANDING COLOUR. A grey shoe with a GREY logo and a grey shoe with a BLACK logo or stripe are TWO DIFFERENT PRODUCTS.

DO NOT EXPLAIN A COLOUR DIFFERENCE AWAY AS LIGHTING unless the WHOLE ITEM is shifted the same way. This is the mistake that merges two colourways. Before deciding that a logo, stripe, midsole or lining only "looks" darker in one photograph, check the rest of that shoe against the other: if the upper, the sole and the laces all match while only that one part differs, that is not a shadow, it is a different product. Light and shadow move every part of an item together; a colourway changes one part and leaves the rest alone.

WHEN TWO PHOTOGRAPHS BOTH SHOW THE UNDERSIDE, compare them in this order. Two soles are the hardest pair on any sheet, because an underside of a black trainer looks like an underside of a black trainer whichever trainer it is — so do not judge them on overall impression:
1. THE COLOUR LAYOUT OF THE SOLE UNIT. Not "is it dark" — WHERE each colour sits. A solid black bottom is a different product from a white bottom with black toe and heel pads, or from one with a central pod cutout.
2. THE TREAD GEOMETRY. Waffle, grid, hexagons, pods, concentric circles, herringbone, plain channels, lug blocks. Different geometry means different products. Compare the PATTERN ITSELF, not how it happens to be turned in the frame — the same sole rotated, mirrored, or photographed from the other end is still the same sole.
3. THE OUTLINE. Where the sole pinches at the waist, how square or round the toe is, whether the heel is stepped.

TWO SOLES THAT SHARE A MIDSOLE COLOUR ARE NOT THEREBY ONE ITEM. A white midsole is the commonest thing in any trainer folder and it identifies nothing. Neither does a shared background. If the tread colours or the tread pattern differ, they are two products.

BEFORE YOU GIVE TWO PHOTOGRAPHS THE SAME LETTER, confirm every one of these. Any single one failing means different letters:
- The collar lining and the tongue are the same colour in both, or are not visible in one of them.
- The midsole and the outsole are the same colours, laid out the same way.
- Every stripe, overlay and panel is the same shape AND the same tone.
- The logo is the same colour, the same size, and in the same place.
- The laces are the same colour.
- Nothing about the construction differs — eyelet count, heel tab, toe bumper, shaft height.

BEFORE YOU GIVE TWO PHOTOGRAPHS DIFFERENT LETTERS, rule out every one of these. If any is true, they may well be one item and you should look again:
- You are looking at two different SIDES of one shoe. A profile and an underside share almost no visible surface; that is expected and is evidence of nothing.
- One is a close-up of a part and the other shows the whole item.
- The WHOLE frame is brighter, darker or warmer — not one part of it.
- The shoe is turned, mirrored, or standing at a different angle, so the same features sit in different places.
- One photograph simply does not show the part you were comparing. A part you CANNOT SEE is not a part that DIFFERS — if the collar is out of frame, that is not a lining difference, it is a missing observation.
- The difference you found is something nearly every item in this folder shares, such as a white midsole or a rubber sole. That is not a difference at all.

DO NOT sort them into a few big piles, and do not assume the grid holds only one or two items. A letter used by exactly one photograph is a normal and common answer. Several photographs of one item is also normal. Count nothing — look.

FOR EACH PHOTOGRAPH GIVE:
- "photo": its printed number.
- "item": its letter.
- "because": the specific feature you actually used, in a few words. Not "same shoe" — name it: "black collar lining", "grey collar lining", "all-black midsole not white", "blue pod tread", "logo on the tongue not the side panel".
- "sure": true ONLY when you would stake the catalogue on this photograph's letter — roughly, when you are at least 85% certain. Answer false whenever the photograph is too dark, too cropped, too small or too ambiguous to place, whenever the collar or sole detail you needed is not visible, and whenever two items are so alike that you are choosing between them rather than recognising one. "false" is a useful answer and costs nothing; a confident wrong letter is expensive, because a confident letter is allowed to rule out a match elsewhere and a hedged one is not.
- "category": FOOTWEAR, TOP, BOTTOMS or OTHER.
- "colour": the item's colourway in two or three words, dominant colour first.
- "angle": which side of the item you are looking at — FRONT, BACK, LEFT, RIGHT, TOP (from above) or SOLE (the underside). Use CLOSEUP when part of the item fills the frame, and OTHER when none of them fits. Answer this from the ITEM's own orientation, not the camera's: the BACK is the heel end whichever way the shoe is pointing in the photograph.

"category" and "colour" only name the item on screen. They are not used to decide anything, so answer them briefly and never let them influence your letters.

Reply with ONLY a JSON array, one object per photograph:
[{"photo":0,"item":"A","because":"grey upper with black collar lining","sure":true,"category":"FOOTWEAR","colour":"grey black","angle":"LEFT"},{"photo":1,"item":"A","because":"same black collar lining seen from rear","sure":true,"category":"FOOTWEAR","colour":"grey black","angle":"BACK"},{"photo":2,"item":"B","because":"grey collar lining, white midsole","sure":true,"category":"FOOTWEAR","colour":"grey white","angle":"BACK"}]
No prose, no code fences.`;

/**
 * The tie-break prompt: two photographs, and nothing else to think about.
 *
 * Sent only for a pair two sheets disagreed about, which is a few pairs in a
 * folder rather than a stage every photograph goes through. Asking the narrow
 * question is what makes a second opinion affordable — and the second opinion
 * is asked of the OTHER provider, so the disagreement is settled by a judge
 * that has not already committed to either answer.
 */
export const tieBreakPrompt = (): string =>
  `This image contains TWO product photographs side by side, numbered 0 and 1 beneath them.

ARE THEY THE SAME INDIVIDUAL PHYSICAL ITEM, photographed differently?

A different angle, distance, crop, background, light or rotation is the SAME item.
A different colourway, outsole tread, panel shape, logo placement, lining colour or lace colour is a DIFFERENT item.

IF BOTH PHOTOGRAPHS SHOW THE UNDERSIDE, decide on these and nothing else: where each colour sits on the sole unit (a solid black bottom against a white bottom with black toe and heel pads is two products), and the tread geometry — waffle, grid, hexagons, channels, lugs — compared as a pattern rather than by how it is turned in the frame. A midsole colour the two share identifies nothing; almost every trainer has a white one.

Two earlier judgements of this pair disagreed, so look at the details rather than the overall impression.

Reply with ONLY this JSON object:
{"same":true,"because":"the feature you actually used, in a few words","sure":true}
No prose, no code fences.`;

/** Pulls the first complete JSON array out of a reply, fences and prose aside. */
export const extractArray = (text: string): unknown[] | null => {
  const start = text.indexOf('[');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i += 1) {
    const char = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === '"') inString = !inString;
    if (inString) continue;
    if (char === '[') depth += 1;
    if (char === ']') {
      depth -= 1;
      if (depth === 0) {
        try {
          const parsed = JSON.parse(text.slice(start, i + 1));
          return Array.isArray(parsed) ? parsed : null;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
};

/** Pulls the first complete JSON object out of a reply. */
export const extractObject = (text: string): Record<string, unknown> | null => {
  const start = text.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i += 1) {
    const char = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === '"') inString = !inString;
    if (inString) continue;
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          const parsed = JSON.parse(text.slice(start, i + 1));
          return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : null;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
};

/**
 * Reads a sheet's answer.
 *
 * A photograph the model skipped, numbered outside the sheet, or given no
 * letter is DROPPED rather than defaulted. A defaulted letter is an invented
 * judgement about a real photograph, and it would enter the graph looking
 * exactly like a real one. Dropping it leaves the photograph to whatever other
 * sheet it appears on — which is what `COVERAGE` in `neighbourGraph.ts` exists
 * to guarantee it has.
 *
 * `sure` defaults to true only when the model omitted the field entirely, which
 * is a model that answered the older shape of this question; an explicit
 * non-boolean is read as unsure.
 */
export const readVerdicts = (entries: unknown[], count: number): Verdict[] => {
  const verdicts: Verdict[] = [];
  const claimed = new Set<number>();

  entries.forEach((entry, position) => {
    if (!entry || typeof entry !== 'object') return;
    const record = entry as Record<string, unknown>;

    const declared = Number(record.photo ?? record.image ?? record.index);
    const photo = Number.isInteger(declared) ? declared : position;
    if (photo < 0 || photo >= count || claimed.has(photo)) return;

    const item = String(record.item ?? record.label ?? record.product ?? '').trim().toUpperCase();
    if (!item) return;

    const text = (value: unknown): string | undefined =>
      typeof value === 'string' && value.trim() ? value.trim() : undefined;

    claimed.add(photo);
    verdicts.push({
      photo,
      item,
      because: text(record.because),
      sure: record.sure === undefined ? true : record.sure === true,
      category: text(record.category)?.toUpperCase(),
      colour: text(record.colour)?.toLowerCase(),
      angle: text(record.angle ?? record.view)?.toUpperCase(),
    });
  });

  return verdicts;
};

/**
 * Turns one sheet's letters into signed judgements about image ids.
 *
 * Both directions are emitted, and that is the whole point of asking this way.
 * A shared letter is a SAME. A pair of different letters is a DIFFERENT — the
 * model had both photographs in one picture and separated them, which is a far
 * better negative than any rule about heel types could be.
 *
 * The exception is an unsure photograph. It contributes its joins, weakly, and
 * NO negatives at all: a negative is permanent, so it is only ever taken from a
 * judgement the model stood behind.
 */
export const toJudgements = (
  verdicts: Verdict[],
  idOf: (photo: number) => string | undefined,
  source?: string
): Judgement[] => {
  const judgements: Judgement[] = [];

  for (let i = 0; i < verdicts.length; i += 1) {
    for (let j = i + 1; j < verdicts.length; j += 1) {
      const left = verdicts[i];
      const right = verdicts[j];

      const a = idOf(left.photo);
      const b = idOf(right.photo);
      if (!a || !b || a === b) continue;

      const together = left.item === right.item;
      const committed = left.sure && right.sure;

      if (!together && !committed) continue;

      judgements.push({
        a,
        b,
        same: together,
        committed,
        confidence: committed ? SURE : UNSURE,
        reason: together ? left.because ?? right.because : right.because ?? left.because,
        source,
      });
    }
  }

  return judgements;
};

/** Reads a tie-break answer. An unreadable or hedged reply settles nothing. */
export const readTieBreak = (
  text: string
): { same: boolean; because?: string } | null => {
  const record = extractObject(text);
  if (!record) return null;
  if (typeof record.same !== 'boolean') return null;
  if (record.sure === false) return null;
  return {
    same: record.same,
    because: typeof record.because === 'string' ? record.because.trim() || undefined : undefined,
  };
};
