/**
 * Browser-side image preparation.
 *
 * Photos straight off a phone are 3-5 MB each. Base64 inflates them ~33%, and
 * Gemini rejects inline request bodies over ~20 MB — so a handful of raw
 * uploads can fail the whole render. Gemini also tokenizes images at a fixed
 * rate regardless of resolution, so downscaling costs nothing in quality of
 * understanding while making the payload a fraction of the size.
 */

export const MAX_EDGE = 1600;
export const JPEG_QUALITY = 0.85;

/**
 * Longest edge for the copy the review grid shows.
 *
 * Big enough to check a grouping by eye — telling two near-identical sneakers
 * apart comes down to logo size, eyelet count and midsole shape, and those
 * stop being legible well before the silhouette does. It never goes over the
 * wire; only SCOUT_EDGE does.
 */
export const THUMB_EDGE = 768;

/**
 * Longest edge for the copies the grouping requests actually carry.
 *
 * A dozen of these go out per request and several requests are in flight at
 * once, so this size sets how long sorting takes. Deciding whether two photos
 * are the same physical item is a judgement about colourway, silhouette and
 * where the branding sits — all of it legible here, at a fraction of the bytes
 * a THUMB_EDGE copy would cost.
 */
export const SCOUT_EDGE = 512;

export interface PreparedImage {
  /** base64 payload, no data: prefix */
  base64: string;
  width: number;
  height: number;
  /** approximate encoded size in bytes */
  bytes: number;
}

const readAsDataUrl = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error('Could not read file'));
    reader.readAsDataURL(file);
  });

const loadImage = (src: string): Promise<HTMLImageElement> =>
  new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Could not decode image'));
    img.src = src;
  });

/** Smallest longest-edge worth producing; below this the image is unreadable. */
export const MIN_EDGE = 64;

/**
 * Keeps a nonsense size cap from silently producing an unusable image.
 *
 * `prepareImageFile` takes an optional cap, which makes it a hazard to pass
 * straight to `Array.map` — map's index argument arrives as the cap, and a cap
 * of 1 yields a one-pixel photograph that still renders, still uploads, and
 * looks like a blurred smear rather than an error.
 */
export const resolveMaxEdge = (value: unknown): number => {
  const n = Number(value);
  if (!Number.isFinite(n) || n < MIN_EDGE) return MAX_EDGE;
  return n;
};

/**
 * Downscales to MAX_EDGE on the longest side and re-encodes as JPEG.
 * Falls back to the original bytes if anything goes wrong, so an unusual
 * format never blocks an upload.
 */
export async function prepareImageFile(
  file: File,
  maxEdgeInput: number = MAX_EDGE
): Promise<PreparedImage> {
  const maxEdge = resolveMaxEdge(maxEdgeInput);
  const dataUrl = await readAsDataUrl(file);
  const rawBase64 = dataUrl.split(',')[1] ?? '';

  try {
    const img = await loadImage(dataUrl);
    const { width, height } = img;
    const scale = Math.min(1, maxEdge / Math.max(width, height));

    // Already small enough — keep the original bytes untouched.
    if (scale === 1 && file.size <= 900_000) {
      return { base64: rawBase64, width, height, bytes: file.size };
    }

    const w = Math.round(width * scale);
    const h = Math.round(height * scale);

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('no 2d context');

    // White matte so transparent PNGs don't turn black as JPEG.
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);

    const out = canvas.toDataURL('image/jpeg', JPEG_QUALITY).split(',')[1];
    if (!out) throw new Error('encode failed');

    return { base64: out, width: w, height: h, bytes: Math.round(out.length * 0.75) };
  } catch {
    return { base64: rawBase64, width: 0, height: 0, bytes: file.size };
  }
}

/** A decoded picture, whatever route decoded it. */
type Decoded = { source: CanvasImageSource; width: number; height: number; close: () => void };

/**
 * Decodes a file once, by the cheapest route the browser offers.
 *
 * `createImageBitmap` reads the Blob directly and decodes off the main thread.
 * The FileReader route below has to turn several megabytes into a base64
 * string first and then decode that string — for a folder of 110 phone photos
 * the difference is minutes.
 */
const decodeOnce = async (file: File): Promise<Decoded> => {
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(file);
      return {
        source: bitmap,
        width: bitmap.width,
        height: bitmap.height,
        close: () => bitmap.close(),
      };
    } catch {
      // Falls through to the older route, which handles a few formats
      // createImageBitmap refuses.
    }
  }

  const img = await loadImage(await readAsDataUrl(file));
  return { source: img, width: img.width, height: img.height, close: () => {} };
};

/** Draws an already-decoded picture at one size and encodes it as JPEG. */
const encodeAt = (decoded: Decoded, maxEdge: number): PreparedImage => {
  const scale = Math.min(1, maxEdge / Math.max(decoded.width, decoded.height));
  const w = Math.max(1, Math.round(decoded.width * scale));
  const h = Math.max(1, Math.round(decoded.height * scale));

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('no 2d context');

  // White matte so transparent PNGs don't turn black as JPEG.
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(decoded.source, 0, 0, w, h);

  const out = canvas.toDataURL('image/jpeg', JPEG_QUALITY).split(',')[1];
  if (!out) throw new Error('encode failed');

  return { base64: out, width: w, height: h, bytes: Math.round(out.length * 0.75) };
};

/**
 * Produces several sizes of one photo from a SINGLE read and a SINGLE decode.
 *
 * The folder upload needs two copies of every photo — a full-size one to
 * render from and a small one to sort with — and preparing them independently
 * did all the expensive work twice per photo.
 */
export async function prepareImageSizes(
  file: File,
  edges: number[]
): Promise<PreparedImage[]> {
  const sizes = edges.map(resolveMaxEdge);

  try {
    const decoded = await decodeOnce(file);
    try {
      return sizes.map((edge) => encodeAt(decoded, edge));
    } finally {
      decoded.close();
    }
  } catch {
    // An unusual format must not block an upload: fall back to the original
    // bytes at every requested size.
    const dataUrl = await readAsDataUrl(file).catch(() => '');
    const raw = dataUrl.split(',')[1] ?? '';
    return sizes.map(() => ({ base64: raw, width: 0, height: 0, bytes: file.size }));
  }
}

/**
 * Runs an async job over a list a few at a time, keeping the results in order.
 *
 * Preparing a folder one photo at a time leaves the machine idle between the
 * decode and the encode of each; a small amount of overlap makes a large
 * folder several times quicker without flooding memory with decoded bitmaps.
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  job: (item: T, index: number) => Promise<R>,
  onDone?: (completed: number) => void
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  let completed = 0;

  const worker = async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;

      results[index] = await job(items[index], index);
      completed += 1;
      onDone?.(completed);
    }
  };

  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker)
  );

  return results;
}

export const formatBytes = (bytes: number): string =>
  bytes >= 1_000_000 ? `${(bytes / 1_000_000).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1000))} KB`;
