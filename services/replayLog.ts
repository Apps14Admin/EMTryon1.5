/**
 * THE REPLAY SEAM.
 *
 * One live run records every API response to a fixture; replaying it offline
 * is free and deterministic, so a change to the clusterer or scheduler is
 * measured against fixed model answers and any difference in output is
 * attributable to the change alone. It does not establish truth — it makes
 * every subsequent change measurable rather than anecdotal (spec section 15).
 */

import { AskFn } from './groupFolderV3';

export interface RecordedCall { schemaName: string; reply: string }

/** Wraps an AskFn; pushes every call/reply pair into `sink`. */
export const recordingAsk = (inner: AskFn, sink: RecordedCall[]): AskFn =>
  async (parts, schema, schemaName) => {
    const result = await inner(parts, schema, schemaName);
    sink.push({ schemaName, reply: result.text });
    return result;
  };

/** An AskFn that replays a recording; throws when the recording runs out. */
export const replayingAsk = (recording: RecordedCall[]): AskFn => {
  const queue = [...recording];
  return async (_parts, _schema, schemaName) => {
    const next = queue.find((call) => call.schemaName === schemaName);
    if (!next) throw new Error(`replay exhausted for ${schemaName}`);
    queue.splice(queue.indexOf(next), 1);
    return { text: next.reply, usage: null };
  };
};

/** Serialize a recording for saving to a JSON fixture file. */
export const dumpRecording = (calls: RecordedCall[]): string =>
  JSON.stringify(calls, null, 2);

/** Parse a recording loaded from a JSON fixture file. */
export const loadRecording = (json: string): RecordedCall[] => {
  const parsed = JSON.parse(json);
  if (!Array.isArray(parsed)) throw new Error('a recording is a JSON array');
  return parsed.map((entry) => ({
    schemaName: String(entry.schemaName),
    reply: String(entry.reply),
  }));
};
