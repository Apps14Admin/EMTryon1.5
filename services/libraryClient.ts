/**
 * Browser side of the generation Library.
 *
 * Every successful render is posted here ONCE, straight after the provider
 * returns it, and the server puts the bytes in Cloud Storage and the record in
 * Firestore. The browser holds no credentials for either — the same contract
 * as the Gemini proxy: the client talks to this application's own server, and
 * the server talks to Google.
 */

import type { UnitKind, UnitSource } from './libraryUnit';

export interface LibraryProduct {
  id: string | null;
  name: string | null;
  category: string | null;
  brand: string | null;
  colour: string | null;
  description: string | null;
}

export interface GenerationRecord {
  id: string;
  createdAt: string;
  styleId: string | null;
  styleLabel: string | null;
  product: LibraryProduct | null;
  provider: string | null;
  model: string | null;
  quality: string | null;
  sceneMode: string | null;
  prompt: string | null;
  mime: string;
  hasThumb: boolean;
  hasSource: boolean;
  /** Set by the reviewer; records stored before the flag existed carry none. */
  approved?: boolean;
  /** What the render is of, numbered by the Library; older records carry none. */
  kind?: UnitKind | null;
  source?: UnitSource | null;
  serial?: number | null;
  /** "Product 12" / "Outfit 3". */
  unitLabel?: string | null;
}

export interface LibraryQuery {
  q?: string;
  category?: string;
  product?: string;
  /** A unit label, exactly as the Library numbered it: "Product 12". */
  unit?: string;
  source?: UnitSource;
  kind?: UnitKind;
  style?: string;
  provider?: string;
  from?: string;
  to?: string;
  /** true: approved renders only; false: unreviewed only; unset: all. */
  approved?: boolean;
  sort?: 'newest' | 'oldest';
  cursor?: string;
  limit?: number;
}

export interface LibraryPage {
  items: GenerationRecord[];
  nextCursor: string | null;
  /** Collection size when the query holds no filters; null otherwise. */
  total: number | null;
}

export interface FacetEntry {
  value: string;
  label: string;
  count: number;
  /** Optional heading the option is listed under ("Products", "Outfits"). */
  group?: string;
}

export interface LibraryFacets {
  categories: FacetEntry[];
  products: FacetEntry[];
  /** Numbered units, products first then outfits, each in numbering order. */
  units: FacetEntry[];
  sources: FacetEntry[];
  styles: FacetEntry[];
  providers: FacetEntry[];
  /** Approved renders among the sampled records. */
  approved: number;
  sampled: number;
}

export interface SaveGenerationInput {
  /** Stable per render attempt. Replays with the same id store nothing twice. */
  id?: string;
  /** The generated picture, as the renderer returned it. */
  imageDataUrl: string;
  /** A representative photo of the source garment, if one is at hand. */
  sourceDataUrl?: string | null;
  meta: {
    styleId: string;
    styleLabel: string;
    product?: Partial<LibraryProduct> | null;
    provider?: string;
    model?: string;
    quality?: string;
    sceneMode?: string;
    prompt?: string;
    /** The unit this render is of; the server numbers it. */
    kind?: UnitKind;
    source?: UnitSource;
    unitKey?: string;
  };
}

const API = '/api/library';

/** Where a stored image is served from. Stable for the record's lifetime. */
export const libraryImageUrl = (id: string, kind: 'image' | 'thumb' | 'source' = 'image'): string =>
  `${API}/image/${id}/${kind}`;

export const newGenerationId = (): string =>
  `gen-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

/**
 * A deterministic id from an upstream name, for paths that may collect the
 * same finished work twice (a batch job resumed after a reload). Same input,
 * same id — and the server stores a given id exactly once.
 */
export const stableGenerationId = (raw: string): string => {
  let hash = 5381;
  for (let i = 0; i < raw.length; i += 1) hash = ((hash << 5) + hash + raw.charCodeAt(i)) >>> 0;
  const slug = raw.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(-48);
  return `b-${hash.toString(36)}-${slug}`.slice(0, 80);
};

/** The mime a bare base64 payload encodes, read from its magic bytes. */
const mimeOfBase64 = (b64: string): string =>
  b64.startsWith('iVBORw0') ? 'image/png' : b64.startsWith('UklGR') ? 'image/webp' : 'image/jpeg';

/** Anything the UI holds — data URL or raw base64 — as a data URL. */
const asDataUrl = (value: string): string =>
  value.startsWith('data:') ? value : `data:${mimeOfBase64(value)};base64,${value}`;

/**
 * A small JPEG copy for the Library grid, made in the browser so the server
 * needs no image pipeline. Returns null when the environment cannot rasterise
 * (an old browser, a test runner) — the grid then falls back to the full file.
 */
export const makeJpegThumb = async (
  dataUrl: string,
  maxEdge = 480,
  quality = 0.8
): Promise<string | null> => {
  try {
    const img = new Image();
    img.src = asDataUrl(dataUrl);
    await img.decode();

    const scale = Math.min(1, maxEdge / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));

    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', quality);
  } catch {
    return null;
  }
};

const asError = async (res: Response, fallback: string): Promise<Error> => {
  try {
    const body = await res.json();
    return new Error(body?.error || fallback);
  } catch {
    return new Error(fallback);
  }
};

/**
 * Saves one finished render permanently. Throws on failure — the caller
 * decides how to surface that, and the requirement is explicit: a failed save
 * is reported, never passed off as a saved one.
 */
export async function saveGeneration(input: SaveGenerationInput): Promise<GenerationRecord> {
  const [thumb, source] = await Promise.all([
    makeJpegThumb(input.imageDataUrl),
    input.sourceDataUrl ? makeJpegThumb(input.sourceDataUrl, 480, 0.75) : Promise.resolve(null),
  ]);

  const res = await fetch(API, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      id: input.id || newGenerationId(),
      image: asDataUrl(input.imageDataUrl),
      thumb,
      source,
      meta: input.meta,
    }),
  });

  if (!res.ok) throw await asError(res, `Library save failed (${res.status})`);
  const { record } = await res.json();
  return record as GenerationRecord;
}

export async function fetchLibrary(query: LibraryQuery = {}): Promise<LibraryPage> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== '') params.set(key, String(value));
  }
  const res = await fetch(`${API}?${params}`);
  if (!res.ok) throw await asError(res, `Library read failed (${res.status})`);
  return (await res.json()) as LibraryPage;
}

export async function fetchFacets(): Promise<LibraryFacets> {
  const res = await fetch(`${API}/facets`);
  if (!res.ok) throw await asError(res, `Library facets failed (${res.status})`);
  return (await res.json()) as LibraryFacets;
}

export async function deleteGeneration(id: string): Promise<void> {
  const res = await fetch(`${API}/${id}`, { method: 'DELETE' });
  if (!res.ok) throw await asError(res, `Library delete failed (${res.status})`);
}

/** Marks a stored render approved (or not). Returns the updated record. */
export async function setGenerationApproved(id: string, approved: boolean): Promise<GenerationRecord> {
  const res = await fetch(`${API}/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ approved }),
  });
  if (!res.ok) throw await asError(res, `Library approval failed (${res.status})`);
  const { record } = await res.json();
  return record as GenerationRecord;
}
