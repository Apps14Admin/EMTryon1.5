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
