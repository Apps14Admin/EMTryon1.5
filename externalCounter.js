/**
 * Off-site tally of every image this app has ever generated.
 *
 * Deliberately outside our own stack. The in-container counter resets whenever
 * Cloud Run scales to zero, Firestore is not wired up in production, and the
 * Gemini key exposes no usage history — so none of them can answer "how many
 * images have we generated since the last top-up". This counter lives on a
 * third-party service and survives redeploys, container restarts, database
 * changes and switching AI providers.
 *
 * Backed by Abacus (https://abacus.jasoncameron.dev): plain GET endpoints, an
 * admin key for corrections, and a documented 30 req/10s limit — far above our
 * rate of one hit per generated image. The base URL is configurable, so
 * swapping providers is an env change rather than a code change.
 */

const BASE = (process.env.IMAGE_COUNTER_URL || 'https://abacus.jasoncameron.dev').replace(/\/$/, '');
const NAMESPACE = process.env.IMAGE_COUNTER_NAMESPACE;
const KEY = process.env.IMAGE_COUNTER_KEY;

const TIMEOUT_MS = Number(process.env.IMAGE_COUNTER_TIMEOUT_MS || 5000);
const MAX_ATTEMPTS = 3;

/** Reads are cached so a polling browser cannot spend our rate limit. */
const CACHE_MS = 30_000;

let cached = 0;
let cachedAt = 0;

// Increments are queued rather than fired in parallel: the service counts one
// hit per request, and a sequential drain keeps us well inside its rate limit
// even if several renders finish at once.
let pending = 0;
let draining = false;

export const isConfigured = () => Boolean(NAMESPACE && KEY);

/** Marks this store as counting on the server, so the browser must not re-count. */
export const countsServerSide = true;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function callCounter(action) {
  const res = await fetch(`${BASE}/${action}/${NAMESPACE}/${KEY}`, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { accept: 'application/json' },
  });

  // A counter that was never created reads as zero rather than as an error.
  if (res.status === 404) return 0;
  if (!res.ok) throw new Error(`counter ${action} failed: HTTP ${res.status}`);

  const body = await res.json();
  const value = Number(body?.value);
  if (!Number.isFinite(value)) throw new Error(`counter ${action} returned no value`);
  return value;
}

async function drain() {
  if (draining) return;
  draining = true;

  try {
    while (pending > 0) {
      let delivered = false;

      for (let attempt = 1; attempt <= MAX_ATTEMPTS && !delivered; attempt += 1) {
        try {
          cached = await callCounter('hit');
          cachedAt = Date.now();
          delivered = true;
        } catch (err) {
          if (attempt === MAX_ATTEMPTS) {
            // Losing a tick must never cost the user their render, but it is
            // worth shouting about — this is the number we bill against.
            console.error(`[imageCounter] DROPPED an increment after ${MAX_ATTEMPTS} attempts:`, err.message);
          } else {
            await sleep(attempt * 1000);
          }
        }
      }

      pending -= 1;
    }
  } finally {
    draining = false;
  }
}

/**
 * Records `by` generated images. Returns immediately: the caller is serving a
 * render and must not wait on, or fail because of, the tally.
 */
export function bumpCount(by = 1) {
  if (!isConfigured() || by < 1) return cached;

  pending += by;
  cached += by; // Optimistic, so an immediate read reflects the render.
  void drain();
  return cached;
}

export async function getCount() {
  if (!isConfigured()) return cached;

  if (Date.now() - cachedAt > CACHE_MS && pending === 0) {
    try {
      cached = await callCounter('get');
      cachedAt = Date.now();
    } catch (err) {
      // Serve the last known total rather than failing the page.
      console.error('[imageCounter] read failed:', err.message);
    }
  }

  return cached;
}
