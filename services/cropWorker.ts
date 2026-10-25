/**
 * THE CROP, OFF THE MAIN THREAD.
 *
 * `isolateSubject` decodes a full-size photograph onto a canvas and walks
 * every pixel of a scan copy twice — once for the background estimate, once
 * for the subject search. That is cheap per photograph and expensive summed
 * across a folder, and it used to run on the same thread as the page, so a
 * hundred-photograph folder made the tab visibly stutter while it happened.
 *
 * This file is that same work, unmodified, run inside a module worker
 * instead. `isolateFolderParallel` in `isolateSubject.ts` spins up a small
 * pool of these and feeds them photographs by index (`seq`), so the crop for
 * photograph 40 can finish before the crop for photograph 12 without either
 * losing track of where its result belongs.
 */

import { isolateSubject } from './isolateSubject';

self.onmessage = async (event: MessageEvent) => {
  const { photo, maxEdge, seq } = event.data;
  let cropped: string | null = null;
  try {
    cropped = await isolateSubject(photo, maxEdge);
  } catch {
    /* refuse rather than guess: null means use the original */
  }
  (self as any).postMessage({ seq, cropped });
};
