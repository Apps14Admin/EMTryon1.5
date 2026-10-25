/**
 * A REAL IMAGE EMBEDDING, COMPUTED LOCALLY.
 *
 * `imageSignature.ts` gives every photograph a 64-bit difference hash and a
 * 4x4x4 colour histogram. Those answer "is this the same shot twice", which is
 * what they were written for and what they are kept for. They cannot answer
 * "is this the same object from another side", and no amount of work on them
 * will: a difference hash compares FRAMING, and the whole difficulty here is
 * that two photographs of one shoe share no framing at all.
 *
 * SigLIP was trained on the question this system needs. Its vectors put a
 * shoe's profile near that shoe's underside because both are that shoe, not
 * because their pixels line up. That is the property the recall stage depends
 * on, and it is not one a hand-written descriptor can be tuned into having.
 *
 * IT RUNS ON THE USER'S MACHINE. No request, no key, no quota, no per-photo
 * cost, and the photographs never leave the browser for this stage. The model
 * is fetched once and cached by the browser.
 *
 * The WASM fallback is SEVERAL TIMES SLOWER than WebGPU, and on a large folder
 * that difference is the difference between a pause and a wait. Which one is in
 * use is reported in the run log rather than hidden, because a slow folder with
 * no explanation reads as a broken one.
 *
 * EVERYTHING HERE DEGRADES TO `null`. No WebGPU, no WASM, an offline machine, a
 * blocked CDN, a test environment with no DOM: the loader gives up, the caller
 * falls back to `imageSignature`'s distances for recall, and the run continues
 * with somewhat worse neighbourhoods. It never fails the folder, because the
 * embedding decides nothing on its own — it only decides what gets LOOKED at,
 * and the model is still the thing that judges.
 */

/**
 * The checkpoint.
 *
 * SigLIP base rather than large: about a quarter the download for a difference
 * that does not show up in neighbour lists of nine. Quantised to 8 bits, which
 * takes the download to roughly 100MB and costs nothing measurable here —
 * quantisation blurs fine distinctions between vectors, and fine distinctions
 * are exactly what this stage is NOT allowed to decide.
 */
export const EMBEDDING_MODEL = 'Xenova/siglip-base-patch16-224';

/** How many photographs are embedded at once. */
export const EMBED_BATCH = 8;

/**
 * Longest the loader will wait WITHOUT the download advancing.
 *
 * A stall watchdog rather than a total time limit, and the difference matters.
 * The checkpoint is around a hundred megabytes and the ONNX runtime another
 * twenty; on a slow connection that is legitimately minutes, and a total budget
 * would abandon a download that was working perfectly well. What is never
 * legitimate is the byte count not moving — a blocked CDN, a dead socket, a
 * proxy swallowing the request — and that is what this catches.
 *
 * Without it a folder can wait forever on a fetch that will never complete,
 * which is exactly what it looks like from the outside: a full progress bar and
 * nothing happening.
 */
export const DOWNLOAD_STALL_MS = 45_000;

export interface EmbedderStatus {
  ready: boolean;
  /** 'webgpu' or 'wasm', once something has loaded. */
  backend?: string;
  /** Why it is unavailable, when it is. Shown in the run log, never thrown. */
  reason?: string;
}

/** How far the one-time model download has got. */
export interface DownloadProgress {
  loaded: number;
  total: number;
  /** 0..1, or undefined until at least one file has reported a size. */
  ratio?: number;
}

let extractor: any = null;
let loading: Promise<any> | null = null;
let status: EmbedderStatus = { ready: false };

export const embedderStatus = (): EmbedderStatus => status;

/** Forgets the loaded model. Tests, and the "start over" path in the UI. */
export const resetEmbedder = (): void => {
  extractor = null;
  loading = null;
  status = { ready: false };
};

/**
 * Loads the model once, and remembers a failure as a failure.
 *
 * A second caller during the load waits on the same promise rather than
 * starting a second download, and a load that has already failed is not
 * retried — a machine without WebGPU will not grow one during a folder, and
 * retrying turns one slow failure into one per batch.
 */
const load = async (
  onDownload?: (progress: DownloadProgress) => void
): Promise<any> => {
  if (extractor) return extractor;
  if (loading) return loading;

  loading = (async () => {
    try {
      // Dynamic, and deliberately: this pulls in ONNX runtime and its WASM
      // binaries, which is a large amount of code that a user who never opens a
      // folder should not download. It is also what keeps this module
      // importable in tests, where the package need not resolve at all.
      const transformers: any = await import('@huggingface/transformers');
      const { pipeline } = transformers;

      // Bytes per file, so the total is a real total rather than the last
      // file's progress overwriting the one before it.
      const bytes = new Map<string, { loaded: number; total: number }>();

      const progress_callback = (event: any) => {
        if (!event?.file) return;
        if (event.status === 'progress' || event.status === 'done') {
          const total = Number(event.total) || 0;
          const loaded = event.status === 'done' ? total : Number(event.loaded) || 0;
          bytes.set(event.file, { loaded, total });
        }

        let loaded = 0;
        let total = 0;
        bytes.forEach((entry) => {
          loaded += entry.loaded;
          total += entry.total;
        });

        onDownload?.({ loaded, total, ratio: total ? loaded / total : undefined });
      };

      // The dtype is paired to the DEVICE, not chosen once.
      //
      // 8-bit weights are the right trade on WASM, where the bottleneck is
      // memory bandwidth on a CPU. On WebGPU they are the wrong one: the
      // integer paths are poorly served, and a q8 model there can run slower
      // than a 16-bit one while producing worse vectors. Half precision is what
      // the hardware is built for.
      const build = async (device?: string) =>
        pipeline('image-feature-extraction', EMBEDDING_MODEL, {
          dtype: device === 'webgpu' ? 'fp16' : 'q8',
          progress_callback,
          ...(device ? { device } : {}),
        });

      try {
        extractor = await build('webgpu');
        status = { ready: true, backend: 'webgpu' };
      } catch {
        // Not an error worth surfacing. Most machines land here, and the WASM
        // backend produces equivalent vectors, more slowly.
        extractor = await build();
        status = { ready: true, backend: 'wasm' };
      }

      return extractor;
    } catch (err) {
      status = {
        ready: false,
        reason: err instanceof Error ? err.message : 'the local image model could not be loaded',
      };
      return null;
    }
  })();

  return loading;
};

/**
 * The model, or `null` if the download stops advancing.
 *
 * The race is against a watchdog that is RESET by every progress event, so a
 * slow download is waited out and a dead one is abandoned. Losing the race does
 * not cancel the fetch — the browser carries on and caches it, so the next run
 * is likely to find it already there — it only stops this folder waiting.
 */
const loadOrGiveUp = async (
  onDownload?: (progress: DownloadProgress) => void
): Promise<any> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stalled: () => void = () => {};

  const watchdog = new Promise<null>((resolve) => {
    stalled = () => {
      clearTimeout(timer);
      timer = setTimeout(() => resolve(null), DOWNLOAD_STALL_MS);
    };
    stalled();
  });

  try {
    const model = await Promise.race([
      load((progress) => {
        stalled();
        onDownload?.(progress);
      }),
      watchdog,
    ]);

    if (!model) {
      status = {
        ready: false,
        reason:
          `the local image model stopped downloading for ` +
          `${Math.round(DOWNLOAD_STALL_MS / 1000)}s`,
      };
      // A stalled load must not be remembered as a loaded one, or every later
      // call returns the pending promise and waits on the same dead fetch.
      loading = null;
    }

    return model;
  } finally {
    clearTimeout(timer);
  }
};

/** True once a model is loaded and usable. Never throws, never retries a failure. */
export const embedderReady = async (): Promise<boolean> => !!(await load());

/** base64 JPEG bytes, as something the image pipeline will accept. */
const asImage = async (transformers: any, base64: string): Promise<any> => {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  const blob = new Blob([bytes], { type: 'image/jpeg' });
  return transformers.RawImage.fromBlob(blob);
};

/**
 * L2-normalises in place, so cosine similarity is a dot product and two
 * vectors from different batches are directly comparable.
 */
const normalise = (vector: Float32Array): Float32Array => {
  let norm = 0;
  for (let i = 0; i < vector.length; i += 1) norm += vector[i] * vector[i];
  norm = Math.sqrt(norm);
  if (!norm) return vector;
  for (let i = 0; i < vector.length; i += 1) vector[i] /= norm;
  return vector;
};

/**
 * Embeds a folder.
 *
 * Returns one vector per photograph, in order, with `null` wherever a
 * photograph could not be embedded — a corrupt frame, or no model at all. A
 * null is a photograph with no neighbours, which `planSheets` handles by giving
 * it a sheet of its own; it is never a photograph that is silently dropped.
 *
 * `onProgress` is called as batches land, because on the WASM backend this is
 * the longest silent stretch in the run and a progress bar that does not move
 * reads as a hang.
 */
export const embedFolder = async (
  photos: string[],
  onProgress?: (done: number, total: number) => void,
  shouldStop?: () => boolean,
  /**
   * Called while the one-time model download is in flight.
   *
   * Not optional in spirit, whatever the type says. This download is the
   * longest single wait in a first run — a hundred-odd megabytes before a
   * single photograph is looked at — and reporting nothing during it is
   * indistinguishable from a hang. It is what a full progress bar sitting at
   * "110 of 110" with nothing happening actually was.
   */
  onDownload?: (progress: DownloadProgress) => void
): Promise<(Float32Array | null)[]> => {
  const out: (Float32Array | null)[] = new Array(photos.length).fill(null);
  if (!photos.length) return out;

  const model = await loadOrGiveUp(onDownload);
  if (!model) return out;

  const transformers: any = await import('@huggingface/transformers');

  let done = 0;
  onProgress?.(0, photos.length);

  for (let start = 0; start < photos.length; start += EMBED_BATCH) {
    if (shouldStop?.()) break;

    const slice = photos.slice(start, start + EMBED_BATCH);

    // Decoded one batch at a time rather than all at once: a hundred and ten
    // decoded bitmaps at full size is a large amount of memory to hold for no
    // reason, and the pipeline consumes them immediately.
    const images = await Promise.all(
      slice.map(async (photo) => {
        try {
          return await asImage(transformers, photo);
        } catch {
          return null;
        }
      })
    );

    // ONE call for the whole batch.
    //
    // The first version of this looped and called the model once per
    // photograph, which meant `EMBED_BATCH` batched only the DECODING and the
    // inference ran one image at a time. That is the slowest possible way to
    // use either backend: every call pays the full fixed cost of entering the
    // runtime, setting up tensors and leaving again, and on WASM that overhead
    // is comparable to the work itself. Passing the batch as an array lets the
    // runtime do what it is built for.
    const usable = images
      .map((image, i) => ({ image, i }))
      .filter((entry): entry is { image: any; i: number } => !!entry.image);

    if (usable.length) {
      try {
        const result = await model(
          usable.map((entry) => entry.image),
          { pooling: 'mean', normalize: true }
        );

        // A batched call answers with one tensor holding every vector end to
        // end, so it is sliced by width rather than indexed.
        const flat: ArrayLike<number> | undefined = result?.data;
        const width = flat ? Math.floor(flat.length / usable.length) : 0;

        usable.forEach((entry, position) => {
          if (flat && width) {
            const from = position * width;
            const vector = new Float32Array(width);
            for (let d = 0; d < width; d += 1) vector[d] = flat[from + d];
            out[start + entry.i] = normalise(vector);
            return;
          }
          // Some builds answer with one tensor per image instead.
          const single = result?.[position]?.data;
          if (single) {
            out[start + entry.i] = normalise(Float32Array.from(single as ArrayLike<number>));
          }
        });
      } catch {
        /* a batch that would not embed is a batch of photographs with no
           neighbours, not a failed folder */
      }
    }

    // Decoded frames are released as soon as the batch is through them.
    images.forEach((image) => (image as any)?.close?.());

    done += slice.length;
    onProgress?.(done, photos.length);
  }

  return out;
};
