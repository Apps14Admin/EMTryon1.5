import React, { useRef, useState } from 'react';
import { Plus, X, Layers, Loader2, Move } from 'lucide-react';
import { prepareImageFile, prepareImageSizes, MAX_EDGE, SCOUT_EDGE } from '../services/imageUtils';
import { mapAnglesToSlots, MappingFailure } from '../services/angleMapper';
import { useT } from '../services/uiPrefs';
import { rememberProductBox } from '../services/productBoxCache';

interface AngleStripProps {
  /**
   * One entry per slot, index-aligned with `slots`. An empty string means that
   * slot is unfilled — kept positional so a tile always means the same view.
   * Empties are falsy and get filtered out when the request is built.
   */
  angles: string[];
  onChange: (angles: string[]) => void;
  /** Angles are meaningless without the item's primary photo. */
  enabled: boolean;
  label?: string;
  /** Fixed, named views for this item. Labels stay visible at all times. */
  slots?: string[];
  /** Icon of the item this strip belongs to, shown in the header. */
  icon?: React.ReactNode;
  /**
   * Fires whenever a placement's provenance changes. True means that slot's
   * photo landed there by fallback — upload order after a failed
   * classification — so its label is a guess, not a statement about the
   * photo. The renderer treats those as unlabelled rather than trusting the
   * slot name, because copying a heel from a photo of the sole is worse than
   * leaving the heel plain.
   */
  onPlacementChange?: (unverified: boolean[]) => void;
}

interface DragState {
  /** Slot the photo is being dragged out of. */
  from: number;
  data: string;
  x: number;
  y: number;
  startX: number;
  startY: number;
  /** False until the pointer has travelled far enough to count as a drag. */
  active: boolean;
  /** Slot currently under the pointer, if any. */
  over: number | null;
}

/** Pointer travel before a press becomes a drag rather than a tap. */
const DRAG_THRESHOLD = 6;

/**
 * Named reference views for one item — side, sole, back, top. Each slot is a
 * fixed position with a permanent label, so you can always tell which view a
 * thumbnail is. The primary photo lives in its own ImageInput above.
 *
 * A batch upload drops photos into the slots that are still empty, in upload
 * order. Upload order rarely matches slot order, so every filled tile is
 * draggable: drop one onto another slot and the two swap.
 */
export const AngleStrip: React.FC<AngleStripProps> = ({
  angles,
  onChange,
  enabled,
  label = 'More angles',
  slots = ['SIDE', 'BACK', 'TOP', 'DETAIL'],
  icon,
  onPlacementChange,
}) => {
  const t = useT();
  const inputRef = useRef<HTMLInputElement>(null);
  const [target, setTarget] = useState<number | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const setRef = useRef<HTMLInputElement>(null);

  // Guards the batch handler against a second pick landing while the first is
  // still decoding: both would compute their target slots from the same stale
  // `angles`, and the first batch's photos would be overwritten.
  const [reading, setReading] = useState(false);

  /** True while the one classification request is out. */
  const [classifying, setClassifying] = useState(false);

  /**
   * Set when the views could not be named, so the strip can say the tiles are
   * in upload order. Silently showing upload order looks identical to a bad
   * classification, and sends the user hunting for a bug in the wrong place.
   */
  const [unsorted, setUnsorted] = useState<{
    reason: MappingFailure;
    /** What the API itself said, so the banner never has to guess. */
    detail?: string;
    status?: number;
  } | null>(null);

  const [drag, setDrag] = useState<DragState | null>(null);

  /**
   * Per slot: did this photo land here because the classifier said so (or
   * because a human put it there), or merely because it was next in upload
   * order? Only the second kind is a guess, and only the second kind is
   * withheld from the renderer as angle evidence.
   */
  const [unverified, setUnverified] = useState<boolean[]>(() => slots.map(() => false));

  const applyFlags = (next: boolean[]) => {
    setUnverified(next);
    onPlacementChange?.(next);
  };

  /** `unverified` may be shorter than `slots` after a slot count change. */
  const paddedFlags = (): boolean[] => {
    const next = [...unverified];
    while (next.length < slots.length) next.push(false);
    return next;
  };

  // Several strips share the page (footwear, top, bottoms, the person), and
  // hit-testing goes through the document. Scoping every drop to this strip's
  // own subtree stops a drag in one item's slots from landing in another's.
  const rootRef = useRef<HTMLDivElement>(null);

  const filled = slots.filter((_, i) => angles[i]).length;

  /** `angles` may be shorter than `slots`; every write starts from full width. */
  const padded = (): string[] => {
    const next = [...angles];
    while (next.length < slots.length) next.push('');
    return next;
  };

  // --- individual upload (unchanged behaviour) -----------------------------

  const pick = (i: number) => {
    setTarget(i);
    inputRef.current?.click();
  };

  const handleFile = async (file: File | undefined) => {
    if (!file || target === null) return;
    setBusy(target);
    try {
      const prepared = await prepareImageFile(file);
      const next = padded();
      next[target] = prepared.base64;
      onChange(next);
      // A slot picked by hand is a statement about the photo, not a guess.
      const flags = paddedFlags();
      flags[target] = false;
      applyFlags(flags);
    } finally {
      setBusy(null);
      setTarget(null);
    }
  };

  const clear = (i: number) => {
    const next = padded();
    next[i] = '';
    onChange(next);
    const flags = paddedFlags();
    flags[i] = false;
    applyFlags(flags);
  };

  // --- batch upload --------------------------------------------------------

  /**
   * Photos appear in upload order first, then get moved to the slot each one
   * actually shows.
   *
   * Two stages on purpose. Reading and downscaling is local and quick, so the
   * tiles are on screen before anything is asked of the model — nothing waits
   * on the network to look like it worked. One request then names the views,
   * and the tiles move. If that request fails, upload order is what stays, and
   * dragging a tile is still the correction.
   */
  const handleSet = async (files: FileList | null) => {
    if (!files?.length) return;

    const base = padded();
    const free = slots.map((_, i) => (base[i] ? -1 : i)).filter((i) => i >= 0);
    if (!free.length) return;

    setReading(true);
    try {
      // Both sizes off ONE read and ONE decode: the full copy is what gets
      // rendered from, the small one is all the classifier needs.
      const prepared = await Promise.all(
        // Called through a lambda, never passed to map directly: map supplies
        // the index as a second argument, which the size list would read as a
        // cap and silently produce 1px thumbnails from.
        Array.from(files)
          .slice(0, free.length)
          .map((file) => prepareImageSizes(file, [MAX_EDGE, SCOUT_EDGE]))
      );

      const inOrder = [...base];
      prepared.forEach(([full], i) => {
        inOrder[free[i]] = full.base64;
      });
      onChange(inOrder);

      // Until the classifier answers, every one of these is upload order.
      const provisional = paddedFlags();
      free.slice(0, prepared.length).forEach((slot) => {
        provisional[slot] = true;
      });
      applyFlags(provisional);

      // One request for the whole set, carrying the 512px copies. A photo per
      // request, or the full-size copies, is what made this slow.
      setClassifying(true);
      const result = await mapAnglesToSlots(
        prepared.map(([, scout]) => scout.base64),
        free.map((slot) => slots[slot])
      );

      // Where the product sits in each full-size photo, for the render path
      // to crop to. Remembered against the FULL copy, which is what renders.
      prepared.forEach(([full], i) => {
        rememberProductBox(full.base64, result.assignments[i]?.box ?? null);
      });

      if (!result.classified) {
        setUnsorted({
          reason: result.reason ?? 'unreadable',
          detail: result.detail,
          status: result.status,
        });
        return;
      }

      const sorted = [...base];
      const flags = paddedFlags();
      result.assignments.forEach((assignment, i) => {
        if (assignment.slot === null) return;
        sorted[free[assignment.slot]] = prepared[i][0].base64;
        // The model named this one; the leftovers it could not place are
        // still upload order and stay marked as such.
        flags[free[assignment.slot]] = assignment.source !== 'model';
      });

      setUnsorted(null);
      onChange(sorted);
      applyFlags(flags);
    } finally {
      setClassifying(false);
      setReading(false);
    }
  };

  // --- drag & drop ---------------------------------------------------------

  const hitTest = (x: number, y: number): number | null => {
    const el = document.elementFromPoint(x, y) as HTMLElement | null;
    const zone = el?.closest<HTMLElement>('[data-slot]');
    if (!zone || !rootRef.current?.contains(zone)) return null;

    const index = Number(zone.dataset.slot);
    return Number.isInteger(index) ? index : null;
  };

  /** Swap, so dropping onto a filled slot trades the two views. */
  const applyDrop = (from: number, to: number) => {
    if (from === to) return;
    const next = padded();
    const moved = next[from];
    next[from] = next[to];
    next[to] = moved;
    onChange(next);
    // Dragging a tile into a slot is the correction the warning asks for, so
    // both ends of the swap become statements about their photos.
    const flags = paddedFlags();
    flags[from] = false;
    flags[to] = false;
    applyFlags(flags);
  };

  const beginDrag = (e: React.PointerEvent, from: number, data: string) => {
    if (e.button !== 0) return;
    // Without this the browser starts its own native image drag as soon as the
    // pointer moves, which swallows every pointermove and pointerup that
    // follows — the tile would look draggable and then do nothing.
    e.preventDefault();
    // Capture routes the rest of the gesture back to this element, so the
    // move/up handlers below see it even when the pointer leaves the tile.
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setDrag({
      from,
      data,
      x: e.clientX,
      y: e.clientY,
      startX: e.clientX,
      startY: e.clientY,
      active: false,
      over: null,
    });
  };

  const moveDrag = (e: React.PointerEvent) => {
    if (!drag) return;
    const active =
      drag.active || Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) > DRAG_THRESHOLD;

    setDrag({
      ...drag,
      x: e.clientX,
      y: e.clientY,
      active,
      over: active ? hitTest(e.clientX, e.clientY) : null,
    });
  };

  /**
   * A press that never moved is a tap, so the tap action is resolved here
   * rather than through onClick — that way a completed drag can never also
   * fire the tile's click behaviour.
   */
  const endDrag = (e: React.PointerEvent, onTap: () => void) => {
    const gesture = drag;
    setDrag(null);
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      // Capture was already released; nothing to undo.
    }
    if (!gesture) return;

    // Recomputed from the release point rather than trusting the flag: a
    // pointerup batched with the last pointermove would otherwise still read
    // as a tap and clear the tile mid-drag.
    const moved =
      gesture.active ||
      Math.hypot(e.clientX - gesture.startX, e.clientY - gesture.startY) > DRAG_THRESHOLD;

    if (!moved) {
      onTap();
      return;
    }

    const to = hitTest(e.clientX, e.clientY);
    if (to !== null) applyDrop(gesture.from, to);
  };

  const dragging = drag?.active ? drag : null;

  return (
    <div
      ref={rootRef}
      className="mt-3 min-w-0 rounded-2xl border-2 border-dashed border-yellow-500 bg-yellow-50 px-2.5 py-3 sm:px-4 sm:py-4 shadow-2xs"
    >
      <div className="flex items-center gap-2 mb-3 min-w-0">
        <span className="shrink-0 flex items-center justify-center w-7 h-7 sm:w-8 sm:h-8 rounded-lg bg-gradient-to-br from-yellow-300 to-amber-500 text-gray-900 shadow-2xs border border-yellow-300">
          {icon ?? <Layers className="w-4 h-4" />}
        </span>
        <span className="text-xs sm:text-sm font-medium truncate text-gray-800" title={t(label)}>
          {t(label)}
        </span>
        <span className="ml-auto shrink-0 text-[11px] font-medium px-2.5 py-0.5 rounded-full bg-yellow-400/70 text-gray-800">
          {filled}/{slots.length}
        </span>
      </div>

      <div
        className={`grid gap-2 sm:gap-3 ${
          slots.length > 4 ? 'grid-cols-3 sm:grid-cols-6' : 'grid-cols-2 sm:grid-cols-4'
        }`}
      >
        {slots.map((name, i) => {
          const img = angles[i];
          const loading = busy === i;
          const isDropTarget = dragging?.over === i && dragging.from !== i;
          const isSourceTile = dragging?.from === i;

          return (
            <div key={name} className="min-w-0">
              <div
                data-slot={i}
                className={`relative w-full aspect-square rounded-xl overflow-hidden border-2 flex items-center justify-center transition-all group
                  ${isDropTarget
                    ? 'border-green-500 bg-green-50 ring-4 ring-green-400/40 scale-105'
                    : img
                      ? unverified[i]
                        ? 'border-amber-500 bg-amber-50 shadow-sm'
                        : 'border-yellow-500 bg-white shadow-sm'
                      : 'border-dashed border-yellow-500/80 bg-white shadow-2xs'}
                  ${isSourceTile ? 'opacity-40' : ''}`}
              >
                {loading ? (
                  <Loader2 className="w-7 h-7 animate-spin text-yellow-600" />
                ) : img ? (
                  <>
                    <button
                      type="button"
                      style={{ touchAction: 'none' }}
                      onPointerDown={(e) => beginDrag(e, i, img)}
                      onPointerMove={moveDrag}
                      // Tapping the photo deliberately does nothing: removal is
                      // the X button below, so a mis-tap can never delete a view.
                      onPointerUp={(e) => endDrag(e, () => undefined)}
                      onPointerCancel={() => setDrag(null)}
                      onDragStart={(e) => e.preventDefault()}
                      title={`${name} view — drag onto another slot to move it`}
                      className="w-full h-full cursor-grab active:cursor-grabbing select-none"
                    >
                      <img
                        src={`data:image/jpeg;base64,${img}`}
                        alt={`${name} view`}
                        draggable={false}
                        className="w-full h-full object-cover select-none"
                      />
                      <span className="absolute inset-0 bg-black/50 text-white opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center pointer-events-none">
                        <Move className="w-5 h-5" />
                      </span>
                    </button>

                    {/* Removal lives on its own control, never on the photo. */}
                    <button
                      type="button"
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={() => clear(i)}
                      title={t('Remove the {name} view', { name })}
                      aria-label={t('Remove the {name} view', { name })}
                      className="absolute top-1 right-1 z-10 p-1 rounded-full bg-white/95 hover:bg-white text-gray-600 hover:text-red-600 shadow-md border border-gray-200 transition-all hover:scale-110 cursor-pointer"
                    >
                      <X className="w-3 h-3" strokeWidth={3} />
                    </button>

                    {/* A tile that only landed here by upload order says so.
                        Until it is dragged into place the renderer is told
                        nothing about which view it shows. */}
                    {unverified[i] && (
                      <span
                        title={`This photo is in upload order, not a named view. Drag it onto the slot it actually shows. Until then the render treats it as an unlabelled photo rather than the ${name} view.`}
                        className="absolute bottom-1 left-1 z-10 px-1.5 py-0.5 rounded-md bg-amber-500 text-white text-[9px] font-bold shadow-md leading-none"
                      >
                        ?
                      </span>
                    )}
                  </>
                ) : (
                  <button
                    type="button"
                    onClick={() => pick(i)}
                    title={t('Add {name} view', { name })}
                    className="w-full h-full flex items-center justify-center cursor-pointer hover:bg-yellow-100 transition-colors"
                  >
                    <Plus className="w-6 h-6 sm:w-7 sm:h-7 text-yellow-600" strokeWidth={3} />
                  </button>
                )}
              </div>

              {/* Label stays visible whether the slot is filled or not. */}
              <div className="mt-1.5 text-center">
                <span
                  className={`text-[10px] sm:text-[11px] font-medium tracking-wide ${
                    img ? 'text-gray-700' : 'text-gray-500'
                  }`}
                >
                  {name}
                </span>
              </div>
            </div>
          );
        })}
      </div>

      <button
        type="button"
        disabled={reading}
        onClick={() => setRef.current?.click()}
        className="mt-3 w-full flex items-center justify-center gap-2 rounded-xl border-2 border-yellow-500 bg-white hover:bg-yellow-100 text-yellow-800 font-medium text-xs sm:text-sm py-3 transition-all active:scale-98 cursor-pointer disabled:opacity-60 shadow-2xs"
        title={t("Upload several photos at once — they fill the empty slots in order; drag any that landed wrong")}
      >
        {reading ? (
          <>
            <Loader2 className="w-4 h-4 animate-spin" />
            {classifying ? t('Naming the views…') : t('Adding…')}
          </>
        ) : (
          <>
            <Layers className="w-4 h-4" />
            {t("Upload several — sorted into slots")}
          </>
        )}
      </button>

      {unsorted && (
        <div className="mt-1.5 text-[11px] text-amber-900 bg-amber-50 border border-amber-300 rounded-lg px-2.5 py-2 space-y-1">
          <p className="font-bold">
            {/* Each line names the actual failure and what fixes it. "The
                quota is spent" appears ONLY for a real allowance refusal —
                it used to cover retired model ids and dead networks too, which
                sent people to a billing page over a code problem. */}
            {unsorted.reason === 'credits'
              ? t('The account\u2019s prepaid credits are used up, so the views could not be named. Top the balance up in AI Studio; no model will answer until then.')
              : unsorted.reason === 'quota'
                ? t('The API refused on quota, so the views could not be named. A per-minute limit clears in about a minute; a daily cap clears at midnight Pacific.')
                : unsorted.reason === 'busy'
                  ? t('Google\u2019s models are saturated right now, so the views could not be named. This one is temporary — upload the set again shortly.')
                  : unsorted.reason === 'missing-model'
                    ? t('The analysis model this build asks for is not available to this key, so the views could not be named. This is a code fix, not an account problem.')
                    : unsorted.reason === 'invalid-request'
                      ? t('The API refused the request itself, so the views could not be named. That is a bug in this build rather than an account problem.')
                      : unsorted.reason === 'timeout'
                        ? t('No answer came back in time, so the views could not be named.')
                        : unsorted.reason === 'unreadable'
                          ? t('A model answered, but not with a grouping that could be read, so the views were not named.')
                          : t('The classifier could not be reached, so the views were not named.')}
          </p>

          <p>
            {t("These tiles are in")} <b>{t("upload order")}</b>. That is not an opinion about what they show, and
            the render is told nothing about their views — every one is marked unconfirmed, so a
            close-up of a face nothing photographs comes back plain rather than wrong. Drag each tile
            onto the view it actually shows to make it count.
          </p>

          {unsorted.detail && (
            <p className="text-[10px] text-amber-800/90 font-mono break-words">
              {unsorted.status ? `HTTP ${unsorted.status} · ` : ''}
              {unsorted.detail}
            </p>
          )}
        </div>
      )}

      <input
        ref={setRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={(e) => {
          handleSet(e.target.files);
          e.target.value = '';
        }}
      />

      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          handleFile(e.target.files?.[0]);
          e.target.value = '';
        }}
      />

      {/* Follows the pointer so the photo being moved is visible over the
          slots it is passing across. */}
      {dragging && (
        <div
          className="fixed z-50 pointer-events-none w-20 h-20 rounded-xl overflow-hidden border-2 border-yellow-500 shadow-2xl opacity-90"
          style={{ left: dragging.x, top: dragging.y, transform: 'translate(-50%, -50%)' }}
        >
          <img
            src={`data:image/jpeg;base64,${dragging.data}`}
            alt={t("Moving")}
            draggable={false}
            className="w-full h-full object-cover"
          />
        </div>
      )}
    </div>
  );
};
