import React, { useCallback, useRef, useState } from 'react';
import { FolderOpen, Loader2, AlertTriangle } from 'lucide-react';
import {
  MAX_EDGE,
  SCOUT_EDGE,
  prepareImageSizes,
  mapWithConcurrency,
} from '../services/imageUtils';
import { FolderImage, MAX_FOLDER_IMAGES } from '../services/productGrouper';
import { useT } from '../services/uiPrefs';

interface FolderInputProps {
  /** Called once the whole folder has been read and downscaled. */
  onLoaded: (images: FolderImage[]) => void;
  disabled?: boolean;
}

/** `webkitdirectory` is not in React's typings, so the attribute is set by hand. */
const directoryProps = {
  webkitdirectory: '',
  directory: '',
} as unknown as React.InputHTMLAttributes<HTMLInputElement>;

const isImage = (file: File) => file.type.startsWith('image/');

/**
 * A file together with where it sat in the uploaded folder. The path is what
 * decides which product a photo belongs to — one subfolder per product — so it
 * travels with the file from here to `FolderImage.path`.
 */
interface PickedFile {
  file: File;
  /** Relative to the upload, forward-slashed: `"shoot/red-runner/front.jpg"`. */
  path: string;
}

const cleanPath = (raw: string | undefined, fallback: string): string => {
  const path = (raw ?? '').replace(/\\/g, '/').replace(/^\/+/, '');
  return path || fallback;
};

/** The file picker reports each file's place in the chosen folder itself. */
const fromPicker = (file: File): PickedFile => ({
  file,
  path: cleanPath((file as any).webkitRelativePath, file.name),
});

/**
 * Walks a dropped folder. The DataTransferItem entry API is the only way to
 * read a directory from a drop — `dataTransfer.files` on a folder drop is
 * empty, which is why a drop needs its own path rather than reusing the file
 * input's handler.
 */
const filesFromEntry = async (entry: any): Promise<PickedFile[]> => {
  if (!entry) return [];

  if (entry.isFile) {
    const file = await new Promise<File | null>((resolve) =>
      entry.file((f: File) => resolve(f), () => resolve(null))
    );
    // `fullPath` is where the entry sits under the drop: `/root/sub/file.jpg`.
    return file && isImage(file) ? [{ file, path: cleanPath(entry.fullPath, file.name) }] : [];
  }

  if (entry.isDirectory) {
    const reader = entry.createReader();
    const collected: PickedFile[] = [];

    // readEntries returns at most 100 entries per call and signals the end
    // with an empty batch, so it has to be drained in a loop.
    for (;;) {
      const batch: any[] = await new Promise((resolve) =>
        reader.readEntries((entries: any[]) => resolve(entries), () => resolve([]))
      );
      if (!batch.length) break;
      for (const child of batch) collected.push(...(await filesFromEntry(child)));
    }

    return collected;
  }

  return [];
};

/**
 * Takes a whole folder of mixed product photos in one go, as the alternative to
 * filling each item's slots by hand. Every photo is kept twice: full size for
 * the render, and a small copy for sorting and for the review grid.
 */
export const FolderInput: React.FC<FolderInputProps> = ({ onLoaded, disabled = false }) => {
  const t = useT();
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [error, setError] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  const ingest = useCallback(
    async (files: PickedFile[]) => {
      setError(null);
      const photos = files.filter(({ file }) => isImage(file));

      if (!photos.length) {
        setError(t('That folder has no images in it.'));
        return;
      }

      if (photos.length > MAX_FOLDER_IMAGES) {
        setError(
          `${photos.length} images — the limit is ${MAX_FOLDER_IMAGES} per folder. Split it and upload in two goes.`
        );
        return;
      }

      setBusy(true);
      setProgress({ done: 0, total: photos.length });

      try {
        const batchId = Date.now();

        // Both copies come out of ONE read and ONE decode of each file, and
        // several files are prepared at once. Doing it a photo at a time, with
        // the full size and the thumbnail prepared independently, made a
        // hundred-photo folder take minutes before a single request was sent.
        const prepared = await mapWithConcurrency(
          photos,
          4,
          async ({ file, path }, i): Promise<FolderImage> => {
            // Two sizes, not three. Encoding is the expensive half of reading
            // a folder and it blocks the page while it runs, so a copy nobody
            // looks at costs a hundred photos' worth of frozen UI. The 512px
            // copy is what the grouping sends AND what the review grid shows,
            // where tiles are a few dozen pixels wide.
            const [full, scout] = await prepareImageSizes(file, [MAX_EDGE, SCOUT_EDGE]);
            return {
              id: `img-${batchId}-${i}`,
              fileName: file.name,
              full: full.base64,
              thumb: scout.base64,
              scout: scout.base64,
              path,
            };
          },
          (done) => setProgress({ done, total: photos.length })
        );

        onLoaded(prepared);
      } catch (err: any) {
        setError(err?.message || t('Could not read that folder.'));
      } finally {
        setBusy(false);
      }
    },
    [onLoaded]
  );

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []).map(fromPicker);
    // Reset first, so picking the same folder twice in a row still fires.
    e.target.value = '';
    ingest(files);
  };

  const handleDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragging(false);
      if (disabled || busy) return;

      const items = Array.from(e.dataTransfer.items ?? []);
      const entries = items
        .map((item) => (item as any).webkitGetAsEntry?.())
        .filter(Boolean);

      if (entries.length) {
        const nested = await Promise.all(entries.map(filesFromEntry));
        ingest(nested.flat());
        return;
      }

      ingest(Array.from(e.dataTransfer.files ?? []).map(fromPicker));
    },
    [busy, disabled, ingest]
  );

  const pct = progress.total ? Math.round((progress.done / progress.total) * 100) : 0;

  return (
    <div className="w-full">
      <div
        onDrop={handleDrop}
        onDragOver={(e) => {
          e.preventDefault();
          if (!disabled && !busy) setIsDragging(true);
        }}
        onDragLeave={(e) => {
          e.preventDefault();
          setIsDragging(false);
        }}
        onClick={() => !disabled && !busy && inputRef.current?.click()}
        className={`relative w-full overflow-hidden border-2 border-dashed rounded-2xl p-4 text-center transition-all duration-300
          ${disabled ? 'opacity-50 cursor-not-allowed border-gray-300 bg-gray-50' : 'cursor-pointer'}
          ${isDragging
            ? 'border-yellow-500 bg-yellow-100/70 ring-4 ring-yellow-400/30'
            : !disabled
              ? 'border-yellow-400/70 bg-gradient-to-br from-yellow-50 via-white to-amber-50 hover:border-yellow-500 hover:shadow-lg hover:shadow-yellow-500/20'
              : ''}
        `}
      >
        <input
          ref={inputRef}
          type="file"
          multiple
          accept="image/*"
          className="sr-only"
          onChange={handleChange}
          {...directoryProps}
        />

        <div className="flex flex-col items-center gap-1.5">
          <div className="h-10 w-10 flex items-center justify-center rounded-xl bg-gradient-to-br from-yellow-300 to-amber-500 shadow-md shadow-yellow-500/40 border border-yellow-300 text-gray-900">
            {busy ? <Loader2 className="w-5 h-5 animate-spin" /> : <FolderOpen className="w-5 h-5" />}
          </div>

          <p className="text-xs sm:text-sm font-semibold text-gray-800">
            {busy ? t('Reading folder… {done}/{total}', { done: progress.done, total: progress.total }) : t('Upload a product folder')}
          </p>
          <p className="text-[10px] text-gray-500 leading-tight max-w-[260px]">
            {busy
              ? t('Downscaling each photo for the render and for naming its view.')
              : t("One subfolder per product, each holding that product's angle photos. Up to {max} images.", { max: MAX_FOLDER_IMAGES })}
          </p>

          {busy && (
            <div className="w-full max-w-[220px] h-1.5 bg-yellow-100 rounded-full overflow-hidden mt-1">
              <div
                className="h-full bg-gradient-to-r from-yellow-400 to-amber-500 transition-all duration-200"
                style={{ width: `${pct}%` }}
              />
            </div>
          )}
        </div>
      </div>

      {error && (
        <div className="mt-2 flex items-start gap-1.5 text-[11px] text-red-700 bg-red-50 border border-red-200 rounded-lg px-2.5 py-1.5">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-px" />
          <span>{error}</span>
        </div>
      )}
    </div>
  );
};
