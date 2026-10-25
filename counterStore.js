import fs from 'fs';
import path from 'path';

// --- persistence -----------------------------------------------------------
// The tally has to outlive the instance: Cloud Run runs with min-instances=0,
// so the container is discarded whenever traffic pauses, and its filesystem
// with it. Setting COUNTER_BUCKET points the store at a single small JSON
// object in Cloud Storage, which survives idle periods and redeploys and costs
// nothing at this volume. Without that variable — `npm run dev` — it falls back
// to a flat file, the same shape the scheduler store uses.

const BUCKET = process.env.COUNTER_BUCKET;
const OBJECT = process.env.COUNTER_OBJECT || 'counter.json';

// Resolved from the working directory, not import.meta.url: Vite inlines this
// module into a bundled config in node_modules/.vite-temp, which would put the
// dev tally somewhere different from the one server.js keeps. npm run dev and
// the container both run from the project root, so cwd is the stable anchor.
const STORE = path.join(process.cwd(), 'data', 'counter.json');

// Reads are served from memory so polling browsers never touch Cloud Storage;
// the remote value is re-checked at most this often.
const SYNC_MS = 60_000;

let count = 0;
let generation = 0; // Cloud Storage object version we last read.
let lastSync = 0;
let remote = null;

const parseCount = (text) => {
  try {
    const { count: value } = JSON.parse(text);
    return Number.isFinite(value) && value > 0 ? value : 0;
  } catch {
    return 0;
  }
};

// --- local file mode -------------------------------------------------------

if (!BUCKET) {
  if (!fs.existsSync(path.dirname(STORE))) {
    fs.mkdirSync(path.dirname(STORE), { recursive: true });
  }
  try {
    count = parseCount(fs.readFileSync(STORE, 'utf8'));
  } catch {
    count = 0;
  }
}

function writeLocal(value) {
  // Write to a sibling first so a crash mid-write cannot truncate the tally.
  const tmp = `${STORE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ count: value }, null, 2));
  fs.renameSync(tmp, STORE);
}

// --- Cloud Storage mode ----------------------------------------------------

// Imported lazily so the dev server never loads the SDK, and so this module
// stays free of top-level await for Vite's config bundler.
async function getRemote() {
  if (!BUCKET) return null;
  if (!remote) {
    const { Storage } = await import('@google-cloud/storage');
    remote = new Storage().bucket(BUCKET).file(OBJECT);
  }
  return remote;
}

async function readRemote(file) {
  try {
    const [buf] = await file.download();
    const [meta] = await file.getMetadata();
    generation = Number(meta.generation) || 0;
    return parseCount(buf.toString());
  } catch (err) {
    if (err.code === 404) {
      generation = 0; // No object yet; the first write creates it.
      return 0;
    }
    throw err;
  }
}

/**
 * Read-modify-write guarded by the object's generation. If another instance
 * wrote in between, Cloud Storage rejects with 412 and we retry against the
 * value it stored — so concurrent renders never lose an increment.
 */
async function bumpRemote(file, by) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const next = (await readRemote(file)) + by;
    try {
      await file.save(JSON.stringify({ count: next }, null, 2), {
        contentType: 'application/json',
        preconditionOpts: { ifGenerationMatch: generation },
      });
      return next;
    } catch (err) {
      if (err.code !== 412) throw err;
    }
  }
  throw new Error('counter: too much contention writing to Cloud Storage');
}

// --- public API ------------------------------------------------------------

export async function getCount() {
  const file = await getRemote();
  if (file && Date.now() - lastSync > SYNC_MS) {
    lastSync = Date.now();
    try {
      count = await readRemote(file);
    } catch (err) {
      // Serve the cached value rather than failing the page.
      console.error('counter read failed:', err.message);
    }
  }
  return count;
}

export async function bumpCount(by = 1) {
  const file = await getRemote();

  if (file) {
    try {
      count = await bumpRemote(file, by);
      lastSync = Date.now();
    } catch (err) {
      // A dropped increment must not cost the caller their render.
      console.error('counter write failed:', err.message);
      count += by;
    }
    return count;
  }

  count += by;
  try {
    writeLocal(count);
  } catch (err) {
    console.error('counter persist failed:', err.message);
  }
  return count;
}

// Both the Express server and the Vite dev server mount these, so the counter
// behaves identically in dev and production.
//
// `store` decides where the tally lives. It defaults to this module's own file
// or Cloud Storage backing; production passes the off-site counter instead.
// A store that sets `countsServerSide` is already incremented by the server at
// the moment an image comes back, so the browser's hit must only read — double
// counting a billable number is worse than a slightly late badge.
export function mountCounterRoutes(app, store = { getCount, bumpCount }) {
  app.get('/api/stats', async (_req, res) => res.json({ count: await store.getCount() }));

  app.post('/api/stats/hit', async (_req, res) => {
    const count = store.countsServerSide ? await store.getCount() : await store.bumpCount();
    res.json({ count });
  });
}

// Vite has no Express app, so the dev server gets the same two routes as a
// plugin. Without this the counter would 404 under `npm run dev`.
export function counterDevPlugin() {
  return {
    name: 'counter-dev-routes',
    configureServer(server) {
      server.middlewares.use('/api/stats', (req, res, next) => {
        const send = async (read) => {
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ count: await read() }));
        };

        if (req.method === 'GET' && (req.url === '/' || req.url === '')) {
          return void send(getCount);
        }
        if (req.method === 'POST' && req.url === '/hit') {
          return void send(bumpCount);
        }
        next();
      });
    },
  };
}
