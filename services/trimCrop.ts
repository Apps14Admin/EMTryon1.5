/**
 * THE CUTTING EDGE: a top/bottom trim of a finished render.
 *
 * The studio result panel lets the reviewer drag a yellow line down from the
 * top and up from the bottom of a render; the picture between the lines is
 * what the download keeps. The Library detail view offers the same tool on a
 * stored render. Both express the cut as percentages of the picture's height,
 * so it survives any on-screen scaling, and both go through this file:
 *   - `moveTrimHandle` is the drag arithmetic (clamped so at least
 *     MIN_KEEP_PCT of the picture always survives),
 *   - `trimRows` turns the percentages into pixel rows for a given height,
 *   - `renderTrimmed` / `trimmedDataUrl` cut the actual bytes.
 */

/** Percent of the picture's height removed from each edge. */
export interface Trim {
  top: number;
  bottom: number;
}

export type TrimHandle = 'top' | 'bottom';

export const NO_TRIM: Trim = { top: 0, bottom: 0 };

/** The two lines can never close on each other: this much always survives. */
export const MIN_KEEP_PCT = 10;

export const hasTrim = (trim: Trim): boolean => trim.top > 0 || trim.bottom > 0;

const clampPct = (value: number): number => Math.max(0, Math.min(100, value));

/** Where a pointer sits inside a box, as a percent of the box's height from its top. */
export const pointerPercent = (clientY: number, box: { top: number; height: number }): number => {
  if (!(box.height > 0)) return 0;
  return clampPct(((clientY - box.top) / box.height) * 100);
};

/**
 * One handle dragged to `pointerPct` (measured from the picture's top edge).
 * The other edge stays put; the moved edge stops MIN_KEEP_PCT short of it.
 */
export const moveTrimHandle = (trim: Trim, handle: TrimHandle, pointerPct: number): Trim => {
  const pct = clampPct(pointerPct);
  if (handle === 'top') {
    return { ...trim, top: Math.max(0, Math.min(pct, 100 - trim.bottom - MIN_KEEP_PCT)) };
  }
  const fromBottom = 100 - pct;
  return { ...trim, bottom: Math.max(0, Math.min(fromBottom, 100 - trim.top - MIN_KEEP_PCT)) };
};

/** The pixel rows a trim keeps of a picture `height` rows tall. */
export const trimRows = (height: number, trim: Trim): { y: number; height: number } => {
  const y = Math.round((clampPct(trim.top) / 100) * height);
  const cutBottom = Math.round((clampPct(trim.bottom) / 100) * height);
  return { y, height: Math.max(1, height - y - cutBottom) };
};

/** Human wording for the status line under the picture. */
export const describeTrim = (trim: Trim): string => {
  const parts: string[] = [];
  if (trim.top > 0) parts.push(`${Math.round(trim.top)}% off the top`);
  if (trim.bottom > 0) parts.push(`${Math.round(trim.bottom)}% off the bottom`);
  return parts.join(', ');
};

export const loadImage = (src: string): Promise<HTMLImageElement> =>
  new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('The picture could not be loaded for trimming'));
    img.src = src;
  });

/** The picture with its trimmed rows cut away, at full resolution. */
export const renderTrimmed = (img: HTMLImageElement, trim: Trim): HTMLCanvasElement => {
  const width = img.naturalWidth || img.width;
  const height = img.naturalHeight || img.height;
  const rows = trimRows(height, trim);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = rows.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas unavailable');
  ctx.drawImage(img, 0, rows.y, width, rows.height, 0, 0, width, rows.height);
  return canvas;
};

/** The trimmed picture as a data URL, PNG when the source was PNG, else JPEG. */
export const trimmedDataUrl = async (src: string, trim: Trim, mime?: string | null): Promise<string> => {
  const img = await loadImage(src);
  const canvas = renderTrimmed(img, trim);
  return mime === 'image/png' ? canvas.toDataURL('image/png') : canvas.toDataURL('image/jpeg', 0.92);
};
