/**
 * CROPPING AWAY THE ROOM.
 *
 * A photograph taken in a shop or a stockroom is mostly not the product. It is
 * a red felt table, a shelf edge, a strip of carpet, somebody's hand — and all
 * of that goes into the embedding and onto the contact sheet as if it were
 * evidence about the shoe.
 *
 * It hurts twice, in different ways:
 *
 *   THE EMBEDDING clusters on whatever varies most. Two shoes photographed on
 *   one red table are pulled TOGETHER by the red table; one shoe photographed
 *   on the table and again on a white sheet is pushed APART by it. Both are
 *   exactly backwards, and neither is something the judge can repair, because
 *   the judge only ever sees the sheets the embedding proposed.
 *
 *   THE CONTACT SHEET has a fixed pixel budget. A shoe filling a fifth of its
 *   frame gets a fifth of its cell, and the tread pattern and heel tab that
 *   separate two colourways stop being resolvable at that size. Cropping is the
 *   cheapest resolution increase available: the same request, the same tokens,
 *   several times the pixels on the thing being judged.
 *
 * WHY NOT `rembg` OR A SEGMENTATION MODEL. Both would be better at this, and
 * both are the wrong shape for where this runs. `rembg` is a Python process and
 * this pipeline is a browser; a segmentation checkpoint is a second model
 * download on top of the embedder. What is here instead is a border-sampled
 * background estimate and a bounding box — a few milliseconds per photograph,
 * no download, no service — which handles the case that actually occurs: a
 * product shot against a roughly uniform surface.
 *
 * ORDER MATTERS, AND GETTING IT WRONG WASTES THE WHOLE POINT. Cropping must
 * happen on the LARGEST copy available and the downscale must happen AFTER, not
 * before. A shoe filling a fifth of its frame, cropped out of the 512px scout
 * copy, is 229 pixels of shoe — which then has to be scaled UP to fill a 341px
 * cell on the contact sheet, inventing detail that was thrown away two steps
 * earlier. Cropped out of the 1600px copy instead it is 716 pixels of shoe, and
 * scaling that DOWN into the same cell keeps every pixel real. Same request,
 * same tokens, three times the resolution on the only thing being judged.
 *
 * IT REFUSES RATHER THAN GUESSES. A cluttered background gives no confident
 * bounding box, and a wrong crop is far worse than none — it can cut the heel
 * off one photograph of a shoe and the toe off another, and those two will
 * never be recognised as one item again. So every check below fails towards
 * returning the photograph untouched.
 */

import { mapWithConcurrency } from './imageUtils';

/** How far from the background colour a pixel must be to count as subject. */
export const TOLERANCE = 48;

/**
 * Longest edge the BOUNDING BOX SEARCH runs at.
 *
 * The search and the crop happen at different resolutions on purpose, and
 * getting that wrong is what made the first version of this stage unusably
 * slow. Reading a 1600px frame back off a canvas allocates ten megabytes and
 * then walks 2.6 million pixels; doing that a hundred and ten times, on the main
 * thread, before a single request goes out, is minutes of a spinner.
 *
 * None of that resolution buys anything. The output of the search is a
 * RECTANGLE, and a rectangle found at 256px and scaled back up is accurate to
 * about six pixels at 1600 — against a padding margin of four percent, which is
 * an order of magnitude larger. So the search runs small and the crop is taken
 * from the full-size original, which is the combination that is both fast and
 * sharp.
 */
export const ANALYSIS_EDGE = 256;

/** Border band sampled to estimate the background, as a share of the shorter side. */
export const BORDER_SHARE = 0.06;

/** Breathing room left around the subject, as a share of its own size. */
export const PADDING = 0.04;

/**
 * A crop must leave out at least this much, or it is not worth doing.
 *
 * Below it the photograph was already tightly framed and re-encoding it only
 * loses a little quality.
 */
export const MIN_TRIM = 0.08;

/**
 * A subject smaller than this share of the frame is not believed.
 *
 * Set low, and deliberately so. A size floor is a poor guard against the thing
 * it was meant to guard against — a price tag or a logo on the backdrop being
 * mistaken for the product — because the honest small case and the dishonest
 * small case are the same size. A shoe photographed across a stockroom fills
 * under two percent of the frame, and that is PRECISELY the photograph cropping
 * helps most; refusing it to avoid a hypothetical tag gives up the win to
 * prevent a loss that a better test can prevent directly.
 *
 * That better test is `CENTRE_SHARE` below. What survives here is only a floor
 * against a genuinely empty frame.
 */
export const MIN_SUBJECT = 0.005;

/**
 * The subject must reach into the middle of the frame.
 *
 * This is the guard that actually separates a product from a price tag, and it
 * comes from how the photograph was taken rather than from a size. Somebody
 * photographing a shoe points the camera at the shoe; whatever else is in the
 * frame — a tag, a shelf label, a reflection, a second shoe's toe — is at the
 * edge, because the middle is where the subject was put.
 *
 * A box that never enters the central half is not what the photograph is of, at
 * any size, and cropping to it would throw the product away.
 */
export const CENTRE_SHARE = 0.5;

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

/**
 * The background colour, taken as the MEDIAN of the border band.
 *
 * Median rather than mean, because a mean is moved by whatever intrudes into
 * the border — a shadow, the edge of another shoe, a bright reflection — and a
 * background estimate pulled a third of the way towards the intruder stops
 * matching the actual background anywhere.
 */
export const borderColour = (
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  share: number = BORDER_SHARE
): Rgb => {
  const band = Math.max(1, Math.floor(Math.min(width, height) * share));
  const reds: number[] = [];
  const greens: number[] = [];
  const blues: number[] = [];

  const take = (x: number, y: number) => {
    const at = (y * width + x) * 4;
    reds.push(pixels[at]);
    greens.push(pixels[at + 1]);
    blues.push(pixels[at + 2]);
  };

  for (let y = 0; y < height; y += 1) {
    const edgeRow = y < band || y >= height - band;
    for (let x = 0; x < width; x += 1) {
      if (edgeRow || x < band || x >= width - band) take(x, y);
    }
  }

  const median = (values: number[]): number => {
    if (!values.length) return 0;
    values.sort((a, b) => a - b);
    return values[Math.floor(values.length / 2)];
  };

  return { r: median(reds), g: median(greens), b: median(blues) };
};

/** Straight-line distance in RGB. Good enough to tell felt from leather. */
export const colourDistance = (pixels: Uint8ClampedArray, at: number, background: Rgb): number =>
  Math.sqrt(colourDistanceSquared(pixels, at, background));

/**
 * The same comparison without the square root.
 *
 * `Math.sqrt` is monotonic, so comparing squared distances against a squared
 * tolerance gives an identical answer for every pixel. This is the form the hot
 * loop uses, because the loop runs once per pixel per photograph and the root
 * is pure cost there — it is only wanted when a distance is reported to a human.
 */
export const colourDistanceSquared = (
  pixels: Uint8ClampedArray,
  at: number,
  background: Rgb
): number => {
  const dr = pixels[at] - background.r;
  const dg = pixels[at + 1] - background.g;
  const db = pixels[at + 2] - background.b;
  return dr * dr + dg * dg + db * db;
};

/** A box found at one scale, expressed at another. */
export const scaleBounds = (
  bounds: Bounds,
  from: { width: number; height: number },
  to: { width: number; height: number }
): Bounds => {
  const scaleX = to.width / from.width;
  const scaleY = to.height / from.height;

  const x = Math.max(0, Math.floor(bounds.x * scaleX));
  const y = Math.max(0, Math.floor(bounds.y * scaleY));

  return {
    x,
    y,
    width: Math.max(1, Math.min(to.width - x, Math.ceil(bounds.width * scaleX))),
    height: Math.max(1, Math.min(to.height - y, Math.ceil(bounds.height * scaleY))),
  };
};

/**
 * The box around everything that is not the background.
 *
 * Rows and columns are counted rather than pixels flagged individually: a row
 * is part of the subject when ENOUGH of it differs from the background, which
 * makes the box immune to sensor noise, dust and JPEG ringing along an edge.
 * One stray bright pixel in a corner would otherwise stretch the box to the
 * whole frame and the crop would do nothing.
 *
 * Returns `null` when there is no confident subject — a background that is not
 * uniform, or a subject too small to believe.
 */
export const subjectBounds = (
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  background: Rgb,
  tolerance: number = TOLERANCE
): Bounds | null => {
  if (width <= 0 || height <= 0) return null;

  const rowHits = new Array(height).fill(0);
  const columnHits = new Array(width).fill(0);
  let total = 0;

  const limit = tolerance * tolerance;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (colourDistanceSquared(pixels, (y * width + x) * 4, background) <= limit) continue;
      rowHits[y] += 1;
      columnHits[x] += 1;
      total += 1;
    }
  }

  const area = width * height;
  if (total / area < MIN_SUBJECT) return null;

  // A line counts as subject when a twentieth of it is. Low enough that a thin
  // lace or a heel tab holds its row, high enough that a speckle does not.
  const rowFloor = Math.max(1, Math.floor(width * 0.05));
  const columnFloor = Math.max(1, Math.floor(height * 0.05));

  const first = (hits: number[], floor: number) => hits.findIndex((count) => count >= floor);
  const last = (hits: number[], floor: number) => {
    for (let i = hits.length - 1; i >= 0; i -= 1) if (hits[i] >= floor) return i;
    return -1;
  };

  const top = first(rowHits, rowFloor);
  const bottom = last(rowHits, rowFloor);
  const left = first(columnHits, columnFloor);
  const right = last(columnHits, columnFloor);

  if (top < 0 || bottom < top || left < 0 || right < left) return null;

  // It has to reach the middle. See CENTRE_SHARE.
  const marginX = (width * (1 - CENTRE_SHARE)) / 2;
  const marginY = (height * (1 - CENTRE_SHARE)) / 2;
  const reachesCentre =
    left <= width - marginX && right >= marginX && top <= height - marginY && bottom >= marginY;
  if (!reachesCentre) return null;

  return { x: left, y: top, width: right - left + 1, height: bottom - top + 1 };
};

/** Grows a box by a share of its own size, clamped to the frame. */
export const padBounds = (
  bounds: Bounds,
  width: number,
  height: number,
  share: number = PADDING
): Bounds => {
  const padX = Math.round(bounds.width * share);
  const padY = Math.round(bounds.height * share);

  const x = Math.max(0, bounds.x - padX);
  const y = Math.max(0, bounds.y - padY);

  return {
    x,
    y,
    width: Math.min(width - x, bounds.width + padX * 2),
    height: Math.min(height - y, bounds.height + padY * 2),
  };
};

/** True when cropping to this box removes enough of the frame to be worth it. */
export const worthCropping = (bounds: Bounds, width: number, height: number): boolean => {
  const area = width * height;
  if (!area) return false;
  return 1 - (bounds.width * bounds.height) / area >= MIN_TRIM;
};

/**
 * Everything above, on one photograph, as a decision.
 *
 * Split out from the drawing so the whole judgement is testable on a plain
 * pixel array with no canvas anywhere near it.
 */
export const cropFor = (
  pixels: Uint8ClampedArray,
  width: number,
  height: number
): Bounds | null => {
  const background = borderColour(pixels, width, height);
  const bounds = subjectBounds(pixels, width, height, background);
  if (!bounds) return null;

  const padded = padBounds(bounds, width, height);
  return worthCropping(padded, width, height) ? padded : null;
};

/** Decodes base64 JPEG bytes into something drawable. */
const decode = async (base64: string): Promise<ImageBitmap | HTMLImageElement | null> => {
  try {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    const blob = new Blob([bytes], { type: 'image/jpeg' });

    if (typeof createImageBitmap === 'function') return await createImageBitmap(blob);

    const url = URL.createObjectURL(blob);
    try {
      return await new Promise<HTMLImageElement>((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error('decode failed'));
        image.src = url;
      });
    } finally {
      URL.revokeObjectURL(url);
    }
  } catch {
    return null;
  }
};

const makeCanvas = (width: number, height: number): any => {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height);
  if (typeof document === 'undefined') return null;
  return Object.assign(document.createElement('canvas'), { width, height });
};

const toBase64 = async (canvas: any): Promise<string | null> => {
  try {
    if (typeof canvas.convertToBlob === 'function') {
      const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.92 });
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let binary = '';
      bytes.forEach((byte) => {
        binary += String.fromCharCode(byte);
      });
      return btoa(binary);
    }
    return canvas.toDataURL('image/jpeg', 0.92).split(',')[1] ?? null;
  } catch {
    return null;
  }
};

/**
 * Crops one photograph to its subject, then scales the CROP to `maxEdge`.
 *
 * `base64` should be the largest copy on hand, not the one that will be sent —
 * see the note on ordering at the top of this file. The downscale happens here,
 * afterwards, so the pixels that survive are pixels of the product.
 *
 * Returns `null` when nothing should change — no canvas, an undecodable frame,
 * a background too busy to read, or a photograph already tightly framed. Every
 * caller treats `null` as "use the original", so this can only ever help or do
 * nothing.
 */
export const isolateSubject = async (
  base64: string,
  maxEdge = 512
): Promise<string | null> => {
  const image = await decode(base64);
  if (!image) return null;

  const width = (image as any).width ?? 0;
  const height = (image as any).height ?? 0;
  if (!width || !height) return null;

  // The SEARCH runs on a small copy. See ANALYSIS_EDGE: reading a full-size
  // frame back off a canvas allocates ten megabytes and walks millions of
  // pixels, and every bit of that precision is thrown away by the padding.
  const shrink = Math.min(1, ANALYSIS_EDGE / Math.max(width, height));
  const scanWidth = Math.max(1, Math.round(width * shrink));
  const scanHeight = Math.max(1, Math.round(height * shrink));

  const scan = makeCanvas(scanWidth, scanHeight);
  if (!scan) return null;

  const context = scan.getContext('2d', { willReadFrequently: true });
  if (!context) return null;

  try {
    // A transparent PNG composites onto a canvas's black-by-default pixels,
    // and the JPEG that leaves here has no alpha: a cut-out product shot
    // would arrive as the product floating on BLACK, and the border estimate
    // would read that black as the background. The same white matte
    // `prepareImageFile` gives uploads is laid down first, so both the scan
    // and the crop see the product on white, the way product photographs
    // actually are. Opaque photographs are untouched by this.
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, scanWidth, scanHeight);
    context.drawImage(image as any, 0, 0, scanWidth, scanHeight);
    const { data } = context.getImageData(0, 0, scanWidth, scanHeight);

    const found = cropFor(data, scanWidth, scanHeight);
    if (!found) return null;

    // Back to the original's coordinates, so the CROP is taken from every pixel
    // the camera captured rather than from the copy the search ran on.
    const bounds = scaleBounds(
      found,
      { width: scanWidth, height: scanHeight },
      { width, height }
    );

    // The crop, scaled to the delivery size in ONE step. Cropping and scaling
    // separately would resample twice and soften exactly the fine detail — a
    // tread pattern, a stitch line — this whole stage exists to preserve.
    const scale = Math.min(1, maxEdge / Math.max(bounds.width, bounds.height));
    const outWidth = Math.max(1, Math.round(bounds.width * scale));
    const outHeight = Math.max(1, Math.round(bounds.height * scale));

    const target = makeCanvas(outWidth, outHeight);
    if (!target) return null;

    const out = target.getContext('2d');
    if (!out) return null;

    // Same white matte as the scan: the crop is re-encoded as JPEG, where a
    // transparent pixel would otherwise come back black.
    out.fillStyle = '#ffffff';
    out.fillRect(0, 0, outWidth, outHeight);
    out.imageSmoothingEnabled = true;
    out.imageSmoothingQuality = 'high';
    out.drawImage(
      image as any,
      bounds.x,
      bounds.y,
      bounds.width,
      bounds.height,
      0,
      0,
      outWidth,
      outHeight
    );

    return await toBase64(target);
  } catch {
    return null;
  } finally {
    // A decoded 1600px bitmap is several megabytes. Releasing it here rather
    // than waiting for the collector keeps a hundred-photograph folder from
    // holding all of them at once.
    (image as any).close?.();
  }
};

/**
 * Crops one photograph to a box the analysis model named — the semantic
 * answer to "where is the product" for the busy-backdrop photographs the
 * border-colour estimate refuses. Padded by `pad` of the box's own size so a
 * slightly tight box never clips a heel or a sleeve, scaled to `maxEdge` in
 * ONE resample. Returns null when the box would trim less than `MIN_TRIM` of
 * the frame (not worth a re-encode) or where nothing can decode the image.
 */
export const cropToBox = async (
  base64: string,
  box: { xmin: number; ymin: number; xmax: number; ymax: number },
  maxEdge = 1024,
  pad = 0.08
): Promise<string | null> => {
  const image = await decode(base64);
  if (!image) return null;

  try {
    const width = (image as any).width ?? 0;
    const height = (image as any).height ?? 0;
    if (!width || !height) return null;

    const bw = (box.xmax - box.xmin) * width;
    const bh = (box.ymax - box.ymin) * height;
    const x0 = Math.max(0, Math.floor(box.xmin * width - bw * pad));
    const y0 = Math.max(0, Math.floor(box.ymin * height - bh * pad));
    const x1 = Math.min(width, Math.ceil(box.xmax * width + bw * pad));
    const y1 = Math.min(height, Math.ceil(box.ymax * height + bh * pad));
    const bounds = { x: x0, y: y0, width: Math.max(1, x1 - x0), height: Math.max(1, y1 - y0) };
    if (!worthCropping(bounds, width, height)) return null;

    const scale = Math.min(1, maxEdge / Math.max(bounds.width, bounds.height));
    const outWidth = Math.max(1, Math.round(bounds.width * scale));
    const outHeight = Math.max(1, Math.round(bounds.height * scale));

    const target = makeCanvas(outWidth, outHeight);
    if (!target) return null;
    const out = target.getContext('2d');
    if (!out) return null;

    out.fillStyle = '#ffffff';
    out.fillRect(0, 0, outWidth, outHeight);
    out.imageSmoothingEnabled = true;
    out.imageSmoothingQuality = 'high';
    out.drawImage(image as any, bounds.x, bounds.y, bounds.width, bounds.height, 0, 0, outWidth, outHeight);

    return await toBase64(target);
  } catch {
    return null;
  } finally {
    (image as any).close?.();
  }
};

/**
 * The whole folder, cropped where cropping is confident.
 *
 * Returns one entry per photograph in order, `null` wherever the original
 * should be used. Never throws: a photograph that cannot be cropped is a
 * photograph that is used as it is.
 */
export const isolateFolder = async (
  photos: string[],
  onProgress?: (done: number, total: number) => void,
  shouldStop?: () => boolean,
  maxEdge = 512
): Promise<(string | null)[]> => {
  const out: (string | null)[] = new Array(photos.length).fill(null);
  let done = 0;

  // A few at a time. `createImageBitmap` decodes off the main thread, so
  // photographs overlap rather than queueing behind each other — which the
  // first version of this did, and a sequential full-size decode per photograph
  // was most of the wait before any request went out.
  //
  // Four rather than more: the part that is NOT off-thread — the canvas draw
  // and the pixel scan — still serialises, and holding more decoded bitmaps
  // than that buys nothing but memory.
  await mapWithConcurrency(photos, 4, async (photo, index) => {
    if (shouldStop?.()) return;
    out[index] = await isolateSubject(photo, maxEdge);
    done += 1;
    onProgress?.(done, photos.length);
  });

  return out;
};

/**
 * `isolateFolder` on a pool of module workers - real parallelism across cores.
 *
 * The four-at-a-time concurrency in `isolateFolder` above overlaps
 * `createImageBitmap`'s off-thread decode, but the canvas draw and the pixel
 * scan that come after it still run on the main thread and still serialise
 * there — a hundred-photograph folder is a hundred photographs' worth of that
 * work queued behind the page's own rendering. Handing each crop to a worker
 * moves the whole thing, decode included, off the main thread and onto
 * whichever core is free.
 *
 * Falls back to the single-threaded `isolateFolder` wherever `Worker` is
 * unavailable (vitest, old browsers) or where constructing or talking to one
 * fails, so behaviour is identical either way and only the wall-clock
 * changes. It refuses rather than guesses about a broken worker the same way
 * `isolateSubject` refuses rather than guesses about a cluttered background:
 * the moment anything about the pool looks wrong, whatever photographs have
 * not yet come back are handed to the serial path instead.
 */
export const isolateFolderParallel = async (
  photos: string[],
  onProgress?: (done: number, total: number) => void,
  shouldStop?: () => boolean,
  maxEdge = 512
): Promise<(string | null)[]> => {
  const out: (string | null)[] = new Array(photos.length).fill(null);
  if (!photos.length) return out;

  // No Worker in this environment - the pool is skipped entirely and every
  // photo goes through the plain serial path, which gives an identical
  // result at a slower wall-clock. This is the path vitest always takes.
  if (typeof Worker === 'undefined') {
    return isolateFolder(photos, onProgress, shouldStop, maxEdge);
  }

  const hardwareConcurrency =
    typeof navigator !== 'undefined' ? navigator.hardwareConcurrency : undefined;
  const poolSize = Math.min(4, Math.max(1, (hardwareConcurrency || 2) - 1));

  let loggedOnce = false;
  const logFailureOnce = (err: unknown) => {
    if (loggedOnce) return;
    loggedOnce = true;
    // eslint-disable-next-line no-console
    console.error(
      '[isolateFolderParallel] the worker pool failed; finishing the remaining photos serially.',
      err
    );
  };

  let workers: Worker[] = [];
  try {
    workers = Array.from(
      { length: poolSize },
      () => new Worker(new URL('./cropWorker.ts', import.meta.url), { type: 'module' })
    );
  } catch (err) {
    logFailureOnce(err);
    return isolateFolder(photos, onProgress, shouldStop, maxEdge);
  }

  // Which photos actually came back from a worker. Everything left `false`
  // once the pool is done - whether because the pool broke partway through,
  // or because it never got to them - is handed to the serial fallback.
  const handled: boolean[] = new Array(photos.length).fill(false);
  let done = 0;
  let cursor = 0;
  let broken = false;

  const runOnWorker = (worker: Worker): Promise<void> =>
    new Promise((resolve) => {
      const claimNext = () => {
        if (broken || shouldStop?.() || cursor >= photos.length) {
          resolve();
          return;
        }
        const seq = cursor;
        cursor += 1;

        const cleanup = () => {
          worker.removeEventListener('message', onMessage as EventListener);
          worker.removeEventListener('error', onError as EventListener);
        };

        const onMessage = (event: MessageEvent) => {
          cleanup();
          const data = event.data ?? {};
          handled[seq] = true;
          out[seq] = data.cropped ?? null;
          done += 1;
          onProgress?.(done, photos.length);
          claimNext();
        };

        const onError = (err: unknown) => {
          cleanup();
          broken = true;
          logFailureOnce(err);
          resolve();
        };

        worker.addEventListener('message', onMessage as EventListener);
        worker.addEventListener('error', onError as EventListener);
        try {
          worker.postMessage({ photo: photos[seq], maxEdge, seq });
        } catch (err) {
          cleanup();
          broken = true;
          logFailureOnce(err);
          resolve();
        }
      };

      claimNext();
    });

  try {
    await Promise.all(workers.map(runOnWorker));
  } finally {
    workers.forEach((worker) => {
      try {
        worker.terminate();
      } catch {
        /* already gone */
      }
    });
  }

  if (shouldStop?.()) return out;

  const remaining = photos.map((_, index) => index).filter((index) => !handled[index]);
  if (remaining.length) {
    const remainingPhotos = remaining.map((index) => photos[index]);
    const results = await isolateFolder(
      remainingPhotos,
      (d) => onProgress?.(done + d, photos.length),
      shouldStop,
      maxEdge
    );
    remaining.forEach((index, i) => {
      out[index] = results[i];
    });
  }

  return out;
};
