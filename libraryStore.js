import fs from 'fs';
import path from 'path';
import { pipeline } from 'stream/promises';

// --- persistence -----------------------------------------------------------
// The Library has to outlive the instance for the same reason the counter
// does: Cloud Run runs with min-instances=0, so the container filesystem is
// discarded whenever traffic pauses. Setting LIBRARY_BUCKET points the store
// at Cloud Storage for the image bytes and Firestore for the metadata — both
// reached through the service account the container already runs as, so no
// key ships with the code. Without that variable — `npm run dev` — it falls
// back to a directory of files, the same shape the counter store uses.

const BUCKET = process.env.LIBRARY_BUCKET;
const PREFIX = process.env.LIBRARY_PREFIX || 'generations';
const COLLECTION = process.env.LIBRARY_COLLECTION || 'generations';

// Resolved from the working directory, not import.meta.url, for the same
// reason as counterStore: Vite inlines this module into a bundled config, and
// cwd is the anchor both `npm run dev` and the container share.
const STORE_DIR = path.join(process.cwd(), 'data', 'library');
// The unit counters and the units already numbered, beside the records.
const UNITS_FILE = path.join(process.cwd(), 'data', 'library-units.json');

// Request body cap. Matches the proxies' 64mb express.raw limit.
const MAX_BODY = 64 * 1024 * 1024;

// Decoded image caps. A render is a few MB; anything past these is not one.
const MAX_IMAGE = 24 * 1024 * 1024;
const MAX_EXTRA = 4 * 1024 * 1024; // thumb / source, downscaled client-side

const PAGE_LIMIT_MAX = 60;
const PAGE_LIMIT_DEFAULT = 24;
// How many records one list request may read through while filtering before
// answering with what it has. Keeps a heavily filtered query from scanning
// the whole collection in one request; the cursor lets the client continue.
const SCAN_CAP = 1000;
// How many recent records the facet aggregation reads.
const FACET_SCAN = 2000;
const FACET_TTL_MS = 60_000;

/** Ids are storage keys and file names, so their alphabet is closed. */
const ID_RE = /^[A-Za-z0-9_-]{6,80}$/;

const IMAGE_KINDS = { image: 'image', thumb: 'thumb', source: 'source' };

// What a render is OF. Each kind counts from its own counter — "Product 12",
// "Outfit 3" — and the counter lives with the records, so numbers never
// reset the way the session's product-N ids do.
const UNIT_KINDS = ['product', 'outfit'];
const UNIT_SOURCES = ['folder', 'manual', 'mixed'];
const SOURCE_LABELS = { folder: 'Folder', manual: 'Manual', mixed: 'Folder + manual' };
const unitLabelOf = (kind, serial) => (kind === 'outfit' ? `Outfit ${serial}` : `Product ${serial}`);

// --- record shape ----------------------------------------------------------

const clip = (value, max) =>
  typeof value === 'string' ? value.slice(0, max) : undefined;

/**
 * The stored record, built only from fields this module names. Everything the
 * client sends outside this list is dropped, so the collection's shape is
 * decided here and not by whichever bundle happens to be cached in a browser.
 */
const buildRecord = (id, meta, flags) => {
  const product =
    meta.product && typeof meta.product === 'object'
      ? {
          id: clip(meta.product.id, 80) ?? null,
          name: clip(meta.product.name, 200) ?? null,
          category: clip(meta.product.category, 40) ?? null,
          brand: clip(meta.product.brand, 100) ?? null,
          colour: clip(meta.product.colour, 100) ?? null,
          description: clip(meta.product.description, 500) ?? null,
        }
      : null;

  return {
    id,
    createdAt: new Date().toISOString(),
    styleId: clip(meta.styleId, 80) ?? null,
    styleLabel: clip(meta.styleLabel, 200) ?? null,
    product,
    provider: clip(meta.provider, 40) ?? null,
    model: clip(meta.model, 80) ?? null,
    quality: clip(meta.quality, 40) ?? null,
    sceneMode: clip(meta.sceneMode, 40) ?? null,
    prompt: clip(meta.prompt, 2000) ?? null,
    mime: flags.mime,
    hasThumb: flags.hasThumb,
    hasSource: flags.hasSource,
    // Every render starts unreviewed; only a PATCH from the reviewer flips it.
    approved: false,
    // The unit this render belongs to — one product or one composed outfit —
    // and where its garments came from. `serial` and `unitLabel` are
    // allocated on save, never taken from the client.
    kind: UNIT_KINDS.includes(meta.kind) ? meta.kind : null,
    source: UNIT_SOURCES.includes(meta.source) ? meta.source : null,
    unitKey: clip(meta.unitKey, 200) ?? null,
    serial: null,
    unitLabel: null,
    // No authentication is active in this application; kept so records need no
    // migration if that changes.
    userId: null,
  };
};

/** Splits a data URL into bytes and mime; null when it is not an image one. */
const decodeDataUrl = (value, maxBytes) => {
  if (typeof value !== 'string') return null;
  const match = /^data:(image\/(?:png|jpeg|jpg|webp));base64,([A-Za-z0-9+/=\s]+)$/.exec(value);
  if (!match) return null;
  const bytes = Buffer.from(match[2], 'base64');
  if (!bytes.length || bytes.length > maxBytes) return null;
  return { mime: match[1] === 'image/jpg' ? 'image/jpeg' : match[1], bytes };
};

const extOf = (mime) =>
  mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : 'jpg';

// --- backends --------------------------------------------------------------
// One interface, two implementations. `cloud` is Cloud Storage + Firestore and
// is what production runs; `local` is a directory of files for `npm run dev`.
// Both are loaded lazily so the dev server never touches the cloud SDKs.

let backend = null;

const cloudBackend = async () => {
  const { Storage } = await import('@google-cloud/storage');
  const { Firestore, FieldPath } = await import('@google-cloud/firestore');

  const bucket = new Storage().bucket(BUCKET);
  const db = new Firestore();
  const collection = db.collection(COLLECTION);
  const units = db.collection(`${COLLECTION}_units`);
  const counters = db.collection(`${COLLECTION}_meta`).doc('counters');
  const fileOf = (id, kind, ext) => bucket.file(`${PREFIX}/${id}/${kind}.${ext}`);

  return {
    /** Create-only. Returns the stored record — the existing one on replay. */
    async save(record, files) {
      await Promise.all(
        files.map(({ kind, mime, bytes }) =>
          fileOf(record.id, kind, extOf(mime)).save(bytes, {
            contentType: mime,
            resumable: false,
          })
        )
      );
      try {
        await collection.doc(record.id).create(record);
        return record;
      } catch (err) {
        if (err.code === 6 /* ALREADY_EXISTS */) {
          const existing = await collection.doc(record.id).get();
          return existing.data();
        }
        throw err;
      }
    },

    /**
     * Records in createdAt order, walked with a cursor. `filter` is applied
     * here, server-side, so the browser only ever receives one page.
     */
    async list({ sort, cursor, limit, filter }) {
      // The document id breaks createdAt ties so the cursor never skips or
      // repeats a record. Its direction FOLLOWS the primary sort: that makes
      // the newest-first query the exact reverse of the oldest-first one, and
      // one composite index (createdAt ASC, __name__ ASC) serves both.
      const direction = sort === 'oldest' ? 'asc' : 'desc';
      let query = collection
        .orderBy('createdAt', direction)
        .orderBy(FieldPath.documentId(), direction);
      if (cursor) query = query.startAfter(cursor.createdAt, cursor.id);

      const items = [];
      let scanned = 0;
      let last = null;

      while (items.length <= limit && scanned < SCAN_CAP) {
        const batch = await query.limit(200).get();
        if (batch.empty) { last = null; break; }

        for (const doc of batch.docs) {
          scanned += 1;
          last = doc;
          const record = doc.data();
          if (filter(record)) {
            items.push(record);
            if (items.length > limit) break;
          }
        }
        if (batch.size < 200) { if (items.length <= limit) last = null; break; }
        query = collection
          .orderBy('createdAt', direction)
          .orderBy(FieldPath.documentId(), direction)
          .startAfter(last.data().createdAt, last.id);
      }

      const more = items.length > limit;
      const page = items.slice(0, limit);
      // Resume from the last record actually sent, or, when the scan cap cut
      // an unfinished walk short, from wherever the walk stopped.
      const tail = more ? page[page.length - 1] : last && scanned >= SCAN_CAP ? last.data() : null;
      return {
        items: page,
        nextCursor: tail ? { createdAt: tail.createdAt, id: tail.id } : null,
      };
    },

    async total() {
      const snap = await collection.count().get();
      return snap.data().count;
    },

    /** The most recent records, for facet aggregation. */
    async recent(count) {
      const snap = await collection.orderBy('createdAt', 'desc').limit(count).get();
      return snap.docs.map((doc) => doc.data());
    },

    async get(id) {
      const doc = await collection.doc(id).get();
      return doc.exists ? doc.data() : null;
    },

    /** Merges `patch` into an existing record and returns the result. */
    async update(id, patch) {
      const ref = collection.doc(id);
      await ref.update(patch);
      return (await ref.get()).data();
    },

    /**
     * The number a unit already has, or the next of its kind. One
     * transaction, so the shots of one unit saving in parallel cannot each
     * take a number.
     */
    async allocateSerial(unitKey, kind) {
      const unitRef = units.doc(encodeURIComponent(unitKey));
      return db.runTransaction(async (tx) => {
        const unit = await tx.get(unitRef);
        if (unit.exists) return unit.data().serial;
        const current = await tx.get(counters);
        const serial = ((current.exists && current.data()[kind]) || 0) + 1;
        tx.set(counters, { [kind]: serial }, { merge: true });
        tx.set(unitRef, { unitKey, kind, serial, createdAt: new Date().toISOString() });
        return serial;
      });
    },

    async stream(record, kind, res) {
      const mime = kind === 'image' ? record.mime : 'image/jpeg';
      const file = fileOf(record.id, kind, extOf(mime));
      res.setHeader('content-type', mime);
      // Bytes at an id never change, so the browser may keep them for good.
      res.setHeader('cache-control', 'private, max-age=31536000, immutable');
      await pipeline(file.createReadStream(), res);
    },

    async remove(id) {
      await collection.doc(id).delete();
      await bucket.deleteFiles({ prefix: `${PREFIX}/${id}/` });
    },
  };
};

const localBackend = () => {
  const dirOf = (id) => path.join(STORE_DIR, id);
  const recordPath = (id) => path.join(dirOf(id), 'record.json');
  const readRecord = (id) => {
    try {
      return JSON.parse(fs.readFileSync(recordPath(id), 'utf8'));
    } catch {
      return null;
    }
  };
  const readAll = () => {
    let ids = [];
    try {
      ids = fs.readdirSync(STORE_DIR);
    } catch {
      return [];
    }
    return ids.map(readRecord).filter(Boolean);
  };

  return {
    async save(record, files) {
      const existing = readRecord(record.id);
      if (existing) return existing;
      fs.mkdirSync(dirOf(record.id), { recursive: true });
      for (const { kind, mime, bytes } of files) {
        fs.writeFileSync(path.join(dirOf(record.id), `${kind}.${extOf(mime)}`), bytes);
      }
      fs.writeFileSync(recordPath(record.id), JSON.stringify(record, null, 2));
      return record;
    },

    async list({ sort, cursor, limit, filter }) {
      const ordered = readAll().sort((a, b) =>
        sort === 'oldest'
          ? a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)
          : b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)
      );
      let start = 0;
      if (cursor) {
        const at = ordered.findIndex((r) => r.id === cursor.id);
        start = at === -1 ? 0 : at + 1;
      }
      const matched = ordered.slice(start).filter(filter);
      const page = matched.slice(0, limit);
      const tail = matched.length > limit ? page[page.length - 1] : null;
      return {
        items: page,
        nextCursor: tail ? { createdAt: tail.createdAt, id: tail.id } : null,
      };
    },

    async total() {
      return readAll().length;
    },

    async recent(count) {
      return readAll()
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, count);
    },

    async get(id) {
      return readRecord(id);
    },

    /** Merges `patch` into an existing record and returns the result. */
    async update(id, patch) {
      const next = { ...readRecord(id), ...patch };
      fs.writeFileSync(recordPath(id), JSON.stringify(next, null, 2));
      return next;
    },

    /** Read-modify-write with no await between: atomic within one process. */
    async allocateSerial(unitKey, kind) {
      let state;
      try {
        state = JSON.parse(fs.readFileSync(UNITS_FILE, 'utf8'));
      } catch {
        state = { counters: {}, units: {} };
      }
      const known = state.units[unitKey];
      if (known) return known.serial;
      const serial = (state.counters[kind] || 0) + 1;
      state.counters[kind] = serial;
      state.units[unitKey] = { kind, serial };
      fs.mkdirSync(path.dirname(UNITS_FILE), { recursive: true });
      fs.writeFileSync(UNITS_FILE, JSON.stringify(state, null, 2));
      return serial;
    },

    async stream(record, kind, res) {
      const mime = kind === 'image' ? record.mime : 'image/jpeg';
      const file = path.join(dirOf(record.id), `${kind}.${extOf(mime)}`);
      res.setHeader('content-type', mime);
      res.setHeader('cache-control', 'private, max-age=31536000, immutable');
      await pipeline(fs.createReadStream(file), res);
    },

    async remove(id) {
      fs.rmSync(dirOf(id), { recursive: true, force: true });
    },
  };
};

async function getBackend() {
  if (!backend) backend = BUCKET ? await cloudBackend() : localBackend();
  return backend;
}

/** Test seam: forgets the resolved backend so env changes take effect. */
export function resetLibraryBackend() {
  backend = null;
  facetsCache = null;
}

// --- filtering -------------------------------------------------------------

const matchesText = (record, needle) => {
  const haystack = [
    record.product?.name,
    record.product?.brand,
    record.product?.description,
    record.product?.colour,
    record.product?.id,
    record.unitLabel,
    record.styleLabel,
    record.model,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return haystack.includes(needle);
};

/** `true` / `1` → approved only; `false` / `0` → unreviewed only; else no filter. */
const parseApproved = (value) =>
  value === 'true' || value === '1' ? true : value === 'false' || value === '0' ? false : undefined;

/**
 * One predicate holding every filter the request named. Runs server-side over
 * the record walk, so a page sent to the browser is already the answer.
 */
const buildFilter = (params) => {
  const category = params.get('category');
  const brand = params.get('brand');
  const product = params.get('product');
  const styleId = params.get('style');
  const provider = params.get('provider');
  const approved = parseApproved(params.get('approved'));
  const unit = params.get('unit'); // "Product 12" / "Outfit 3"
  const source = params.get('source');
  const kind = params.get('kind');
  const from = params.get('from'); // YYYY-MM-DD, inclusive
  const to = params.get('to');
  const q = params.get('q')?.trim().toLowerCase();

  return (record) => {
    if (category && record.product?.category !== category) return false;
    if (brand && record.product?.brand !== brand) return false;
    if (product && record.product?.name !== product) return false;
    if (unit && record.unitLabel !== unit) return false;
    if (source && record.source !== source) return false;
    if (kind && record.kind !== kind) return false;
    if (styleId && record.styleId !== styleId) return false;
    if (provider && record.provider !== provider) return false;
    // Records stored before the flag existed carry none: they count as unreviewed.
    if (approved !== undefined && !!record.approved !== approved) return false;
    if (from && record.createdAt.slice(0, 10) < from) return false;
    if (to && record.createdAt.slice(0, 10) > to) return false;
    if (q && !matchesText(record, q)) return false;
    return true;
  };
};

const hasFilters = (params) =>
  ['category', 'brand', 'product', 'unit', 'source', 'kind', 'style', 'provider', 'approved', 'from', 'to', 'q'].some((k) =>
    params.get(k)
  );

// --- facets ----------------------------------------------------------------

let facetsCache = null;

const countInto = (map, value, label) => {
  if (!value) return;
  const entry = map.get(value) || { value, label: label || value, count: 0 };
  entry.count += 1;
  map.set(value, entry);
};

async function computeFacets(store) {
  if (facetsCache && Date.now() - facetsCache.at < FACET_TTL_MS) return facetsCache.data;

  const records = await store.recent(FACET_SCAN);
  const categories = new Map();
  const brands = new Map();
  const products = new Map();
  const styles = new Map();
  const providers = new Map();
  const units = new Map();
  const sources = new Map();
  let approved = 0;

  for (const record of records) {
    if (record.approved) approved += 1;
    if (record.unitLabel) {
      const entry = units.get(record.unitLabel) || {
        value: record.unitLabel,
        label:
          record.kind === 'product' && record.product?.name
            ? `${record.unitLabel} · ${record.product.name}`
            : record.unitLabel,
        count: 0,
        group: record.kind === 'outfit' ? 'Outfits' : 'Products',
        kind: record.kind,
        serial: record.serial,
      };
      entry.count += 1;
      units.set(record.unitLabel, entry);
    }
    countInto(sources, record.source, SOURCE_LABELS[record.source]);
    countInto(categories, record.product?.category);
    countInto(brands, record.product?.brand);
    countInto(products, record.product?.name);
    countInto(styles, record.styleId, record.styleLabel);
    countInto(providers, record.provider);
  }

  const sorted = (map) => [...map.values()].sort((a, b) => b.count - a.count);
  const data = {
    categories: sorted(categories),
    brands: sorted(brands),
    products: sorted(products),
    styles: sorted(styles),
    providers: sorted(providers),
    // Products first, then outfits, each in numbering order.
    units: [...units.values()]
      .sort((a, b) => (a.kind === b.kind ? a.serial - b.serial : a.kind === 'product' ? -1 : 1))
      .map(({ value, label, count, group }) => ({ value, label, count, group })),
    sources: sorted(sources),
    approved,
    sampled: records.length,
  };
  facetsCache = { at: Date.now(), data };
  return data;
}

// --- HTTP ------------------------------------------------------------------
// Connect-style handlers, deliberately free of express helpers: the SAME
// function is mounted by server.js in production and by the Vite dev server,
// so the Library cannot behave differently in the two.

const sendJson = (res, code, body) => {
  res.statusCode = code;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
};

const readBody = (req) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('Body too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });

const encodeCursor = (cursor) =>
  Buffer.from(JSON.stringify(cursor)).toString('base64url');

const decodeCursor = (value) => {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    return typeof parsed?.createdAt === 'string' && ID_RE.test(parsed?.id || '')
      ? { createdAt: parsed.createdAt, id: parsed.id }
      : null;
  } catch {
    return null;
  }
};

async function handleSave(req, res) {
  const store = await getBackend();

  let body;
  try {
    body = JSON.parse((await readBody(req)).toString('utf8'));
  } catch (err) {
    return sendJson(res, err?.status || 400, { error: 'Invalid JSON body' });
  }

  const id = body?.id;
  if (!ID_RE.test(id || '')) {
    return sendJson(res, 400, { error: 'id must match [A-Za-z0-9_-]{6,80}' });
  }

  const image = decodeDataUrl(body.image, MAX_IMAGE);
  if (!image) {
    return sendJson(res, 400, { error: 'image must be a png/jpeg/webp data URL within limits' });
  }
  const thumb = decodeDataUrl(body.thumb, MAX_EXTRA);
  const source = decodeDataUrl(body.source, MAX_EXTRA);

  const record = buildRecord(id, body.meta || {}, {
    mime: image.mime,
    hasThumb: !!thumb,
    hasSource: !!source,
  });

  const files = [{ kind: 'image', mime: image.mime, bytes: image.bytes }];
  if (thumb) files.push({ kind: 'thumb', mime: 'image/jpeg', bytes: thumb.bytes });
  if (source) files.push({ kind: 'source', mime: 'image/jpeg', bytes: source.bytes });

  try {
    if (record.unitKey && record.kind) {
      record.serial = await store.allocateSerial(record.unitKey, record.kind);
      record.unitLabel = unitLabelOf(record.kind, record.serial);
    }
    const stored = await store.save(record, files);
    facetsCache = null;
    sendJson(res, 200, { record: stored });
  } catch (err) {
    // Explicit by requirement: a failure here must never be mistaken for a
    // permanent save. The render already happened; only the Library missed it.
    console.error('library save failed:', err.message);
    sendJson(res, 502, { error: `The image was generated but could not be saved to the Library: ${err.message}` });
  }
}

async function handleList(req, res, params) {
  const store = await getBackend();
  const limit = Math.min(
    Math.max(parseInt(params.get('limit') || '', 10) || PAGE_LIMIT_DEFAULT, 1),
    PAGE_LIMIT_MAX
  );
  const sort = params.get('sort') === 'oldest' ? 'oldest' : 'newest';
  const cursor = decodeCursor(params.get('cursor'));

  try {
    const { items, nextCursor } = await store.list({
      sort,
      cursor,
      limit,
      filter: buildFilter(params),
    });
    const total = hasFilters(params) ? null : await store.total();
    sendJson(res, 200, {
      items,
      nextCursor: nextCursor ? encodeCursor(nextCursor) : null,
      total,
    });
  } catch (err) {
    console.error('library list failed:', err.message);
    sendJson(res, 502, { error: `Could not read the Library: ${err.message}` });
  }
}

async function handleFacets(res) {
  const store = await getBackend();
  try {
    sendJson(res, 200, await computeFacets(store));
  } catch (err) {
    console.error('library facets failed:', err.message);
    sendJson(res, 502, { error: `Could not read the Library: ${err.message}` });
  }
}

async function handleImage(res, id, kind) {
  const store = await getBackend();
  try {
    const record = await store.get(id);
    if (!record) return sendJson(res, 404, { error: 'No such generation' });
    if (kind === 'thumb' && !record.hasThumb) kind = 'image';
    if (kind === 'source' && !record.hasSource) return sendJson(res, 404, { error: 'No source image' });
    await store.stream(record, kind, res);
  } catch (err) {
    console.error('library image failed:', err.message);
    if (!res.headersSent) sendJson(res, 404, { error: 'Image not available' });
    else res.destroy();
  }
}

async function handleDelete(res, id) {
  const store = await getBackend();
  try {
    const record = await store.get(id);
    if (!record) return sendJson(res, 404, { error: 'No such generation' });
    await store.remove(id);
    facetsCache = null;
    sendJson(res, 200, { deleted: id });
  } catch (err) {
    console.error('library delete failed:', err.message);
    sendJson(res, 502, { error: `Could not delete: ${err.message}` });
  }
}

/** PATCH /:id — the reviewer's verdict on a stored render: `{ approved: boolean }`. */
async function handleApprove(req, res, id) {
  const store = await getBackend();

  let body;
  try {
    body = JSON.parse((await readBody(req)).toString('utf8'));
  } catch (err) {
    return sendJson(res, err?.status || 400, { error: 'Invalid JSON body' });
  }
  if (typeof body?.approved !== 'boolean') {
    return sendJson(res, 400, { error: 'approved must be true or false' });
  }

  try {
    const record = await store.get(id);
    if (!record) return sendJson(res, 404, { error: 'No such generation' });
    const updated = await store.update(id, { approved: body.approved });
    facetsCache = null;
    sendJson(res, 200, { record: updated });
  } catch (err) {
    console.error('library approve failed:', err.message);
    sendJson(res, 502, { error: `Could not update approval: ${err.message}` });
  }
}

/**
 * The one entry point. `req.url` is the path AFTER the /api/library mount —
 * both express `app.use(path, …)` and connect `middlewares.use(path, …)`
 * strip the prefix, which is what lets one handler serve both servers.
 */
export async function libraryHandler(req, res, next) {
  const url = new URL(req.url, 'http://library.invalid');
  const parts = url.pathname.split('/').filter(Boolean);

  try {
    if (parts.length === 0) {
      if (req.method === 'POST') return await handleSave(req, res);
      if (req.method === 'GET') return await handleList(req, res, url.searchParams);
    }
    if (parts[0] === 'facets' && parts.length === 1 && req.method === 'GET') {
      return await handleFacets(res);
    }
    if (parts[0] === 'image' && parts.length === 3 && req.method === 'GET') {
      const [, id, kind] = parts;
      if (ID_RE.test(id) && IMAGE_KINDS[kind]) return await handleImage(res, id, kind);
    }
    if (parts.length === 1 && req.method === 'DELETE' && ID_RE.test(parts[0])) {
      return await handleDelete(res, parts[0]);
    }
    if (parts.length === 1 && req.method === 'PATCH' && ID_RE.test(parts[0])) {
      return await handleApprove(req, res, parts[0]);
    }
  } catch (err) {
    console.error('library handler failed:', err);
    if (!res.headersSent) return sendJson(res, 500, { error: 'Library request failed' });
    return res.destroy();
  }

  if (next) return next();
  sendJson(res, 404, { error: 'Not found' });
}

export function mountLibraryRoutes(app) {
  app.use('/api/library', libraryHandler);
  if (BUCKET) {
    console.log(`library: Cloud Storage bucket '${BUCKET}' + Firestore '${COLLECTION}'`);
  } else {
    console.warn('LIBRARY_BUCKET not set — the Library is stored on the local filesystem, which does NOT survive a Cloud Run redeploy');
  }
}

/** The same routes under `npm run dev`, mirroring counterDevPlugin. */
export function libraryDevPlugin() {
  return {
    name: 'library-dev-routes',
    configureServer(server) {
      server.middlewares.use('/api/library', (req, res, next) => {
        void libraryHandler(req, res, next);
      });
    },
  };
}
