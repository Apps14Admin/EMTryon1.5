/**
 * SEVERAL PHOTOGRAPHS COMPOSITED INTO ONE LABELLED IMAGE.
 *
 * This is a small file doing something the old architecture never did, and the
 * reason it matters is worth stating plainly.
 *
 * The old pipeline sent twelve separate images in one request and asked for a
 * per-image answer. A vision model handles that by encoding each image on its
 * own; comparing them is then something it has to do across twelve separate
 * representations, and its answer about photograph 7 is an answer about
 * photograph 7. The one question that actually matters here — "is the thing in
 * THIS frame the same object as the thing in THAT frame" — is exactly the
 * question that shape of request makes hardest.
 *
 * A contact sheet asks the same question the way a person would: the
 * photographs are side by side in ONE picture, at the same scale, on a neutral
 * ground, each with a number painted on it. Comparing two of them is then a
 * local operation within a single image, which is what these models are good
 * at. The numbers are painted INTO the pixels rather than passed alongside,
 * because a label the model can read off the picture cannot drift out of step
 * with the picture the way an ordering convention in a prompt can.
 *
 * It is also cheaper. One composited sheet costs a fraction of nine separate
 * photographs, so the request that compares more pairs also spends fewer tokens
 * doing it.
 *
 * The layout arithmetic is pure and lives here so it can be tested; the drawing
 * needs a canvas and degrades to `null` where there is none, exactly as
 * `imageSignature.ts` does.
 */

/**
 * Longest edge of the finished sheet.
 *
 * Read this as a per-shoe number rather than a per-sheet one, because that is
 * what it decides. Nine photographs in a 3x3 grid give each one a cell of
 * SHEET_PIXELS / 3: at 1024 that is 341 pixels of shoe, and a 341-pixel shoe
 * does not show an outsole tread, a stitch line or the colour of a lining
 * through the opening. Those are the features the entire architecture rests on
 * being able to see, so starving them to save tokens is a false economy — the
 * request still gets sent, it just gets sent blind.
 *
 * 1536 gives 512-pixel cells and costs roughly twice the image tokens of 1024,
 * which is still a fraction of what the old pipeline spent sending twelve
 * separate photographs per request.
 */
export const SHEET_PIXELS = 1536;

/** Ground the photographs are laid on. Mid grey: neither a white nor a black
 * product disappears into it, and it is obviously not part of any item. */
export const SHEET_BACKGROUND = '#8a8a8a';

/** Room under each photograph for its number. */
export const LABEL_BAND = 26;

export interface Cell {
  /** The photograph's number, painted on the sheet and used in the reply. */
  label: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SheetLayout {
  columns: number;
  rows: number;
  /** The square each photograph is fitted into, label band included. */
  cell: number;
  width: number;
  height: number;
  cells: Cell[];
}

/**
 * Where each photograph goes.
 *
 * Square-ish grids on purpose: a 3x3 of nine photographs gives every one of
 * them the same area and puts every pair within a short distance of each other
 * in the frame. A 9x1 strip would make the same nine photographs much smaller
 * and put the first and last as far apart as the image allows.
 */
export const sheetLayout = (count: number, pixels: number = SHEET_PIXELS): SheetLayout => {
  if (count <= 0) return { columns: 0, rows: 0, cell: 0, width: 0, height: 0, cells: [] };

  const columns = Math.ceil(Math.sqrt(count));
  const rows = Math.ceil(count / columns);
  const cell = Math.floor(pixels / Math.max(columns, rows));

  const cells: Cell[] = [];
  for (let i = 0; i < count; i += 1) {
    const column = i % columns;
    const row = Math.floor(i / columns);
    cells.push({
      label: i,
      x: column * cell,
      y: row * cell,
      width: cell,
      height: cell - LABEL_BAND,
    });
  }

  return { columns, rows, cell, width: columns * cell, height: rows * cell, cells };
};

/**
 * Layout for the identity question: the anchor large on the left (45% of the
 * width), candidates in a grid on the right. The anchor must be visually
 * unmistakable - the whole request is "compare everything to THIS".
 */
export const anchorSheetLayout = (
  candidates: number,
  pixels: number = SHEET_PIXELS
): SheetLayout => {
  const anchorWidth = Math.round(pixels * 0.45);
  const rightWidth = pixels - anchorWidth;

  const columns = candidates <= 2 ? 1 : 2;
  const rows = Math.ceil(candidates / columns);
  const cellWidth = Math.floor(rightWidth / columns);
  const cellHeight = Math.floor(cellWidth * 0.9);
  const height = Math.max(
    rows * (cellHeight + LABEL_BAND),
    Math.round(pixels * 0.6)
  );

  const cells: Cell[] = [
    { x: 0, y: 0, width: anchorWidth, height: height - LABEL_BAND, label: 0 },
  ];
  for (let i = 0; i < candidates; i += 1) {
    const column = i % columns;
    const row = Math.floor(i / columns);
    cells.push({
      x: anchorWidth + column * cellWidth,
      y: row * (cellHeight + LABEL_BAND),
      width: cellWidth,
      height: cellHeight,
      label: i + 1,
    });
  }
  // columns/rows/cell describe the right-hand candidate grid; the anchor
  // itself isn't a uniform grid cell, so these are informational only —
  // nothing downstream reads them for an anchor sheet.
  return { columns: columns + 1, rows, cell: cellWidth, width: pixels, height, cells };
};

/**
 * Fits a photograph inside its cell without distorting it.
 *
 * Letterboxed rather than cropped, and this is not a detail. Cropping to fill a
 * square would cut the ends off a boot and the edges off a sole — which is
 * where the tread pattern, the heel tab and the toe bumper live, and those are
 * precisely the features that separate two items of one model. A shape squashed
 * to fit is worse still: it changes the silhouette, which is evidence.
 */
export const fitInside = (
  imageWidth: number,
  imageHeight: number,
  cell: Cell
): { x: number; y: number; width: number; height: number } => {
  if (!imageWidth || !imageHeight) {
    return { x: cell.x, y: cell.y, width: cell.width, height: cell.height };
  }

  const scale = Math.min(cell.width / imageWidth, cell.height / imageHeight);
  const width = imageWidth * scale;
  const height = imageHeight * scale;

  return {
    x: cell.x + (cell.width - width) / 2,
    y: cell.y + (cell.height - height) / 2,
    width,
    height,
  };
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

/**
 * Draws a layout onto a canvas and exports it as base64 JPEG.
 *
 * Shared by `buildContactSheet` and `buildAnchorSheet` — both hand it a
 * `SheetLayout` and the photographs to place into its cells; only the layout
 * math differs between a plain grid and an anchor-plus-candidates sheet.
 *
 * Returns base64 JPEG with no `data:` prefix, matching what every other image
 * in this codebase carries, or `null` where there is no canvas — in which case
 * the caller falls back to sending the photographs separately rather than
 * failing. A missing sheet costs money and precision, never correctness.
 */
const paint = async (
  layout: SheetLayout,
  photos: string[]
): Promise<string | null> => {
  const canvas: any =
    typeof OffscreenCanvas !== 'undefined'
      ? new OffscreenCanvas(layout.width, layout.height)
      : Object.assign(document.createElement('canvas'), {
          width: layout.width,
          height: layout.height,
        });

  const context = canvas.getContext('2d');
  if (!context) return null;

  context.fillStyle = SHEET_BACKGROUND;
  context.fillRect(0, 0, layout.width, layout.height);

  const decoded = await Promise.all(photos.map(decode));

  decoded.forEach((image, i) => {
    const cell = layout.cells[i];
    if (!cell) return;

    if (image) {
      const width = (image as any).width ?? 0;
      const height = (image as any).height ?? 0;
      const box = fitInside(width, height, cell);
      // A white mat behind each photograph, so a letterboxed shot reads as a
      // photograph on a sheet rather than as an item with grey panels.
      context.fillStyle = '#ffffff';
      context.fillRect(box.x, box.y, box.width, box.height);
      try {
        context.drawImage(image as any, box.x, box.y, box.width, box.height);
      } catch {
        /* an undecodable frame leaves its cell blank rather than failing the sheet */
      }
    }

    // The number, painted large and high-contrast in the band under the cell.
    // White on black so it survives whatever the photograph above it looks like.
    const bandY = cell.y + cell.height;
    context.fillStyle = '#000000';
    context.fillRect(cell.x, bandY, cell.width, LABEL_BAND);
    context.fillStyle = '#ffffff';
    context.font = `bold ${LABEL_BAND - 8}px sans-serif`;
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText(String(cell.label), cell.x + cell.width / 2, bandY + LABEL_BAND / 2);
  });

  try {
    if (typeof canvas.convertToBlob === 'function') {
      const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.9 });
      const buffer = new Uint8Array(await blob.arrayBuffer());
      let binary = '';
      buffer.forEach((byte) => {
        binary += String.fromCharCode(byte);
      });
      return btoa(binary);
    }
    return canvas.toDataURL('image/jpeg', 0.9).split(',')[1] ?? null;
  } catch {
    return null;
  }
};

/**
 * Draws the sheet.
 *
 * Returns base64 JPEG with no `data:` prefix, matching what every other image
 * in this codebase carries, or `null` where there is no canvas — in which case
 * the caller falls back to sending the photographs separately rather than
 * failing. A missing sheet costs money and precision, never correctness.
 */
export const buildContactSheet = async (
  photos: string[],
  pixels: number = SHEET_PIXELS
): Promise<string | null> => {
  if (!photos.length) return null;
  if (typeof document === 'undefined' && typeof OffscreenCanvas === 'undefined') return null;
  return paint(sheetLayout(photos.length, pixels), photos);
};

/**
 * Draws an anchor sheet. photos[0] is the anchor; the rest are candidates in
 * order. Same contract as buildContactSheet: base64 JPEG, or null where there
 * is no canvas, in which case the caller sends the photographs separately.
 */
export const buildAnchorSheet = async (
  photos: string[],
  pixels: number = SHEET_PIXELS
): Promise<string | null> => {
  if (photos.length < 2) return null;
  if (typeof document === 'undefined' && typeof OffscreenCanvas === 'undefined') return null;
  return paint(anchorSheetLayout(photos.length - 1, pixels), photos);
};
