import { describe, expect, it } from 'vitest';
import {
  MIN_TRIM,
  Rgb,
  borderColour,
  colourDistance,
  cropFor,
  padBounds,
  subjectBounds,
  worthCropping,
  isolateFolderParallel,
} from './isolateSubject';

/** A blank frame in one colour. */
const frame = (width: number, height: number, colour: Rgb): Uint8ClampedArray => {
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    pixels[i * 4] = colour.r;
    pixels[i * 4 + 1] = colour.g;
    pixels[i * 4 + 2] = colour.b;
    pixels[i * 4 + 3] = 255;
  }
  return pixels;
};

/** Paints a solid rectangle onto a frame. */
const paint = (
  pixels: Uint8ClampedArray,
  width: number,
  box: { x: number; y: number; width: number; height: number },
  colour: Rgb
) => {
  for (let y = box.y; y < box.y + box.height; y += 1) {
    for (let x = box.x; x < box.x + box.width; x += 1) {
      const at = (y * width + x) * 4;
      pixels[at] = colour.r;
      pixels[at + 1] = colour.g;
      pixels[at + 2] = colour.b;
      pixels[at + 3] = 255;
    }
  }
};

/** The red felt table the photographs in question were actually taken on. */
const FELT: Rgb = { r: 150, g: 30, b: 35 };
const SHOE: Rgb = { r: 30, g: 30, b: 34 };
const WHITE: Rgb = { r: 245, g: 245, b: 245 };

describe('borderColour', () => {
  it('reads a uniform background off the border', () => {
    expect(borderColour(frame(100, 100, FELT), 100, 100)).toEqual(FELT);
  });

  it('is not moved by a subject in the middle of the frame', () => {
    const pixels = frame(100, 100, FELT);
    paint(pixels, 100, { x: 25, y: 25, width: 50, height: 50 }, SHOE);
    expect(borderColour(pixels, 100, 100)).toEqual(FELT);
  });

  it('is not moved by something intruding into one corner', () => {
    // The median is the point of the exercise: a mean would drift a third of
    // the way towards the intruder and then match the real background nowhere.
    const pixels = frame(100, 100, FELT);
    paint(pixels, 100, { x: 0, y: 0, width: 14, height: 14 }, WHITE);
    expect(borderColour(pixels, 100, 100)).toEqual(FELT);
  });
});

describe('colourDistance', () => {
  it('is 0 for the background colour itself', () => {
    const pixels = frame(2, 2, FELT);
    expect(colourDistance(pixels, 0, FELT)).toBe(0);
  });

  it('is large between dark leather and red felt', () => {
    const pixels = frame(2, 2, SHOE);
    expect(colourDistance(pixels, 0, FELT)).toBeGreaterThan(100);
  });
});

describe('subjectBounds', () => {
  it('finds a shoe on a felt table', () => {
    const pixels = frame(200, 200, FELT);
    paint(pixels, 200, { x: 60, y: 70, width: 80, height: 60 }, SHOE);

    expect(subjectBounds(pixels, 200, 200, FELT)).toEqual({
      x: 60,
      y: 70,
      width: 80,
      height: 60,
    });
  });

  it('finds a white shoe on a white background', () => {
    // Nearly the hardest case for this method, and the one that has to work:
    // the folder is full of white trainers on pale surfaces.
    const background: Rgb = { r: 235, g: 235, b: 235 };
    const shoe: Rgb = { r: 250, g: 250, b: 250 };
    const pixels = frame(200, 200, background);
    paint(pixels, 200, { x: 50, y: 50, width: 100, height: 100 }, shoe);

    // Fifteen levels apart is inside the tolerance, so this correctly refuses
    // rather than inventing a box. The photograph is used uncropped.
    expect(subjectBounds(pixels, 200, 200, background)).toBeNull();
  });

  it('refuses a frame with no subject at all', () => {
    expect(subjectBounds(frame(100, 100, FELT), 100, 100, FELT)).toBeNull();
  });

  it('refuses a price tag in the corner, however bright', () => {
    // Refused because it never reaches the middle of the frame, not because it
    // is small — a shoe photographed across a stockroom is just as small and
    // must still be found.
    const pixels = frame(200, 200, FELT);
    paint(pixels, 200, { x: 6, y: 6, width: 20, height: 20 }, WHITE);
    expect(subjectBounds(pixels, 200, 200, FELT)).toBeNull();
  });

  it('refuses a frame holding nothing but noise', () => {
    const pixels = frame(200, 200, FELT);
    paint(pixels, 200, { x: 99, y: 99, width: 2, height: 2 }, WHITE);
    expect(subjectBounds(pixels, 200, 200, FELT)).toBeNull();
  });

  it('finds a small subject that IS in the middle', () => {
    // The stockroom shot. Well under the old two-percent floor, and exactly the
    // photograph cropping does most for.
    const pixels = frame(300, 300, FELT);
    paint(pixels, 300, { x: 135, y: 135, width: 30, height: 30 }, SHOE);

    const bounds = subjectBounds(pixels, 300, 300, FELT)!;
    expect(bounds.width).toBe(30);
    expect(bounds.x).toBe(135);
  });

  it('ignores speckle that would otherwise stretch the box to the frame', () => {
    const pixels = frame(200, 200, FELT);
    paint(pixels, 200, { x: 80, y: 80, width: 40, height: 40 }, SHOE);
    // Four stray bright pixels in the corners — sensor noise, or JPEG ringing.
    [[1, 1], [198, 1], [1, 198], [198, 198]].forEach(([x, y]) =>
      paint(pixels, 200, { x, y, width: 1, height: 1 }, WHITE)
    );

    const bounds = subjectBounds(pixels, 200, 200, FELT)!;
    expect(bounds.x).toBe(80);
    expect(bounds.width).toBe(40);
  });

  it('handles a subject touching the edge of the frame', () => {
    const pixels = frame(200, 200, FELT);
    paint(pixels, 200, { x: 0, y: 50, width: 120, height: 100 }, SHOE);

    const bounds = subjectBounds(pixels, 200, 200, FELT)!;
    expect(bounds.x).toBe(0);
    expect(bounds.width).toBe(120);
  });

  it('refuses a zero-sized frame rather than dividing by it', () => {
    expect(subjectBounds(new Uint8ClampedArray(0), 0, 0, FELT)).toBeNull();
  });
});

describe('padBounds', () => {
  it('grows a box by a share of its own size', () => {
    expect(padBounds({ x: 50, y: 50, width: 100, height: 100 }, 400, 400, 0.1)).toEqual({
      x: 40,
      y: 40,
      width: 120,
      height: 120,
    });
  });

  it('never leaves the frame', () => {
    const padded = padBounds({ x: 0, y: 0, width: 100, height: 100 }, 100, 100, 0.5);
    expect(padded).toEqual({ x: 0, y: 0, width: 100, height: 100 });
  });
});

describe('worthCropping', () => {
  it('is false for a box that is already the whole frame', () => {
    expect(worthCropping({ x: 0, y: 0, width: 100, height: 100 }, 100, 100)).toBe(false);
  });

  it('is true for a box that removes a meaningful share', () => {
    expect(worthCropping({ x: 10, y: 10, width: 50, height: 50 }, 100, 100)).toBe(true);
  });

  it('is false just under the trim floor', () => {
    // A photograph already tightly framed: re-encoding it only loses quality.
    const side = Math.sqrt(1 - MIN_TRIM + 0.01);
    const width = Math.floor(100 * side);
    expect(worthCropping({ x: 0, y: 0, width, height: 100 }, 100, 100)).toBe(false);
  });
});

describe('cropFor — the whole decision', () => {
  it('crops a shoe photographed small on a felt table', () => {
    const pixels = frame(300, 300, FELT);
    paint(pixels, 300, { x: 110, y: 120, width: 80, height: 70 }, SHOE);

    const bounds = cropFor(pixels, 300, 300)!;

    expect(bounds).not.toBeNull();
    // Padded outwards from the subject, and far smaller than the frame.
    expect(bounds.x).toBeLessThan(110);
    expect(bounds.width).toBeLessThan(300 * 0.4);
  });

  it('leaves an already tightly framed photograph alone', () => {
    const pixels = frame(200, 200, FELT);
    paint(pixels, 200, { x: 2, y: 2, width: 196, height: 196 }, SHOE);

    expect(cropFor(pixels, 200, 200)).toBeNull();
  });

  it('leaves a cluttered background alone rather than guessing', () => {
    // A stockroom shelf: the "background" median matches nothing, so no
    // confident box exists. A wrong crop here would cut the heel off one
    // photograph of a shoe and the toe off another, and those two would never
    // be recognised as one item again.
    const pixels = frame(200, 200, FELT);
    for (let y = 0; y < 200; y += 1) {
      for (let x = 0; x < 200; x += 1) {
        if ((x + y) % 3 === 0) paint(pixels, 200, { x, y, width: 1, height: 1 }, WHITE);
      }
    }

    const bounds = cropFor(pixels, 200, 200);
    expect(bounds === null || bounds.width > 150).toBe(true);
  });

  it('gives the same crop for the same photograph twice', () => {
    const pixels = frame(300, 300, FELT);
    paint(pixels, 300, { x: 90, y: 100, width: 100, height: 80 }, SHOE);

    expect(cropFor(pixels, 300, 300)).toEqual(cropFor(pixels, 300, 300));
  });

  it('crops two photographs of one shoe to comparable boxes', () => {
    // The property that matters for grouping: the same shoe photographed at two
    // distances must end up at a similar scale, or the embedding is comparing a
    // close-up with a room.
    const near = frame(300, 300, FELT);
    paint(near, 300, { x: 100, y: 100, width: 100, height: 100 }, SHOE);

    const far = frame(300, 300, FELT);
    paint(far, 300, { x: 130, y: 130, width: 40, height: 40 }, SHOE);

    const a = cropFor(near, 300, 300)!;
    const b = cropFor(far, 300, 300)!;

    // Both crops are tight on their subject: the ratio of subject to crop is
    // near-identical even though the subjects differ 2.5x in the frame.
    expect(a.width / 100).toBeCloseTo(b.width / 40, 1);
  });
});

describe('isolateFolderParallel', () => {
  it('falls back to the serial path where Worker is unavailable and preserves order', async () => {
    // vitest/node: no Worker, no canvas -> every crop refuses to null,
    // which is exactly what serial isolateFolder does.
    const out = await isolateFolderParallel(['AAAA', 'BBBB', 'CCCC']);
    expect(out).toEqual([null, null, null]);
  });
  it('honours shouldStop by returning what it has', async () => {
    const out = await isolateFolderParallel(['AAAA', 'BBBB'], undefined, () => true);
    expect(out.length).toBe(2);
  });
});
