import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Search, X, Trash2, Download, Filter, Loader2, RefreshCw, Images, Calendar, CheckCircle2, RotateCcw,
} from 'lucide-react';
import {
  GenerationRecord, LibraryFacets, LibraryQuery, FacetEntry,
  fetchLibrary, fetchFacets, deleteGeneration, setGenerationApproved, libraryImageUrl,
} from '../services/libraryClient';
import { type Trim, NO_TRIM, hasTrim, describeTrim, trimmedDataUrl } from '../services/trimCrop';
import { useT } from '../services/uiPrefs';
import { TrimCropFrame } from './TrimCropFrame';

/**
 * The Library: every render this deployment ever stored, browsable as a
 * catalog rather than a camera roll. Filtering, search, sorting and paging all
 * happen on the server — the browser only ever holds the pages it has seen.
 */

const PAGE_SIZE = 24;

type Filters = {
  q: string;
  category: string;
  /** "Product 12" / "Outfit 3" — the Library's own number for a unit. */
  unit: string;
  /** folder / manual / mixed. */
  source: string;
  style: string;
  from: string;
  to: string;
  /** Only renders the reviewer approved. */
  approved: boolean;
  sort: 'newest' | 'oldest';
};

const EMPTY_FILTERS: Filters = {
  q: '', category: '', unit: '', source: '', style: '', from: '', to: '', approved: false, sort: 'newest',
};

const formatDate = (iso: string): string => {
  const date = new Date(iso);
  return isNaN(date.getTime())
    ? iso
    : date.toLocaleString(undefined, {
        year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
      });
};

/** A grid image that degrades to a labelled placeholder when its bytes are gone. */
const CardImage: React.FC<{ id: string; alt: string; kind: 'thumb' | 'image' | 'source' }> = ({ id, alt, kind }) => {
  const t = useT();
  const [broken, setBroken] = useState(false);
  if (broken) {
    return (
      <div className="w-full h-full flex flex-col items-center justify-center gap-2 bg-gray-100 text-gray-400">
        <Images className="w-8 h-8" />
        <span className="text-[11px] font-medium">{t("Image unavailable")}</span>
      </div>
    );
  }
  return (
    <img
      src={libraryImageUrl(id, kind)}
      alt={alt}
      loading="lazy"
      onError={() => setBroken(true)}
      className="w-full h-full object-cover transition-transform duration-300 group-hover:scale-[1.03]"
    />
  );
};

/** Options under their group headings, in first-seen order; ungrouped ones stay flat. */
const groupsOf = (options: FacetEntry[]): [string | null, FacetEntry[]][] => {
  const groups = new Map<string | null, FacetEntry[]>();
  for (const o of options) {
    const key = o.group ?? null;
    groups.set(key, [...(groups.get(key) ?? []), o]);
  }
  return [...groups.entries()];
};

const FilterSelect: React.FC<{
  label: string;
  value: string;
  options: FacetEntry[];
  onChange: (value: string) => void;
}> = ({ label, value, options, onChange }) => {
  const t = useT();
  return (
  <label className="flex flex-col gap-1 min-w-0">
    <span className="text-[11px] font-bold uppercase tracking-wide text-gray-500">{label}</span>
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="px-2.5 py-2 rounded-xl border border-gray-200 bg-white text-sm text-gray-800 focus:outline-none focus:ring-2 focus:ring-yellow-400/60 cursor-pointer max-w-full"
    >
      <option value="">{t("All")}</option>
      {groupsOf(options).map(([group, entries]) => {
        const items = entries.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label} ({o.count})
          </option>
        ));
        return group ? <optgroup key={group} label={group}>{items}</optgroup> : items;
      })}
    </select>
  </label>
  );
};

export const LibraryPage: React.FC = () => {
  const t = useT();
  const [items, setItems] = useState<GenerationRecord[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [facets, setFacets] = useState<LibraryFacets | null>(null);
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [searchDraft, setSearchDraft] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<GenerationRecord | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [approving, setApproving] = useState(false);

  // Only the newest request may write results; a stale slow response must not
  // overwrite a fresher page.
  const requestSeq = useRef(0);
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  const queryOf = useCallback((f: Filters): LibraryQuery => ({
    q: f.q || undefined,
    category: f.category || undefined,
    unit: f.unit || undefined,
    source: (f.source || undefined) as LibraryQuery['source'],
    style: f.style || undefined,
    from: f.from || undefined,
    to: f.to || undefined,
    approved: f.approved || undefined,
    sort: f.sort,
    limit: PAGE_SIZE,
  }), []);

  const loadFirstPage = useCallback(async (f: Filters) => {
    const seq = ++requestSeq.current;
    setLoading(true);
    setError(null);
    try {
      const page = await fetchLibrary(queryOf(f));
      if (seq !== requestSeq.current) return;
      setItems(page.items);
      setNextCursor(page.nextCursor);
      setTotal(page.total);
    } catch (err: any) {
      if (seq !== requestSeq.current) return;
      setError(err?.message || t('Could not load the Library.'));
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }, [queryOf]);

  const loadMore = useCallback(async () => {
    if (!nextCursor || loadingMore || loading) return;
    const seq = requestSeq.current;
    setLoadingMore(true);
    try {
      const page = await fetchLibrary({ ...queryOf(filters), cursor: nextCursor });
      if (seq !== requestSeq.current) return;
      setItems((prev) => {
        const held = new Set(prev.map((r) => r.id));
        return [...prev, ...page.items.filter((r) => !held.has(r.id))];
      });
      setNextCursor(page.nextCursor);
    } catch (err: any) {
      if (seq === requestSeq.current) setError(err?.message || t('Could not load more.'));
    } finally {
      if (seq === requestSeq.current) setLoadingMore(false);
    }
  }, [nextCursor, loadingMore, loading, filters, queryOf]);

  useEffect(() => { void loadFirstPage(filters); }, [filters, loadFirstPage]);

  useEffect(() => {
    fetchFacets().then(setFacets).catch(() => setFacets(null));
  }, []);

  // Search box → filters, debounced so typing does not fire a request per key.
  useEffect(() => {
    const timer = setTimeout(() => {
      setFilters((f) => (f.q === searchDraft.trim() ? f : { ...f, q: searchDraft.trim() }));
    }, 350);
    return () => clearTimeout(timer);
  }, [searchDraft]);

  // Infinite scroll: fetch the next page when the sentinel enters the viewport.
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || !nextCursor) return;
    const observer = new IntersectionObserver(
      (entries) => { if (entries.some((e) => e.isIntersecting)) void loadMore(); },
      { rootMargin: '600px' }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [nextCursor, loadMore]);

  // Detail view keyboard handling.
  useEffect(() => {
    if (!detail) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setDetail(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [detail]);

  useEffect(() => { setConfirmingDelete(false); }, [detail]);

  const setFilter = (patch: Partial<Filters>) => setFilters((f) => ({ ...f, ...patch }));

  const sourceLabel = (value: string) => facets?.sources.find((s) => s.value === value)?.label ?? value;

  const activeChips = useMemo(() => {
    const chips: { key: keyof Filters; label: string }[] = [];
    if (filters.q) chips.push({ key: 'q', label: `“${filters.q}”` });
    if (filters.category) chips.push({ key: 'category', label: filters.category });
    if (filters.unit) chips.push({ key: 'unit', label: filters.unit });
    if (filters.source) chips.push({ key: 'source', label: sourceLabel(filters.source) });
    if (filters.style) {
      const style = facets?.styles.find((s) => s.value === filters.style);
      chips.push({ key: 'style', label: style?.label || filters.style });
    }
    if (filters.from) chips.push({ key: 'from', label: `from ${filters.from}` });
    if (filters.to) chips.push({ key: 'to', label: `to ${filters.to}` });
    if (filters.approved) chips.push({ key: 'approved', label: t('Approved only') });
    return chips;
  }, [filters, facets]);

  const clearAll = () => { setSearchDraft(''); setFilters(EMPTY_FILTERS); };

  /** The cutting edge on the open render: percent trimmed off its top and bottom. */
  const [trim, setTrim] = useState<Trim>(NO_TRIM);
  const [detailImageBroken, setDetailImageBroken] = useState(false);
  const [exporting, setExporting] = useState(false);
  const detailId = detail?.id ?? null;
  useEffect(() => {
    setTrim(NO_TRIM);
    setDetailImageBroken(false);
  }, [detailId]);

  /** Downloads the open render; when the edges were trimmed, the cut copy. */
  const downloadDetail = async () => {
    if (!detail || exporting) return;
    const product = detail.product?.name ? `${detail.product.name.replace(/[^a-z0-9]/gi, '_')}_` : '';
    const name = `EM_Sport_${product}${(detail.styleLabel || 'render').replace(/[^a-z0-9]/gi, '_')}.${detail.mime === 'image/png' ? 'png' : 'jpg'}`;
    setExporting(true);
    try {
      const href = hasTrim(trim)
        ? await trimmedDataUrl(libraryImageUrl(detail.id, 'image'), trim, detail.mime)
        : libraryImageUrl(detail.id, 'image');
      const link = document.createElement('a');
      link.download = name;
      link.href = href;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    } catch (err: any) {
      setError(err?.message || t('Download failed.'));
    } finally {
      setExporting(false);
    }
  };

  /** Flips the open record's approval on the server and in every place it shows. */
  const toggleDetailApproved = async () => {
    if (!detail) return;
    setApproving(true);
    try {
      const updated = await setGenerationApproved(detail.id, !detail.approved);
      setItems((prev) =>
        prev
          .map((r) => (r.id === updated.id ? updated : r))
          // Under "Approved only", a withdrawn approval leaves the page.
          .filter((r) => !filters.approved || r.approved)
      );
      setDetail(updated);
    } catch (err: any) {
      setError(err?.message || t('Approval failed.'));
    } finally {
      setApproving(false);
    }
  };

  const removeDetail = async () => {
    if (!detail) return;
    setDeleting(true);
    try {
      await deleteGeneration(detail.id);
      setItems((prev) => prev.filter((r) => r.id !== detail.id));
      setTotal((t) => (t === null ? t : Math.max(0, t - 1)));
      setDetail(null);
    } catch (err: any) {
      setError(err?.message || t('Delete failed.'));
    } finally {
      setDeleting(false);
      setConfirmingDelete(false);
    }
  };

  return (
    <div className="w-full">
      {/* ---- toolbar -------------------------------------------------- */}
      <div className="bg-white border border-gray-200 rounded-2xl p-4 sm:p-5 shadow-sm mb-6 space-y-4">
        <div className="flex flex-col sm:flex-row gap-3 sm:items-center">
          <div className="relative flex-grow">
            <Search className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={searchDraft}
              onChange={(e) => setSearchDraft(e.target.value)}
              placeholder={t("Search product, number, brand, colour, shot…")}
              className="w-full pl-9 pr-9 py-2.5 rounded-xl border border-gray-200 bg-gray-50 text-sm focus:outline-none focus:ring-2 focus:ring-yellow-400/60 focus:bg-white transition-colors"
            />
            {searchDraft && (
              <button
                onClick={() => setSearchDraft('')}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 p-0.5 text-gray-400 hover:text-gray-700 cursor-pointer"
                aria-label={t("Clear search")}
              >
                <X className="w-4 h-4" />
              </button>
            )}
          </div>

          <label className="flex items-center gap-2 shrink-0">
            <span className="text-[11px] font-bold uppercase tracking-wide text-gray-500">{t("Sort")}</span>
            <select
              value={filters.sort}
              onChange={(e) => setFilter({ sort: e.target.value as Filters['sort'] })}
              className="px-2.5 py-2 rounded-xl border border-gray-200 bg-white text-sm cursor-pointer focus:outline-none focus:ring-2 focus:ring-yellow-400/60"
            >
              <option value="newest">{t("Newest first")}</option>
              <option value="oldest">{t("Oldest first")}</option>
            </select>
          </label>
        </div>

        <div className="grid grid-flow-row-dense grid-cols-2 sm:grid-cols-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1.8fr)_auto] gap-3">
          <FilterSelect label={t("Category")} value={filters.category} options={facets?.categories || []} onChange={(v) => setFilter({ category: v })} />
          <FilterSelect label={t("Product / Outfit")} value={filters.unit} options={facets?.units || []} onChange={(v) => setFilter({ unit: v })} />
          <FilterSelect label={t("Shot / Angle")} value={filters.style} options={facets?.styles || []} onChange={(v) => setFilter({ style: v })} />
          <div className="flex flex-col gap-1 min-w-0 col-span-2 lg:col-span-1">
            <span className="text-[11px] font-bold uppercase tracking-wide text-gray-500">{t("Date range")}</span>
            <div className="flex items-center gap-1.5 min-w-0">
              <input type="date" value={filters.from} onChange={(e) => setFilter({ from: e.target.value })} aria-label={t("From date")}
                className="flex-1 min-w-0 px-2.5 py-2 rounded-xl border border-gray-200 bg-white text-sm focus:outline-none focus:ring-2 focus:ring-yellow-400/60" />
              <span className="text-gray-400 text-sm shrink-0" aria-hidden="true">–</span>
              <input type="date" value={filters.to} onChange={(e) => setFilter({ to: e.target.value })} aria-label={t("To date")}
                className="flex-1 min-w-0 px-2.5 py-2 rounded-xl border border-gray-200 bg-white text-sm focus:outline-none focus:ring-2 focus:ring-yellow-400/60" />
            </div>
          </div>
          <label className="flex flex-col gap-1 min-w-0 cursor-pointer select-none lg:pl-1">
            <span className="text-[11px] font-bold uppercase tracking-wide text-gray-500">{t("Approved")}</span>
            <span className="flex items-center gap-2 h-[38px]">
              <input
                type="checkbox"
                checked={filters.approved}
                onChange={(e) => setFilter({ approved: e.target.checked })}
                aria-label={t("Approved only")}
                title={t("Show approved generations only")}
                className="w-4 h-4 accent-emerald-500 cursor-pointer"
              />
              {typeof facets?.approved === 'number' && (
                <span className="text-xs text-gray-500 tabular-nums whitespace-nowrap">{facets.approved}</span>
              )}
            </span>
          </label>
        </div>

        {(activeChips.length > 0 || total !== null) && (
          <div className="flex flex-wrap items-center gap-2 pt-1">
            {activeChips.map((chip) => (
              <button
                key={chip.key}
                onClick={() => {
                  if (chip.key === 'q') setSearchDraft('');
                  setFilter({ [chip.key]: EMPTY_FILTERS[chip.key] } as Partial<Filters>);
                }}
                className="flex items-center gap-1 px-2.5 py-1 rounded-full bg-yellow-400/20 border border-yellow-400/50 text-xs font-semibold text-yellow-950 hover:bg-yellow-400/30 cursor-pointer"
              >
                {chip.label}
                <X className="w-3 h-3" />
              </button>
            ))}
            {activeChips.length > 0 && (
              <button onClick={clearAll} className="text-xs font-semibold text-gray-500 hover:text-gray-800 underline cursor-pointer">
                {t("Clear all")}
              </button>
            )}
            <span className="ml-auto text-xs text-gray-400 flex items-center gap-1.5">
              <Filter className="w-3.5 h-3.5" />
              {total !== null ? `${total} generation${total === 1 ? '' : 's'} stored` : `${items.length}${nextCursor ? '+' : ''} match${items.length === 1 && !nextCursor ? '' : 'es'}`}
            </span>
          </div>
        )}
      </div>

      {/* ---- states --------------------------------------------------- */}
      {error && (
        <div className="mb-6 p-4 rounded-2xl border border-red-200 bg-red-50 text-sm text-red-800 flex items-center justify-between gap-3">
          <span>{error}</span>
          <button
            onClick={() => void loadFirstPage(filters)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-white border border-red-200 font-semibold hover:bg-red-100 cursor-pointer shrink-0"
          >
            <RefreshCw className="w-3.5 h-3.5" /> {t("Retry")}
          </button>
        </div>
      )}

      {loading ? (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="rounded-2xl border border-gray-200 bg-white overflow-hidden">
              <div className="aspect-[3/4] bg-gray-100 animate-pulse" />
              <div className="p-3 space-y-2">
                <div className="h-3.5 w-3/4 bg-gray-100 rounded animate-pulse" />
                <div className="h-3 w-1/2 bg-gray-100 rounded animate-pulse" />
              </div>
            </div>
          ))}
        </div>
      ) : items.length === 0 && !error ? (
        <div className="flex flex-col items-center justify-center py-24 text-center">
          <div className="w-16 h-16 rounded-2xl bg-yellow-400/15 border border-yellow-400/40 flex items-center justify-center mb-4">
            <Images className="w-8 h-8 text-yellow-600" />
          </div>
          <h3 className="font-bold text-gray-900">
            {activeChips.length ? t('Nothing matches these filters') : t('Nothing in the Library yet')}
          </h3>
          <p className="text-sm text-gray-500 mt-1 max-w-sm">
            {activeChips.length
              ? t('Try removing a filter or clearing the search.')
              : t('Every image you generate in the Studio is saved here automatically.')}
          </p>
          {activeChips.length > 0 && (
            <button onClick={clearAll} className="mt-4 px-4 py-2 rounded-xl bg-yellow-400 hover:bg-yellow-300 text-sm font-bold text-black cursor-pointer">
              {t("Clear filters")}
            </button>
          )}
        </div>
      ) : (
        <>
          {/* ---- product grid ---------------------------------------- */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
            {items.map((record) => (
              <button
                key={record.id}
                onClick={() => setDetail(record)}
                className="group text-left rounded-2xl border border-gray-200 bg-white overflow-hidden shadow-sm hover:shadow-md hover:border-yellow-400/60 transition-all cursor-pointer focus:outline-none focus:ring-2 focus:ring-yellow-400/60"
              >
                <div className="relative aspect-[3/4] overflow-hidden bg-gray-100">
                  <CardImage id={record.id} kind="thumb" alt={record.product?.name || record.styleLabel || t('Generated image')} />
                  {record.approved && (
                    <span className="absolute top-2 left-2 flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-emerald-500 text-white text-[10px] font-bold shadow">
                      <CheckCircle2 className="w-3 h-3" strokeWidth={3} /> APPROVED
                    </span>
                  )}
                </div>
                <div className="p-3">
                  <div className="flex items-start justify-between gap-2">
                    <h3 className="font-bold text-sm text-gray-900 truncate">
                      {record.unitLabel || record.product?.name || t('Manual upload')}
                    </h3>
                    {record.product?.category && (
                      <span className="shrink-0 px-1.5 py-0.5 rounded-md bg-gray-100 border border-gray-200 text-[10px] font-bold text-gray-600 uppercase">
                        {record.product.category}
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-gray-500 truncate mt-0.5">
                    {[record.unitLabel ? record.product?.name : null, record.product?.brand, record.product?.colour]
                      .filter(Boolean)
                      .join(' · ') || (record.source ? sourceLabel(record.source) : record.model || '—')}
                  </p>
                  <div className="flex items-center justify-between mt-2 text-[11px] text-gray-400">
                    <span className="px-1.5 py-0.5 rounded bg-yellow-400/15 border border-yellow-400/30 text-yellow-900 font-semibold truncate max-w-[55%]">
                      {record.styleLabel || record.styleId || 'shot'}
                    </span>
                    <span className="flex items-center gap-1 shrink-0">
                      <Calendar className="w-3 h-3" />
                      {formatDate(record.createdAt).split(',')[0]}
                    </span>
                  </div>
                </div>
              </button>
            ))}
          </div>

          {/* Sentinel for infinite scroll; button fallback for odd viewports. */}
          <div ref={sentinelRef} className="flex justify-center py-8">
            {loadingMore ? (
              <span className="flex items-center gap-2 text-sm text-gray-500">
                <Loader2 className="w-4 h-4 animate-spin" /> {t("Loading more…")}
              </span>
            ) : nextCursor ? (
              <button onClick={() => void loadMore()} className="px-4 py-2 rounded-xl border border-gray-200 bg-white text-sm font-semibold text-gray-700 hover:border-yellow-400/60 cursor-pointer">
                {t("Load more")}
              </button>
            ) : (
              items.length > 0 && <span className="text-xs text-gray-400">{t("End of the Library")}</span>
            )}
          </div>
        </>
      )}

      {/* ---- detail view ---------------------------------------------- */}
      {detail && (
        <div
          className="fixed inset-0 z-[80] bg-black/60 backdrop-blur-sm flex items-center justify-center p-3 sm:p-6"
          onClick={() => setDetail(null)}
        >
          <div
            className="bg-white rounded-2xl shadow-2xl w-full max-w-4xl max-h-[92vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="sticky top-0 z-10 flex items-center justify-between gap-3 px-5 py-3.5 bg-white border-b border-gray-200">
              <div className="min-w-0">
                <h3 className="font-bold text-gray-900 truncate">
                  {detail.unitLabel || detail.product?.name || t('Manual upload')}
                  {detail.styleLabel ? ` — ${detail.styleLabel}` : ''}
                </h3>
                <p className="text-xs text-gray-400">{formatDate(detail.createdAt)}</p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  onClick={() => void toggleDetailApproved()}
                  disabled={approving}
                  title={detail.approved ? t('Approved — click to withdraw') : t('Approve this render')}
                  className={`px-3 py-2 rounded-xl text-xs font-bold flex items-center gap-1.5 cursor-pointer disabled:opacity-60 ${
                    detail.approved
                      ? 'bg-emerald-50 text-emerald-700 border border-emerald-300 hover:bg-emerald-100'
                      : 'bg-emerald-500 text-white hover:bg-emerald-600'
                  }`}
                >
                  <CheckCircle2 className="w-4 h-4" />
                  {approving ? t('Saving…') : detail.approved ? t('Approved ✓') : t('Approve')}
                </button>
                <button onClick={() => void downloadDetail()} disabled={exporting}
                  title={hasTrim(trim) ? t('Download the trimmed picture') : t('Download full size')}
                  className="p-2 rounded-xl border border-gray-200 text-gray-600 hover:border-yellow-400/60 hover:text-gray-900 cursor-pointer disabled:opacity-60">
                  {exporting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
                </button>
                {confirmingDelete ? (
                  <button onClick={() => void removeDetail()} disabled={deleting}
                    className="px-3 py-2 rounded-xl bg-red-600 text-white text-xs font-bold hover:bg-red-500 cursor-pointer disabled:opacity-60">
                    {deleting ? t('Deleting…') : t('Confirm delete')}
                  </button>
                ) : (
                  <button onClick={() => setConfirmingDelete(true)} title={t("Delete from Library")}
                    className="p-2 rounded-xl border border-gray-200 text-gray-600 hover:border-red-300 hover:text-red-600 cursor-pointer">
                    <Trash2 className="w-4 h-4" />
                  </button>
                )}
                <button onClick={() => setDetail(null)} aria-label={t("Close")}
                  className="p-2 rounded-xl text-gray-400 hover:text-gray-800 hover:bg-gray-100 cursor-pointer">
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>

            <div className="grid md:grid-cols-[1fr_280px] gap-0">
              <div className="bg-gray-950 flex flex-col items-center justify-center gap-2.5 min-h-[300px] p-3">
                {detailImageBroken ? (
                  <div className="w-full min-h-[300px]">
                    <CardImage id={detail.id} kind="image" alt={detail.product?.name || t('Generated image')} />
                  </div>
                ) : (
                  <TrimCropFrame
                    key={detail.id}
                    src={libraryImageUrl(detail.id, 'image')}
                    alt={detail.product?.name || t('Generated image')}
                    trim={trim}
                    onTrimChange={setTrim}
                    onError={() => setDetailImageBroken(true)}
                    imgClassName="max-h-[70vh]"
                  />
                )}
                {!detailImageBroken && (
                  <div className="flex items-center gap-2 text-[11px] text-gray-400">
                    {hasTrim(trim) ? (
                      <>
                        <span>{describeTrim(trim)} — the download keeps the cut</span>
                        <button
                          onClick={() => setTrim(NO_TRIM)}
                          className="flex items-center gap-1 px-2 py-0.5 rounded-full border border-gray-700 text-gray-300 hover:text-white hover:border-yellow-400/60 cursor-pointer"
                        >
                          <RotateCcw className="w-3 h-3" />
                          {t("Reset")}
                        </button>
                      </>
                    ) : (
                      <span>{t("Drag the yellow edges to trim the top and bottom")}</span>
                    )}
                  </div>
                )}
              </div>

              <aside className="p-5 space-y-4 text-sm">
                {detail.product && (
                  <div>
                    <h4 className="text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1.5">{t("Product")}</h4>
                    <dl className="space-y-1">
                      {([
                        ['Name', detail.product.name],
                        ['Brand', detail.product.brand],
                        ['Category', detail.product.category],
                        ['Colour', detail.product.colour],
                        ['Description', detail.product.description],
                      ] as const).filter(([, v]) => v).map(([k, v]) => (
                        <div key={k} className="flex gap-2">
                          <dt className="w-20 shrink-0 text-gray-400">{t(k)}</dt>
                          <dd className="text-gray-800 break-words min-w-0">{v}</dd>
                        </div>
                      ))}
                    </dl>
                  </div>
                )}

                <div>
                  <h4 className="text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1.5">{t("Generation")}</h4>
                  <dl className="space-y-1">
                    {([
                      ['Number', detail.unitLabel],
                      ['Source', detail.source ? sourceLabel(detail.source) : null],
                      ['Shot', detail.styleLabel || detail.styleId],
                      ['Provider', detail.provider],
                      ['Model', detail.model],
                      ['Quality', detail.quality],
                      ['Scene', detail.sceneMode],
                    ] as const).filter(([, v]) => v).map(([k, v]) => (
                      <div key={k} className="flex gap-2">
                        <dt className="w-20 shrink-0 text-gray-400">{t(k)}</dt>
                        <dd className="text-gray-800 break-words min-w-0">{v}</dd>
                      </div>
                    ))}
                  </dl>
                </div>

                {detail.prompt && (
                  <div>
                    <h4 className="text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1.5">{t("Prompt")}</h4>
                    <p className="text-xs text-gray-600 whitespace-pre-wrap break-words max-h-40 overflow-y-auto rounded-xl bg-gray-50 border border-gray-200 p-2.5">
                      {detail.prompt}
                    </p>
                  </div>
                )}
              </aside>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
