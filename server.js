import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  accountInfo,
  publishingLimit,
  saveMedia,
  schedulePost,
  listPosts,
  cancelPost,
  runDuePosts,
  publishImage,
  MEDIA_DIR,
} from './instagram.js';
import { mountCounterRoutes } from './counterStore.js';
import { mountLibraryRoutes } from './libraryStore.js';
import * as imageCounter from './externalCounter.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = process.env.PORT || 8080;
const API_KEY = process.env.GEMINI_API_KEY;
const UPSTREAM = process.env.GEMINI_UPSTREAM || 'https://generativelanguage.googleapis.com';

// Optional second image provider. Unset simply means the OpenAI option in the
// UI reports itself unavailable — Gemini, and the rest of the app, are
// unaffected, so this key is deliberately not a startup requirement.
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_UPSTREAM = process.env.OPENAI_UPSTREAM || 'https://api.openai.com';

// Markers of a response that actually carries a rendered image. Matched against
// the raw bytes so a multi-megabyte body is never turned into a string.
const INLINE_DATA = Buffer.from('"inlineData"');
const IMAGE_MIME = Buffer.from('image/');

/** The field OpenAI returns a rendered image in. Same idea, different provider. */
const OPENAI_IMAGE_FIELD = Buffer.from('"b64_json"');

/**
 * True only when Gemini returned image bytes.
 *
 * Counting requests rather than pictures would be wrong even with one request
 * per render: the angle classifier and the folder grouper call a Gemini image
 * id and get text back. Only a response containing inline image data is a
 * generated image.
 */
function carriesGeneratedImage(url, contentType, body) {
  if (!url.includes(':generateContent')) return false;
  if (!contentType || !contentType.includes('json')) return false;
  return body.includes(INLINE_DATA) && body.includes(IMAGE_MIME);
}

/**
 * The Gemini models this proxy is CONFIGURED to serve.
 *
 * The same configuration the client holds in `services/aiModels.ts`, restated
 * here because this is a separate process: the browser bundle and this server
 * are deployed independently, and a stale cached bundle would otherwise be
 * able to address a model this deployment is not configured for. A request
 * naming anything else is answered here rather than forwarded, so it costs
 * nothing.
 *
 * The same short list of configured models, restated at the boundary. Keep it
 * identical to GEMINI_MODEL_IDS in services/aiModels.ts.
 */
const GEMINI_MODELS = new Set([
  'gemini-3.1-flash-lite-image',
  'gemini-3.1-flash-image',
  'gemini-3-pro-image',
]);

/**
 * The model id a Gemini request is addressed to, or null when the path names
 * no model (a batch poll, for instance).
 *
 * Paths look like `/v1beta/models/<id>:generateContent`.
 */
function modelIdOf(url) {
  const match = /\/models\/([^:/?]+)/.exec(url);
  return match ? decodeURIComponent(match[1]) : null;
}

/**
 * Model discovery, which this application does not do.
 *
 * `GET /v1beta/models` lists every id the key can reach. Model ids here come
 * from configuration, never from the API, so nothing calls this — and the
 * proxy does not serve it, which keeps that true.
 */
function isModelDiscovery(url, method) {
  return method === 'GET' && /\/models\/?(\?|$)/.test(url);
}

if (!API_KEY) {
  console.error('FATAL: GEMINI_API_KEY is not set');
  process.exit(1);
}

const app = express();
app.disable('x-powered-by');

// Health check for Cloud Run
app.get('/healthz', (_req, res) => res.status(200).send('ok'));

// Photos-generated tally. When the off-site counter is configured it is the
// source of truth — it outlives this container, redeploys and the Gemini key.
// Otherwise the local file store keeps `npm run dev` working unchanged.
if (imageCounter.isConfigured()) {
  mountCounterRoutes(app, imageCounter);
  console.log('image counter: off-site store active');
} else {
  mountCounterRoutes(app);
  console.warn('IMAGE_COUNTER_NAMESPACE/KEY not set — using the local, non-persistent counter');
}

// Generation Library. Image bytes go to Cloud Storage and records to
// Firestore (LIBRARY_BUCKET set), reached through the service account this
// container runs as — no credential ships with the code or the bundle.
mountLibraryRoutes(app);

// Gemini proxy. The browser SDK points its baseUrl here; we attach the real
// API key server-side so it never reaches the client bundle.
app.use('/api/gemini', express.raw({ type: '*/*', limit: '64mb' }), async (req, res) => {
  // req.url is the path after the /api/gemini mount point.

  if (isModelDiscovery(req.url, req.method)) {
    console.warn(`model discovery is not served: ${req.method} ${req.url}`);
    return res.status(403).json({
      error: {
        code: 403,
        message:
          'This application takes its model ids from configuration and does not discover them. Model listing is not served.',
      },
    });
  }

  const requestedModel = modelIdOf(req.url);
  if (requestedModel && !GEMINI_MODELS.has(requestedModel)) {
    console.warn(`model outside this deployment's configuration: ${requestedModel}`);
    return res.status(400).json({
      error: {
        code: 400,
        message:
          `'${requestedModel}' is not part of this deployment's Gemini configuration. ` +
          `The configured models are ${[...GEMINI_MODELS].join(', ')}. ` +
          `The request was not forwarded and was not billed.`,
      },
    });
  }

  const url = new URL(UPSTREAM + req.url);
  url.searchParams.set('key', API_KEY);

  const headers = {};
  if (req.get('content-type')) headers['content-type'] = req.get('content-type');

  try {
    const upstream = await fetch(url, {
      method: req.method,
      headers,
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : req.body,
    });

    res.status(upstream.status);
    const ct = upstream.headers.get('content-type');
    if (ct) res.set('content-type', ct);

    const buf = Buffer.from(await upstream.arrayBuffer());
    res.send(buf);

    // Counted here, after the bytes are on their way back, so the tally can
    // never delay or break a render. Server-side by design: the browser cannot
    // skip it, spoof it, or lose it to a closed tab.
    if (upstream.ok && carriesGeneratedImage(req.url, ct, buf)) {
      imageCounter.bumpCount(1);
    }
  } catch (err) {
    console.error('proxy error:', err);
    res.status(502).json({ error: { code: 502, message: 'Upstream request failed' } });
  }
});

// --- OpenAI image proxy ---------------------------------------------------
// Same contract as the Gemini proxy above: the browser posts here, the key is
// attached server-side, and the client bundle never contains it. Kept separate
// rather than generalised because the two providers authenticate differently —
// Gemini by query string, OpenAI by Authorization header.

// Lets the UI grey out the OpenAI option instead of offering a render that can
// only fail with a 503.
app.get('/api/openai/status', (_req, res) =>
  res.json({ configured: Boolean(OPENAI_API_KEY) })
);

app.use('/api/openai', express.raw({ type: '*/*', limit: '64mb' }), async (req, res) => {
  if (!OPENAI_API_KEY) {
    return res.status(503).json({
      error: {
        message:
          'OPENAI_API_KEY is not set on the server. Add it to .env and restart to enable the OpenAI model.',
      },
    });
  }

  // The OpenAI side is configured with one model per capability — analysis and
  // generation — and the client sends no other, so there is nothing to check
  // by id here. Model listing is not served, for the same reason as on the
  // Gemini side: ids come from configuration, not from the API.
  if (req.method === 'GET' && /^\/v1\/models\/?(\?|$)/.test(req.url)) {
    return res.status(403).json({
      error: {
        message:
          'This application takes its model ids from configuration and does not discover them. Model listing is not served.',
      },
    });
  }

  const headers = { authorization: `Bearer ${OPENAI_API_KEY}` };
  // The multipart boundary lives in this header, so forwarding the body without
  // it produces an unparseable request upstream.
  if (req.get('content-type')) headers['content-type'] = req.get('content-type');

  try {
    const upstream = await fetch(OPENAI_UPSTREAM + req.url, {
      method: req.method,
      headers,
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : req.body,
    });

    res.status(upstream.status);
    const ct = upstream.headers.get('content-type');
    if (ct) res.set('content-type', ct);

    const buf = Buffer.from(await upstream.arrayBuffer());
    res.send(buf);

    // Same tally as the Gemini path, on the same rule: count pictures, not
    // requests. OpenAI returns the image as `b64_json`, so that field is what
    // marks a response that actually carries one.
    if (upstream.ok && req.url.includes('/images/') && buf.includes(OPENAI_IMAGE_FIELD)) {
      imageCounter.bumpCount(1);
    }
  } catch (err) {
    console.error('openai proxy error:', err);
    res.status(502).json({ error: { message: 'Upstream request failed' } });
  }
});

if (!OPENAI_API_KEY) {
  console.warn('OPENAI_API_KEY not set — the OpenAI model option is disabled');
}

// --- Instagram scheduling -------------------------------------------------
// Instagram fetches images by URL, so generated media is served publicly here.
app.use('/media', express.static(MEDIA_DIR));

app.use('/api/instagram', express.json({ limit: '64mb' }));

app.get('/api/instagram/account', async (_req, res) => {
  try {
    const [account, limit] = await Promise.all([accountInfo(), publishingLimit()]);
    res.json({ account, quota: limit.data?.[0] ?? null });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/instagram/posts', (_req, res) => res.json({ posts: listPosts() }));

// Accepts a base64 image (as returned by the try-on generator) plus a caption
// and an ISO timestamp. Publishes immediately if publishAt is past/omitted.
app.post('/api/instagram/schedule', async (req, res) => {
  const { imageBase64, caption, publishAt } = req.body || {};
  if (!imageBase64) return res.status(400).json({ error: 'imageBase64 is required' });

  try {
    const imagePath = saveMedia(imageBase64);
    const when = publishAt || new Date().toISOString();
    const post = schedulePost({ imagePath, caption, publishAt: when });
    res.json({ post });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/instagram/publish-now', async (req, res) => {
  const { imageBase64, caption } = req.body || {};
  if (!imageBase64) return res.status(400).json({ error: 'imageBase64 is required' });

  const base = process.env.PUBLIC_BASE_URL;
  if (!base) return res.status(500).json({ error: 'PUBLIC_BASE_URL is not set' });

  try {
    const imagePath = saveMedia(imageBase64);
    const result = await publishImage(base + imagePath, caption || '');
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message, detail: err.igDetail });
  }
});

app.post('/api/instagram/cancel/:id', (req, res) => {
  const post = cancelPost(req.params.id);
  if (!post) return res.status(404).json({ error: 'not found' });
  res.json({ post });
});

// Scheduler tick. PUBLIC_BASE_URL must be reachable by Instagram's servers.
const TICK_MS = Number(process.env.SCHEDULER_INTERVAL_MS || 60_000);
if (process.env.PUBLIC_BASE_URL) {
  setInterval(() => {
    runDuePosts(process.env.PUBLIC_BASE_URL).catch((e) =>
      console.error('[scheduler]', e.message)
    );
  }, TICK_MS);
  console.log(`scheduler running every ${TICK_MS}ms -> ${process.env.PUBLIC_BASE_URL}`);
} else {
  console.warn('PUBLIC_BASE_URL not set — scheduler disabled');
}

// Static built app
app.use(express.static(path.join(__dirname, 'dist'), { index: false }));

// SPA fallback — any unmatched route serves the app shell.
app.use((_req, res) => {
  res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

app.listen(PORT, () => console.log(`listening on ${PORT}`));
