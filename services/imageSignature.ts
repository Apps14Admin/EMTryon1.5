/**
 * Cheap, local, no-network visual fingerprints.
 *
 * Sorting a folder used to send every photo to the model and nothing else.
 * That is the expensive half of the job and most of it is not needed: whether
 * two frames are the same shot, and roughly what colour an item is, are things
 * a 9x8 and a 16x16 thumbnail already answer. The model is then only asked the
 * question it is actually good at — is this the same physical product.
 *
 * Everything here runs on the already-downscaled `scout` copy, off one decode,
 * and degrades to `null` where there is no canvas (tests, workers without DOM).
 * A null signature means "no local opinion", never a wrong one.
 */

export interface Signature {
  /** 64-bit difference hash — same framing, same bits. */
  bits: Uint8Array;
  /** 4x4x4 RGB histogram, normalised. Survives a change of angle. */
  hist: Float32Array;
}

const HIST_BINS = 64;

/** Decodes base64 JPEG bytes without going through a data: URL round trip. */
const bytesOf = (base64: string): Uint8Array => {
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
};

type Decoded = { source: CanvasImageSource; close: () => void };

const decode = async (base64: string): Promise<Decoded | null> => {
  if (typeof document === 'undefined') return null;

  const blob = new Blob([bytesOf(base64)], { type: 'image/jpeg' });

  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(blob);
      return { source: bitmap, close: () => bitmap.close() };
    } catch {
      /* falls through to the <img> route */
    }
  }

  const url = URL.createObjectURL(blob);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('decode failed'));
      el.src = url;
    });
    return { source: img, close: () => URL.revokeObjectURL(url) };
  } catch {
    URL.revokeObjectURL(url);
    return null;
  }
};

const pixelsAt = (source: CanvasImageSource, w: number, h: number): Uint8ClampedArray | null => {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(source, 0, 0, w, h);
  return ctx.getImageData(0, 0, w, h).data;
};

/** Difference hash: is each pixel brighter than the one to its right. */
const hashFrom = (pixels: Uint8ClampedArray): Uint8Array => {
  const bits = new Uint8Array(8);
  let bit = 0;

  for (let y = 0; y < 8; y += 1) {
    for (let x = 0; x < 8; x += 1) {
      const left = (y * 9 + x) * 4;
      const right = (y * 9 + x + 1) * 4;
      const a = pixels[left] * 0.299 + pixels[left + 1] * 0.587 + pixels[left + 2] * 0.114;
      const b = pixels[right] * 0.299 + pixels[right + 1] * 0.587 + pixels[right + 2] * 0.114;
      if (a > b) bits[bit >> 3] |= 1 << (bit & 7);
      bit += 1;
    }
  }

  return bits;
};

const histFrom = (pixels: Uint8ClampedArray): Float32Array => {
  const hist = new Float32Array(HIST_BINS);
  const count = pixels.length / 4;

  for (let i = 0; i < pixels.length; i += 4) {
    const bin = (pixels[i] >> 6) * 16 + (pixels[i + 1] >> 6) * 4 + (pixels[i + 2] >> 6);
    hist[bin] += 1;
  }

  for (let i = 0; i < HIST_BINS; i += 1) hist[i] /= count;
  return hist;
};

/** One photo's fingerprint, or null where the browser cannot decode it. */
export const signatureOf = async (base64: string): Promise<Signature | null> => {
  if (!base64) return null;

  let decoded: Decoded | null = null;
  try {
    decoded = await decode(base64);
    if (!decoded) return null;

    const fine = pixelsAt(decoded.source, 9, 8);
    const colour = pixelsAt(decoded.source, 16, 16);
    if (!fine || !colour) return null;

    return { bits: hashFrom(fine), hist: histFrom(colour) };
  } catch {
    return null;
  } finally {
    decoded?.close();
  }
};

const POPCOUNT = new Uint8Array(256);
for (let i = 0; i < 256; i += 1) POPCOUNT[i] = (i & 1) + POPCOUNT[i >> 1];

/** Bits that differ, 0..64. Same shot from the same spot scores under ~6. */
export const hamming = (a: Uint8Array, b: Uint8Array): number => {
  let total = 0;
  for (let i = 0; i < a.length; i += 1) total += POPCOUNT[a[i] ^ b[i]];
  return total;
};

/** 0 when the colours match, 1 when they share nothing. */
export const histDistance = (a: Float32Array, b: Float32Array): number => {
  let shared = 0;
  for (let i = 0; i < a.length; i += 1) shared += Math.min(a[i], b[i]);
  return 1 - shared;
};

/**
 * How far apart two photos look.
 *
 * Colour carries most of the weight on purpose: turning a shoe around changes
 * every edge in it and almost none of its colours, and this distance is used
 * to put photos of one product next to each other, not to tell them apart.
 */
export const visualDistance = (a: Signature | null, b: Signature | null): number => {
  if (!a || !b) return 1;
  return 0.72 * histDistance(a.hist, b.hist) + 0.28 * (hamming(a.bits, b.bits) / 64);
};

/** The same frame twice — a burst, a duplicate, an export at two sizes. */
export const isNearDuplicate = (a: Signature | null, b: Signature | null): boolean =>
  !!a && !!b && hamming(a.bits, b.bits) <= 6 && histDistance(a.hist, b.hist) <= 0.12;
