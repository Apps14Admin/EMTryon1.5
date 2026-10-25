/**
 * Tally of every image this deployment has rendered, for all visitors.
 *
 * The count lives in a JSON file on the server (see counterStore.js), so every
 * browser sees the same number. The Firestore `usage` document is a different
 * thing: it counts render *runs* per signed-in user for quota purposes.
 */

const STATS_URL = '/api/stats';
const POLL_MS = 10_000;

type Listener = (count: number) => void;

const listeners = new Set<Listener>();

let count = 0;
let pollTimer: ReturnType<typeof setInterval> | null = null;

const publish = () => {
  listeners.forEach((listener) => listener(count));
};

const applyServerCount = (next: unknown) => {
  if (typeof next === 'number' && Number.isFinite(next) && next !== count) {
    count = next;
    publish();
  }
};

const refresh = async (): Promise<void> => {
  try {
    const res = await fetch(STATS_URL);
    if (!res.ok) return;
    const { count: serverCount } = await res.json();
    applyServerCount(serverCount);
  } catch {
    // Offline or the endpoint is missing — keep showing the last known total.
  }
};

export const getGeneratedCount = (): number => count;

export const incrementGeneratedCount = (by: number = 1): number => {
  // Bump locally first so the header reacts the moment the photo lands, then
  // let the server's authoritative total correct it.
  count += by;
  publish();

  void (async () => {
    try {
      for (let i = 0; i < by; i += 1) {
        const res = await fetch(`${STATS_URL}/hit`, { method: 'POST' });
        if (!res.ok) return;
        const { count: serverCount } = await res.json();
        applyServerCount(serverCount);
      }
    } catch {
      // The optimistic bump stands; the next poll reconciles it.
    }
  })();

  return count;
};

export const subscribeGeneratedCount = (listener: Listener): (() => void) => {
  listeners.add(listener);
  listener(count);

  // Poll only while something is actually on screen to receive the updates.
  if (!pollTimer) {
    void refresh();
    pollTimer = setInterval(() => void refresh(), POLL_MS);
  }

  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  };
};
