import React, { useEffect, useMemo, useState } from 'react';
import {
  X, Check, Trash2, Loader2, AlertTriangle, Layers, Plus, ImageOff, Copy, StopCircle,
  Scissors, Info,
} from 'lucide-react';
import { useT } from '../services/uiPrefs';
import {
  ProductGroup, FolderImage, GroupingProgress, GroupingResult,
  Category, ViewName, CATEGORIES, VIEW_NAMES,
  ImageAttributes, ProductFingerprint,
  moveImage, mergeGroups, renumber, summarise, groupLabel, splitGroup,
} from '../services/productGrouper';

/**
 * One photograph's reading, laid out for a person.
 *
 * The order is the order somebody checking a grouping actually looks in — what
 * is it, what colour, then how it is built, then the marks — rather than the
 * order the fields happen to sit in the type.
 */
const ATTRIBUTE_ROWS: { key: keyof ImageAttributes; label: string }[] = [
  { key: 'type', label: 'Type' },
  { key: 'subcategory', label: 'Subcategory' },
  { key: 'colour', label: 'Colour' },
  { key: 'secondaryColours', label: 'Other colours' },
  { key: 'material', label: 'Material' },
  { key: 'texture', label: 'Texture' },
  { key: 'finish', label: 'Finish' },
  { key: 'pattern', label: 'Pattern' },
  { key: 'silhouette', label: 'Silhouette' },
  { key: 'heelType', label: 'Heel' },
  { key: 'heelHeight', label: 'Heel height' },
  { key: 'toeShape', label: 'Toe' },
  { key: 'soleType', label: 'Sole' },
  { key: 'soleThickness', label: 'Sole thickness' },
  { key: 'shaftHeight', label: 'Shaft' },
  { key: 'closure', label: 'Closure' },
  { key: 'straps', label: 'Straps' },
  { key: 'stitching', label: 'Stitching' },
  { key: 'soleColour', label: 'Sole colour' },
  { key: 'heelColour', label: 'Heel colour' },
  { key: 'soleHeelColour', label: 'Sole heel' },
  { key: 'laceColour', label: 'Lace colour' },
  { key: 'logoColour', label: 'Logo colour' },
  { key: 'logoPlacement', label: 'Logo sits' },
  { key: 'liningColour', label: 'Lining' },
  { key: 'collarColour', label: 'Collar' },
  { key: 'tongueColour', label: 'Tongue' },
  { key: 'logo', label: 'Logo' },
  { key: 'brand', label: 'Brand' },
  { key: 'sku', label: 'Code' },
  { key: 'size', label: 'Size' },
];

/**
 * What one photograph showed, and — just as importantly — what it did not.
 *
 * A field the photograph could not see is printed as "not visible" rather than
 * omitted. Somebody checking why two photographs ended up apart needs to see
 * that the heel was UNKNOWN in one of them, not to be left wondering whether
 * the system looked. An empty row is evidence about the evidence.
 */
const AttributeSheet: React.FC<{ attributes?: ImageAttributes }> = ({ attributes }) => {
  const t = useT();
  if (!attributes) {
    return (
      <p className="text-[10px] text-gray-400 leading-snug">
        This photograph has no reading — it was placed without one, or it arrived from an
        earlier run.
      </p>
    );
  }

  return (
    <div className="space-y-0.5">
      {ATTRIBUTE_ROWS.map(({ key, label }) => {
        const value = attributes[key] as string | undefined;
        return (
          <div key={key} className="flex gap-1.5 text-[10px] leading-tight">
            <span className="w-20 shrink-0 text-gray-400">{t(label)}</span>
            <span className={value ? 'text-gray-800 font-medium' : 'text-gray-300 italic'}>
              {value ?? t('not visible')}
            </span>
          </div>
        );
      })}

      {!!attributes.details?.length && (
        <div className="flex gap-1.5 text-[10px] leading-tight pt-0.5">
          <span className="w-20 shrink-0 text-gray-400">{t("Distinctive")}</span>
          <span className="text-gray-800 font-medium">{attributes.details.join(' · ')}</span>
        </div>
      )}
    </div>
  );
};

/** The evidence a product was grouped on, as a row of chips. */
const FingerprintChips: React.FC<{ fingerprint?: ProductFingerprint }> = ({ fingerprint }) => {
  const t = useT();
  if (!fingerprint) return null;

  const chips = [
    fingerprint.sku && { label: 'code', value: fingerprint.sku },
    // The part colours come first: they are what separates two items of one
    // model line, so they are what somebody checking a grouping needs to see.
    fingerprint.soleColour && { label: 'sole', value: fingerprint.soleColour },
    fingerprint.heelColour && { label: 'heel', value: fingerprint.heelColour },
    fingerprint.soleHeelColour && { label: 'sole heel', value: fingerprint.soleHeelColour },
    fingerprint.laceColour && { label: 'laces', value: fingerprint.laceColour },
    fingerprint.logoColour && { label: 'logo', value: fingerprint.logoColour },
    fingerprint.logoPlacement && { label: 'logo on', value: fingerprint.logoPlacement },
    fingerprint.liningColour && { label: 'lining', value: fingerprint.liningColour },
    fingerprint.collarColour && { label: 'collar', value: fingerprint.collarColour },
    fingerprint.heelType && { label: 'heel type', value: fingerprint.heelType },
    fingerprint.toeShape && { label: 'toe', value: fingerprint.toeShape },
    fingerprint.soleType && { label: 'sole type', value: fingerprint.soleType },
    fingerprint.shaftHeight && { label: 'shaft', value: fingerprint.shaftHeight },
    fingerprint.closure && { label: 'closure', value: fingerprint.closure },
    fingerprint.sizes.length > 0 && { label: 'size', value: fingerprint.sizes.join(', ') },
    // What the model said stands out. Invisible until now, and it is the field
    // the cross-request joining leans on hardest.
    (fingerprint.details ?? []).length > 0 &&
      { label: 'marks', value: (fingerprint.details ?? []).join(' · ') },
  ].filter(Boolean) as { label: string; value: string }[];

  if (!chips.length && !fingerprint.internalConflicts.length) return null;

  return (
    <div className="px-3 pb-2 flex flex-wrap items-center gap-1">
      {chips.map((chip) => (
        <span
          key={chip.label}
          className="text-[10px] px-1.5 py-0.5 rounded-md bg-gray-50 border border-gray-200 text-gray-600"
        >
          <span className="text-gray-400">{t(chip.label)}</span> {chip.value}
        </span>
      ))}

      {/* A group whose own photographs disagreed. This is the single most
          useful thing on the screen for spotting a wrong grouping, so it is
          spelled out rather than folded into the confidence number. */}
      {fingerprint.internalConflicts.map((conflict) => (
        <span
          key={conflict}
          className="text-[10px] px-1.5 py-0.5 rounded-md bg-amber-50 border border-amber-300 text-amber-800"
          title={t("The photographs of this product did not agree about this")}
        >
          {conflict}
        </span>
      ))}
    </div>
  );
};

interface ProductGroupReviewProps {
  images: FolderImage[];
  groups: ProductGroup[];
  unassigned: string[];
  onChange: (groups: ProductGroup[], unassigned: string[]) => void;
  /** Set while the folder is still being sorted. */
  progress: GroupingProgress | null;
  /** False when the classifier could not run; the list is then upload order. */
  classified: boolean;
  /** What went wrong, when the analysis failed outright. */
  error?: string;
  /** The model's actual reply, when it could not be read. */
  rawReply?: string;
  /** Renders the confirmed run would cost, already filtered per category. */
  renderCount: number;
  shotCount: number;
  onConfirm: () => void;
  onCancel: () => void;
  /**
   * True while this grouping has never been confirmed. Cancelling then throws
   * the folder away, which is what the user means the first time. Once the
   * products are confirmed, reopening this screen to look at them must never
   * be able to destroy them — so the same controls only close.
   */
  isFirstReview?: boolean;
  /** One line per photo saying where it landed and why. */
  log?: string[];
  /** Abandons a sort in flight. Sorting a large folder takes minutes. */
  onStop?: () => void;
  /**
   * v3 only: why each uncertain photo could not be placed, keyed by image id.
   * Display-only — the placement decision itself is made upstream.
   */
  uncertainReasons?: Record<string, string>;
}

/** Angles a product has at most one of. Shared with the checked invariant in groupFolderV3. */
const SINGLE_VIEW_ANGLES = new Set<string>(['FRONT', 'BACK', 'LEFT', 'RIGHT', 'TOP', 'SOLE']);

/**
 * True when two of this group's photographs claim the same one-per-product
 * angle — a duplicate SOLE, say. Unreachable by construction (the v3 pipeline
 * treats cannot-link as absolute), so this is a checked invariant rather than
 * a real branch: a group that trips it is reporting a bug, not a judgement
 * call, and is shown as one.
 */
const hasDuplicateAngle = (group: ProductGroup): boolean => {
  const seen = new Set<string>();
  for (const image of group.images) {
    if (!SINGLE_VIEW_ANGLES.has(image.view)) continue;
    if (seen.has(image.view)) return true;
    seen.add(image.view);
  }
  return false;
};

const CATEGORY_LABEL: Record<Category, string> = {
  FOOTWEAR: 'Footwear',
  TOP: 'Top',
  BOTTOMS: 'Bottoms',
  OTHER: 'Other',
};

const confidenceTone = (value: number) =>
  value >= 0.85
    ? 'bg-green-100 text-green-800 border-green-300'
    : value >= 0.6
      ? 'bg-yellow-100 text-yellow-800 border-yellow-300'
      : 'bg-red-100 text-red-800 border-red-300';

/**
 * The gate between an automatic grouping and a run that costs one render per
 * product per shot. Everything the classifier decided is editable here, because
 * a wrong group is not a cosmetic problem: a product's group IS the reference
 * set its renders are generated from, so a stray photo becomes a fabricated
 * detail in the output.
 */
export const ProductGroupReview: React.FC<ProductGroupReviewProps> = ({
  images,
  groups,
  unassigned,
  onChange,
  progress,
  classified,
  error,
  rawReply,
  renderCount,
  shotCount,
  onConfirm,
  onCancel,
  isFirstReview = true,
  log = [],
  onStop,
  uncertainReasons,
}) => {
  const t = useT();
  const [copied, setCopied] = useState(false);

  /** Photographs ticked for a split, by image id. */
  const [picked, setPicked] = useState<Set<string>>(new Set());

  /** The photograph whose reading is open, if any. */
  const [inspecting, setInspecting] = useState<string | null>(null);

  const togglePicked = (imageId: string) =>
    setPicked((held) => {
      const next = new Set(held);
      if (next.has(imageId)) next.delete(imageId);
      else next.add(imageId);
      return next;
    });

  // Sorting a folder is now a minutes-long job, so it has to say how long it
  // has been running and roughly how much is left.
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());

  const sorting = !!progress;

  useEffect(() => {
    if (!sorting) {
      setStartedAt(null);
      return;
    }
    setStartedAt((prev) => prev ?? Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [sorting]);

  // Each phase is timed from when IT started. The stages run at completely
  // different rates — cropping is local and steady, the requests are neither —
  // so a single clock across all of them produces an estimate that is wrong for
  // every one of them.
  const phase = progress?.phase;
  const [phaseStartedAt, setPhaseStartedAt] = useState<number | null>(null);

  useEffect(() => {
    setPhaseStartedAt(phase ? Date.now() : null);
  }, [phase]);
  const byId = useMemo(() => new Map(images.map((img) => [img.id, img])), [images]);

  const src = (imageId: string) => {
    const image = byId.get(imageId);
    return image ? `data:image/jpeg;base64,${image.thumb}` : '';
  };

  const fileName = (imageId: string) => byId.get(imageId)?.fileName ?? imageId;

  const totalAssigned = groups.reduce((sum, g) => sum + g.images.length, 0);

  // --- edits -------------------------------------------------------------

  const setGroups = (next: ProductGroup[], nextUnassigned = unassigned) =>
    onChange(next, nextUnassigned);

  const rename = (id: string, name: string) =>
    setGroups(groups.map((g) => (g.id === id ? { ...g, name } : g)));

  const recategorise = (id: string, category: Category) =>
    setGroups(groups.map((g) => (g.id === id ? { ...g, category } : g)));

  const setView = (groupId: string, imageId: string, view: ViewName) =>
    setGroups(
      groups.map((g) =>
        g.id === groupId
          ? summarise({
              ...g,
              images: g.images.map((i) =>
                i.imageId === imageId ? { ...i, view, viewSource: 'model' as const } : i
              ),
            })
          : g
      )
    );

  const detach = (imageId: string) =>
    setGroups(moveImage(groups, imageId, null), [...unassigned, imageId]);

  const relocate = (imageId: string, toId: string) =>
    setGroups(moveImage(groups, imageId, toId));

  const fold = (fromId: string, intoId: string) => setGroups(mergeGroups(groups, fromId, intoId));

  /**
   * Takes the ticked photographs out of a group and makes them a product.
   *
   * The correction for the one mistake that costs real money: two products
   * grouped as one, whose renders would then be built from both items'
   * photographs. Doing it by hand meant detaching each photograph to the tray
   * and reassembling it there, which is enough work that people do not bother.
   */
  const split = (groupId: string) => {
    const group = groups.find((g) => g.id === groupId);
    if (!group) return;
    const taking = group.images.map((i) => i.imageId).filter((id) => picked.has(id));
    if (!taking.length || taking.length === group.images.length) return;
    setGroups(splitGroup(groups, groupId, taking));
    setPicked((held) => {
      const next = new Set(held);
      taking.forEach((id) => next.delete(id));
      return next;
    });
  };

  const dropGroup = (id: string) => {
    const group = groups.find((g) => g.id === id);
    if (!group) return;
    setGroups(
      renumber(groups.filter((g) => g.id !== id)),
      [...unassigned, ...group.images.map((i) => i.imageId)]
    );
  };

  const assign = (imageId: string, groupId: string) => {
    const target = groups.find((g) => g.id === groupId);
    if (!target) return;
    setGroups(
      groups.map((g) =>
        g.id === groupId
          ? summarise({
              ...g,
              images: [...g.images, { imageId, view: 'OTHER' as ViewName, viewSource: 'fallback' as const }],
            })
          : g
      ),
      unassigned.filter((id) => id !== imageId)
    );
  };

  const asNewGroup = (imageId: string) =>
    setGroups(
      renumber([
        ...groups,
        summarise({
          id: `product-${groups.length + 1}`,
          name: groupLabel(groups.length),
          category: 'OTHER',
          images: [{ imageId, view: 'OTHER', viewSource: 'fallback' }],
          confidence: 1,
          needsReview: true,
        }),
      ]),
      unassigned.filter((id) => id !== imageId)
    );

  // --- sorting in progress ------------------------------------------------

  if (progress) {
    const pct = progress.total ? Math.round((progress.done / progress.total) * 100) : 0;

    const elapsed = startedAt ? Math.max(0, Math.round((now - startedAt) / 1000)) : 0;
    const clock = (seconds: number) =>
      `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;

    // Each phase is timed on its own. Extrapolating one rate across stages that
    // work at completely different speeds is what produced "about 15 minutes
    // left" for a folder whose remaining work was under a minute.
    const started = phaseStartedAt ?? startedAt;
    const inPhase = started ? Math.max(0, Math.round((now - started) / 1000)) : 0;
    const remaining =
      progress.done > 0 && inPhase > 0 && progress.total > progress.done
        ? Math.round((inPhase / progress.done) * (progress.total - progress.done))
        : null;

    const stage = {
      angles: {
        title: t('Reading angles…'),
        detail: `${progress.done} of ${progress.total} angle sheet(s) read. Working out which way each product faces before anything is compared.`,
        note: t('This pass only reads orientation — front, back, side — and never decides which photos match.'),
      },
      preparing: {
        title: t('Trimming the backgrounds…'),
        detail: `${progress.done} of ${progress.total} photos cropped to the product. This runs on your machine — nothing has been sent yet.`,
        note: t('Cropping away the room means the product fills the frame, so fine details stay readable.'),
      },
      loading: {
        title: t('Downloading the local image model…'),
        detail: progress.total
          ? `${progress.done} of ${progress.total} MB. One time only — it is cached for every folder after this.`
          : t('Starting the download. One time only — it is cached for every folder after this.'),
        note: t('This runs entirely on your machine, so the photos are never sent anywhere for this step.'),
      },
      reading: {
        title: t('Looking at the photos…'),
        detail: `${progress.done} of ${progress.total} photos read. Still on your machine — nothing sent, nothing charged.`,
        note: t('Each photo gets a visual fingerprint locally, to work out which ones are worth comparing.'),
      },
      assigning: {
        title: t('Comparing photos side by side…'),
        detail: `${progress.done} of ${progress.total} comparisons done.`,
        note: t('Photos are laid out together and the model is asked which of them show the same item.'),
      },
      verifying: {
        title: t('Settling the close calls…'),
        detail: `${progress.done} of ${progress.total} pairs re-checked.`,
        note: t('A few pairs came back judged both ways. Each is asked again, on its own, by the other model.'),
      },
    }[progress.phase];
    return (
      <div className="fixed inset-0 z-50 bg-gray-900/80 backdrop-blur-sm flex items-center justify-center p-4">
        <div className="bg-white rounded-2xl shadow-2xl p-6 max-w-md w-full text-center">
          <Loader2 className="w-8 h-8 animate-spin text-yellow-500 mx-auto mb-3" />
          <p className="font-bold text-gray-900">{stage.title}</p>
          <p className="text-xs text-gray-500 mt-1">
            {progress.from && progress.to
              ? `Looking at photos ${progress.from}–${progress.to} of ${progress.total}…`
              : stage.detail}
          </p>
          <div className="w-full h-2 bg-gray-100 rounded-full overflow-hidden mt-4">
            <div
              className="h-full bg-gradient-to-r from-yellow-400 to-amber-500 transition-all duration-300"
              style={{ width: `${pct}%` }}
            />
          </div>

          <p className="text-[11px] text-gray-400 mt-2">
            {clock(elapsed)} elapsed
            {remaining !== null ? ` · about ${clock(remaining)} left` : ''}
          </p>

          <p className="text-[10px] text-gray-400 mt-2 leading-snug">{stage.note}</p>

          {/* Products appear here as each batch lands. Waiting for the whole
              folder before showing anything made a long sort look like a hang. */}
          {groups.length > 0 && (
            <div className="mt-4 text-left">
              <p className="text-[11px] font-bold text-gray-700 mb-1.5">
                {groups.length} product{groups.length === 1 ? '' : 's'} so far
              </p>
              <div className="max-h-44 overflow-y-auto space-y-1.5 pr-1">
                {groups.map((group) => (
                  <div key={group.id} className="flex items-center gap-1.5">
                    <span className="text-[10px] font-bold text-gray-500 w-16 shrink-0 truncate">
                      {group.name}
                    </span>
                    <div className="flex gap-1 overflow-hidden">
                      {group.images.slice(0, 6).map((entry) => (
                        <img
                          key={entry.imageId}
                          src={src(entry.imageId)}
                          alt=""
                          className="w-7 h-7 rounded-md object-cover border border-gray-200 shrink-0"
                        />
                      ))}
                      {group.images.length > 6 && (
                        <span className="text-[10px] text-gray-400 self-center">
                          +{group.images.length - 6}
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {onStop && (
            <button
              onClick={onStop}
              className="mt-4 inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-bold text-gray-700 border border-gray-300 hover:bg-gray-50 hover:text-red-600 hover:border-red-300 transition-colors cursor-pointer"
            >
              <StopCircle className="w-3.5 h-3.5" />
              {t("Stop sorting — keep what is done")}
            </button>
          )}
        </div>
      </div>
    );
  }

  // --- review -------------------------------------------------------------

  return (
    <div className="fixed inset-0 z-50 bg-gray-900/80 backdrop-blur-sm flex items-stretch sm:items-center justify-center sm:p-4">
      <div className="bg-gray-50 w-full sm:max-w-5xl sm:rounded-2xl shadow-2xl flex flex-col max-h-screen sm:max-h-[92vh] overflow-hidden">
        {/* header */}
        <div className="shrink-0 bg-white border-b border-gray-200 px-4 py-3 flex items-center justify-between gap-3">
          <div className="min-w-0">
            <h2 className="font-black text-gray-900 text-sm sm:text-base flex items-center gap-2">
              <Layers className="w-4 h-4 text-yellow-600 shrink-0" />
              <span className="truncate">
                {groups.length} product{groups.length === 1 ? '' : 's'} from {images.length} photos
              </span>
            </h2>
            <p className="text-[11px] text-gray-500 mt-0.5">
              {t("Check the grouping before rendering — each product is generated only from its own photos.")}
            </p>
          </div>
          <button
            onClick={onCancel}
            className="p-2 rounded-full hover:bg-gray-100 text-gray-500 hover:text-gray-900 transition-colors shrink-0"
            title={isFirstReview ? t('Discard this folder') : t('Close — the products stay')}
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {!classified && (
          <div className="shrink-0 bg-red-50 border-b border-red-200 px-4 py-3 text-[12px] text-red-900">
            <p className="font-bold flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 shrink-0" />
              {t("The photos could not be sorted.")}
            </p>
            <p className="mt-1">{error ?? t('The analysis did not run.')}</p>

            {rawReply && (
              <>
                <p className="mt-2 font-bold text-[11px]">{t("What the model actually replied:")}</p>
                <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-words bg-white/70 border border-red-200 rounded-lg p-2 text-[10px] leading-snug">
                  {rawReply}
                </pre>
              </>
            )}

            <p className="mt-2 text-[11px]">
              Nothing has been grouped, on purpose: turning a failure into one product per photo
              would hide this. Close, and try again.
            </p>
          </div>
        )}

        {/* groups */}
        <div className="flex-1 overflow-y-auto p-3 sm:p-4 space-y-3">
          {groups.map((group) => (
            <div
              key={group.id}
              className="bg-white rounded-xl border border-gray-200 shadow-2xs overflow-hidden"
            >
              <div className="px-3 py-2 border-b border-gray-100 flex flex-wrap items-center gap-2">
                <input
                  value={group.name}
                  onChange={(e) => rename(group.id, e.target.value)}
                  className="font-bold text-sm text-gray-900 bg-transparent border-b border-transparent hover:border-gray-300 focus:border-yellow-500 focus:outline-none px-0.5 min-w-0 flex-1"
                />

                <select
                  value={group.category}
                  onChange={(e) => recategorise(group.id, e.target.value as Category)}
                  className="text-[11px] font-bold rounded-full border border-gray-300 bg-white px-2 py-1 text-gray-700 focus:outline-none focus:border-yellow-500 cursor-pointer"
                >
                  {CATEGORIES.map((c) => (
                    <option key={c} value={c}>{t(CATEGORY_LABEL[c])}</option>
                  ))}
                </select>

                <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${confidenceTone(group.confidence)}`}>
                  {Math.round(group.confidence * 100)}%
                </span>

                <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-gray-100 text-gray-600 border border-gray-200">
                  {group.images.length} image{group.images.length === 1 ? '' : 's'}
                </span>

                {/* The colourway and branding this product was grouped on. A
                    wrong grouping is almost always a wrong reading of one of
                    these, so they are shown rather than buried. */}
                {group.colour && (
                  <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-white text-gray-600 border border-gray-300">
                    {group.colour}
                  </span>
                )}
                {group.brand && (
                  <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-white text-gray-600 border border-gray-300 uppercase">
                    {group.brand}
                  </span>
                )}

                {group.needsReview && (
                  <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 border border-amber-300 flex items-center gap-1">
                    <AlertTriangle className="w-2.5 h-2.5" /> check
                  </span>
                )}

                {groups.length > 1 && (
                  <select
                    value=""
                    onChange={(e) => e.target.value && fold(group.id, e.target.value)}
                    className="text-[11px] rounded-full border border-gray-300 bg-white px-2 py-1 text-gray-600 focus:outline-none focus:border-yellow-500 cursor-pointer"
                    title={t("Merge this product into another")}
                  >
                    <option value="">{t("Merge into…")}</option>
                    {groups.filter((g) => g.id !== group.id).map((g) => (
                      <option key={g.id} value={g.id}>{g.name}</option>
                    ))}
                  </select>
                )}

                <button
                  onClick={() => dropGroup(group.id)}
                  className="p-1.5 rounded-lg text-gray-400 hover:text-red-600 hover:bg-red-50 transition-colors"
                  title={t("Delete product (photos return to the tray)")}
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>

              {/* Checked invariant, display-only: a product should never hold two
                  photographs of the same one-per-product angle. This should be
                  unreachable by construction, so seeing it means the grouping
                  itself has a bug worth reporting rather than a call to make. */}
              {hasDuplicateAngle(group) && (
                <div className="px-3 py-1.5 bg-red-50 border-b border-red-200 text-[11px] font-bold text-red-800 flex items-center gap-1.5">
                  <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                  duplicate angle — impossible grouping, report this
                </div>
              )}

              {/* What this product actually is, in one line, built from every
                  photograph rather than from the first one. A wrong grouping
                  usually reads wrong here before it looks wrong in the row. */}
              {group.description && (
                <p className="px-3 pt-1.5 text-[11px] text-gray-600 font-medium">
                  {group.description}
                </p>
              )}

              <FingerprintChips fingerprint={group.fingerprint} />

              {/* Splitting only appears once some — but not all — of the row is
                  ticked, because those are the only conditions under which it
                  does anything. */}
              {(() => {
                const taking = group.images.filter((i) => picked.has(i.imageId)).length;
                if (!taking || taking === group.images.length) return null;
                return (
                  <div className="px-3 pb-2">
                    <button
                      onClick={() => split(group.id)}
                      className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-bold text-gray-700 bg-white border border-gray-300 hover:border-yellow-500 hover:text-yellow-800 hover:bg-yellow-50 transition-colors cursor-pointer"
                    >
                      <Scissors className="w-3 h-3" />
                      Split {taking} photo{taking === 1 ? '' : 's'} into a new product
                    </button>
                  </div>
                );
              })()}

              {/* One product is one row. The number of photos per product is
                  whatever the grouping found, so the row scrolls rather than
                  wrapping into a block that reads like several products. */}
              <div className="p-2.5 flex gap-2 overflow-x-auto">
                {group.images.map((entry) => (
                  <div key={entry.imageId} className="relative group/tile w-28 shrink-0">
                    <div className="aspect-square rounded-lg overflow-hidden bg-gray-900 border border-gray-200">
                      <img
                        src={src(entry.imageId)}
                        alt={fileName(entry.imageId)}
                        title={entry.reason ? `${fileName(entry.imageId)} — ${entry.reason}` : fileName(entry.imageId)}
                        className="w-full h-full object-contain"
                      />
                    </div>

                    <button
                      onClick={() => detach(entry.imageId)}
                      className="absolute top-1 right-1 bg-white/90 hover:bg-white text-gray-600 hover:text-red-600 p-1 rounded-full shadow-md opacity-0 group-hover/tile:opacity-100 focus:opacity-100 transition-opacity"
                      title={t("Remove from this product")}
                    >
                      <X className="w-3 h-3" />
                    </button>

                    <label
                      className="absolute top-1 left-1 flex items-center justify-center w-5 h-5 rounded-md bg-white/90 shadow-md cursor-pointer"
                      title={t("Pick this photo, then split it out")}
                    >
                      <input
                        type="checkbox"
                        checked={picked.has(entry.imageId)}
                        onChange={() => togglePicked(entry.imageId)}
                        className="w-3 h-3 accent-yellow-500 cursor-pointer"
                      />
                    </label>

                    <button
                      onClick={() =>
                        setInspecting((held) => (held === entry.imageId ? null : entry.imageId))
                      }
                      className={`absolute bottom-1 left-1 p-1 rounded-full shadow-md transition-colors ${
                        inspecting === entry.imageId
                          ? 'bg-yellow-400 text-gray-900'
                          : 'bg-white/90 text-gray-600 hover:text-gray-900'
                      }`}
                      title={t("What this photo showed")}
                    >
                      <Info className="w-3 h-3" />
                    </button>

                    {(entry.colour || entry.reason) && (
                      <p
                        className="mt-1 text-[9px] leading-tight text-gray-500 line-clamp-2"
                        title={[entry.colour, entry.reason].filter(Boolean).join(' — ')}
                      >
                        {entry.colour && <span className="font-bold text-gray-700">{entry.colour}</span>}
                        {entry.colour && entry.reason ? ' · ' : ''}
                        {entry.reason}
                      </p>
                    )}

                    {/* v3 only: how this photo came to be in this product. A
                        direct join names the reason the model gave; an
                        indirect one names the neighbour it chained through,
                        because that photo was never compared to this one. */}
                    {entry.joinedVia && (() => {
                      const position =
                        group.images.findIndex((im) => im.imageId === entry.joinedVia!.to) + 1;
                      if (!position) return null;
                      return (
                        <p
                          className="mt-0.5 text-[9px] leading-tight text-gray-400 line-clamp-2 italic"
                          title={
                            entry.joinedVia!.kind === 'indirect'
                              ? `connected through ${position} (never compared directly)`
                              : `joined to ${position} — "${entry.joinedVia!.because ?? ''}"`
                          }
                        >
                          {entry.joinedVia!.kind === 'indirect'
                            ? `connected through ${position} (never compared directly)`
                            : `joined to ${position} — "${entry.joinedVia!.because ?? ''}"`}
                        </p>
                      );
                    })()}

                    <select
                      value={entry.view}
                      onChange={(e) => setView(group.id, entry.imageId, e.target.value as ViewName)}
                      className="mt-1 w-full text-[10px] font-bold rounded-md border border-gray-300 bg-white px-1 py-0.5 text-gray-700 focus:outline-none focus:border-yellow-500 cursor-pointer"
                    >
                      {VIEW_NAMES.map((v) => (
                        <option key={v} value={v}>{v}</option>
                      ))}
                    </select>

                    {groups.length > 1 && (
                      <select
                        value=""
                        onChange={(e) => e.target.value && relocate(entry.imageId, e.target.value)}
                        className="mt-1 w-full text-[10px] rounded-md border border-gray-200 bg-gray-50 px-1 py-0.5 text-gray-500 focus:outline-none focus:border-yellow-500 cursor-pointer"
                        title={t("Move to another product")}
                      >
                        <option value="">{t("Move to…")}</option>
                        {groups.filter((g) => g.id !== group.id).map((g) => (
                          <option key={g.id} value={g.id}>{g.name}</option>
                        ))}
                      </select>
                    )}

                    {inspecting === entry.imageId && (
                      <div className="mt-1 p-1.5 rounded-md bg-gray-50 border border-gray-200">
                        <AttributeSheet attributes={entry.attributes} />
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ))}

          {/* unassigned tray */}
          {unassigned.length > 0 && (
            <div className="bg-white rounded-xl border border-dashed border-gray-300">
              <div className="px-3 py-2 border-b border-gray-100 flex items-center gap-2">
                <ImageOff className="w-3.5 h-3.5 text-gray-400" />
                <span className="font-bold text-sm text-gray-700">
                  Uncertain ({unassigned.length})
                </span>
                <span className="text-[11px] text-gray-400">
                  — no product could claim these on the evidence, so they were not guessed at.
                  They are not rendered until you place them.
                </span>
              </div>

              <div className="p-2.5 grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-2">
                {unassigned.map((imageId) => (
                  <div key={imageId}>
                    <div className="aspect-square rounded-lg overflow-hidden bg-gray-900 border border-gray-200">
                      <img src={src(imageId)} alt={fileName(imageId)} className="w-full h-full object-contain" />
                    </div>

                    {/* v3 only: why the grouping refused to guess for this
                        photo, rather than leaving the tray unexplained. */}
                    {uncertainReasons?.[imageId] && (
                      <p
                        className="mt-1 text-[9px] leading-tight text-gray-400 line-clamp-2"
                        title={uncertainReasons[imageId]}
                      >
                        {uncertainReasons[imageId]}
                      </p>
                    )}

                    <select
                      value=""
                      onChange={(e) => e.target.value && assign(imageId, e.target.value)}
                      className="mt-1 w-full text-[10px] rounded-md border border-gray-300 bg-white px-1 py-0.5 text-gray-700 focus:outline-none focus:border-yellow-500 cursor-pointer"
                    >
                      <option value="">{t("Add to…")}</option>
                      {groups.map((g) => (
                        <option key={g.id} value={g.id}>{g.name}</option>
                      ))}
                    </select>

                    <button
                      onClick={() => asNewGroup(imageId)}
                      className="mt-1 w-full text-[10px] font-bold rounded-md border border-gray-200 bg-gray-50 hover:bg-yellow-50 hover:border-yellow-400 px-1 py-0.5 text-gray-600 hover:text-yellow-800 transition-colors flex items-center justify-center gap-1"
                    >
                      <Plus className="w-2.5 h-2.5" /> {t("New product")}
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* footer */}
        <div className="shrink-0 bg-white border-t border-gray-200 px-4 py-3 flex flex-wrap items-center justify-between gap-3">
          <div className="text-[11px] text-gray-600 min-w-0">
            {shotCount === 0 ? (
              <span>
                <strong className="text-gray-900">{groups.length}</strong> product
                {groups.length === 1 ? '' : 's'} ready — pick your camera shots after confirming.
                {totalAssigned < images.length && (
                  <span className="text-gray-400"> · {images.length - totalAssigned} photo(s) unassigned</span>
                )}
              </span>
            ) : (
              <span>
                <strong className="text-gray-900">{groups.length}</strong> product
                {groups.length === 1 ? '' : 's'} × <strong className="text-gray-900">{shotCount}</strong> shot
                {shotCount === 1 ? '' : 's'} ={' '}
                <strong className="text-gray-900">{renderCount}</strong> render
                {renderCount === 1 ? '' : 's'}
                {totalAssigned < images.length && (
                  <span className="text-gray-400"> · {images.length - totalAssigned} photo(s) unassigned</span>
                )}
              </span>
            )}
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {log.length > 0 && (
              <button
                onClick={() => {
                  navigator.clipboard?.writeText(log.join('\n')).then(
                    () => {
                      setCopied(true);
                      setTimeout(() => setCopied(false), 2000);
                    },
                    () => setCopied(false)
                  );
                }}
                className="px-3 py-2 rounded-xl text-xs font-bold text-gray-600 hover:text-gray-900 hover:bg-gray-100 transition-colors cursor-pointer inline-flex items-center gap-1.5"
                title={t("Copy why each photo landed where it did")}
              >
                <Copy className="w-3.5 h-3.5" />
                {copied ? t('Copied') : t('Copy log')}
              </button>
            )}

            <button
              onClick={onCancel}
              className="px-3 py-2 rounded-xl text-xs font-bold text-gray-600 hover:text-gray-900 hover:bg-gray-100 transition-colors cursor-pointer"
            >
              {isFirstReview ? t('Discard folder') : t('Close')}
            </button>

            <button
              onClick={onConfirm}
              disabled={groups.length === 0}
              className="px-4 py-2 rounded-xl text-xs font-black text-gray-900 bg-gradient-to-r from-yellow-400 to-amber-500 hover:from-yellow-300 hover:to-amber-400 shadow-md shadow-yellow-500/30 transition-all active:scale-98 disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1.5"
            >
              <Check className="w-3.5 h-3.5" /> {t("Confirm grouping")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
