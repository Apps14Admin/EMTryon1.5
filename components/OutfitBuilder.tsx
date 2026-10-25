import React, { useEffect, useMemo, useState } from 'react';
import { Copy, Trash2, Layers, X, Shirt } from 'lucide-react';
import type { ProductGroup } from '../services/productGrouper';
import { MANUAL_PRODUCT, outfitLine, slotOfGroup, type OutfitSpec, type SlotName } from '../services/batchRunner';
import { useT } from '../services/uiPrefs';
import {
  OUTFIT_DRAG_MIME,
  clearSlot,
  dragFor,
  frontImageOf,
  manualDrag,
  placeInOutfit,
  readDrag,
  type OutfitDrag,
} from '../services/outfitBoard';

/**
 * OUTFIT MODE — a shelf and a ruled page.
 *
 *   ┌ Products ─────┐  ┌ Outfits ──────────────────────────────┐
 *   │ tops    [▣]   │  │ Outfit 1  [▣] [▣] [▢]  ______________ │
 *   │ bottoms [▣]   │  │ Outfit 2  [▢] [▢] [▢]  ______________ │
 *   │ shoes   [▣]   │  │ Outfit 3  [▢] [▢] [▢]  ______________ │
 *   └───────────────┘  └───────────────────────────────────────┘
 *
 * The shelf shows every folder product once, by its front photo, as a small
 * tile. The page is ruled: it always shows at least three lines and always
 * one empty line after the last outfit, like a notebook. Each line has three
 * small slots — shirt, pants, shoes — the same size as the shelf tiles. The
 * user drags a tile onto a line; it lands in the slot its category owns
 * whichever part of the line it was dropped on, replacing what was there.
 * Dropping on an empty line makes that outfit. The same product may sit on as
 * many lines as wanted. Dragging out of one line onto another moves it.
 * Nothing here decides what goes with what.
 *
 * Click works too, for touch and for anyone who dislikes dragging: click a
 * tile to pick it up, click a line to put it down.
 */

interface OutfitBuilderProps {
  groups: ProductGroup[];
  outfits: OutfitSpec[];
  onChange: (outfits: OutfitSpec[]) => void;
  /** A small copy of a folder photo, by its id. */
  thumbOf: (imageId: string) => string;
  /** Which manual strips hold a garment, so the shelf can offer them too. */
  manual?: Record<SlotName, boolean>;
  disabled?: boolean;
}

const SLOTS: { slot: SlotName; label: string; short: string }[] = [
  { slot: 'top', label: 'Shirt / Top', short: 'shirt' },
  { slot: 'bottoms', label: 'Pants / Bottoms', short: 'pants' },
  { slot: 'footwear', label: 'Shoes', short: 'shoes' },
];

/** The page never shows fewer lines than this. */
const MIN_LINES = 3;

/** Ids of the empty lines after the last outfit; a drop on one makes the outfit. */
const GHOST = '__new__:';
const isGhost = (id: string) => id.startsWith(GHOST);

let seq = 0;
const newOutfit = (name: string): OutfitSpec => ({
  id: `outfit-${Date.now().toString(36)}-${(seq += 1)}`,
  name,
  footwear: null,
  bottoms: null,
  top: null,
});

/** "Outfit 1", "Outfit 2"… the next unused number. */
const nextName = (outfits: OutfitSpec[]): string => {
  const used = new Set(outfits.map((o) => o.name));
  let n = outfits.length + 1;
  while (used.has(`Outfit ${n}`)) n += 1;
  return `Outfit ${n}`;
};

const sameDrag = (a: OutfitDrag | null, b: OutfitDrag): boolean =>
  !!a && a.product === b.product && a.slot === b.slot && a.from === b.from;

/** One 64px square, shared by shelf tiles and line slots so they read as the same thing. */
const SQUARE = 'w-16 h-16 rounded-md overflow-hidden flex items-center justify-center';

export const OutfitBuilder: React.FC<OutfitBuilderProps> = ({
  groups,
  outfits,
  onChange,
  thumbOf,
  manual = { top: false, bottoms: false, footwear: false },
  disabled = false,
}) => {
  const t = useT();
  /** The drag in flight. dataTransfer cannot be read during dragover, so it lives here. */
  const [dragging, setDragging] = useState<OutfitDrag | null>(null);
  /** The product picked up by click, waiting for a line to be clicked. */
  const [picked, setPicked] = useState<OutfitDrag | null>(null);
  /** Which line the drag is over: an outfit id, or a ghost id. */
  const [overId, setOverId] = useState<string | null>(null);

  const byId = useMemo(() => new Map(groups.map((g) => [g.id, g])), [groups]);
  const bySlot = (slot: SlotName) => groups.filter((g) => slotOfGroup(g) === slot);

  useEffect(() => {
    if (!picked) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPicked(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [picked]);

  // --- mutations -----------------------------------------------------------

  const duplicate = (id: string) => {
    const source = outfits.find((o) => o.id === id);
    if (!source) return;
    const copy = { ...newOutfit(nextName(outfits)), footwear: source.footwear, bottoms: source.bottoms, top: source.top };
    const at = outfits.findIndex((o) => o.id === id);
    onChange([...outfits.slice(0, at + 1), copy, ...outfits.slice(at + 1)]);
  };

  const remove = (id: string) => onChange(outfits.filter((o) => o.id !== id));

  const rename = (id: string, name: string) => onChange(outfits.map((o) => (o.id === id ? { ...o, name } : o)));

  /** Put a product on a line — on a ghost line, that makes the outfit first. */
  const place = (targetId: string, drag: OutfitDrag) => {
    if (isGhost(targetId)) {
      const fresh = newOutfit(nextName(outfits));
      onChange(placeInOutfit([...outfits, fresh], fresh.id, drag));
    } else {
      onChange(placeInOutfit(outfits, targetId, drag));
    }
  };

  // --- drag plumbing -------------------------------------------------------

  const startDrag = (e: React.DragEvent, drag: OutfitDrag) => {
    e.dataTransfer.setData(OUTFIT_DRAG_MIME, JSON.stringify(drag));
    e.dataTransfer.effectAllowed = drag.from ? 'move' : 'copy';
    setDragging(drag);
    setPicked(null);
  };

  const endDrag = () => {
    setDragging(null);
    setOverId(null);
  };

  const allowDrop = (e: React.DragEvent, id: string) => {
    if (!dragging && !e.dataTransfer.types.includes(OUTFIT_DRAG_MIME)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = dragging?.from ? 'move' : 'copy';
    if (overId !== id) setOverId(id);
  };

  const leaveDrop = (e: React.DragEvent) => {
    // Children fire leave as the cursor crosses them; only a real exit counts.
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    setOverId(null);
  };

  const drop = (e: React.DragEvent, id: string) => {
    e.preventDefault();
    const drag = dragging ?? readDrag(e.dataTransfer.getData(OUTFIT_DRAG_MIME));
    endDrag();
    if (drag) place(id, drag);
  };

  /** Click fallback: a line click puts down whatever was picked up. */
  const clickLine = (id: string) => {
    if (!picked) return;
    place(id, picked);
    setPicked(null);
  };

  const lineProps = (id: string) => ({
    onDragEnter: (e: React.DragEvent) => allowDrop(e, id),
    onDragOver: (e: React.DragEvent) => allowDrop(e, id),
    onDragLeave: leaveDrop,
    onDrop: (e: React.DragEvent) => drop(e, id),
    onClick: () => clickLine(id),
  });

  // --- pieces --------------------------------------------------------------
  // Plain render functions, not nested components: a component declared inside
  // the render would get a new identity on every state change, and the first
  // setState of a drag would unmount the very element being dragged, which
  // ends the drag on the spot.

  const renderTile = ({ key, drag, src, label }: { key: string; drag: OutfitDrag; src: string | null; label: string }) => {
    const active = sameDrag(picked, drag);
    return (
      <button
        key={key}
        type="button"
        draggable
        onDragStart={(e) => startDrag(e, drag)}
        onDragEnd={endDrag}
        onClick={() => setPicked(active ? null : drag)}
        title={active ? t('Picked up — click a line to place it. Esc to cancel.') : t('{label} — drag onto a line, or click to pick up', { label: t(label) })}
        aria-pressed={active}
        className={`w-16 text-left cursor-grab active:cursor-grabbing select-none group`}
      >
        <div
          className={`${SQUARE} border bg-gray-900 transition-all ${
            active ? 'border-yellow-500 ring-2 ring-yellow-300' : 'border-gray-200 group-hover:border-yellow-400 group-hover:shadow-sm'
          }`}
        >
          {src ? (
            <img src={src} alt={label} draggable={false} className="w-full h-full object-contain pointer-events-none" />
          ) : (
            <Shirt className="w-5 h-5 text-gray-400" />
          )}
        </div>
        <p className="text-[9px] font-bold text-gray-700 truncate mt-0.5 leading-tight text-center">{t(label)}</p>
      </button>
    );
  };

  /** One slot on a line: the front photo when filled, a dashed square naming the slot when not. */
  const renderSlot = ({ key, outfit, slot, label }: { key: string; outfit: OutfitSpec | null; slot: SlotName; label: string }) => {
    const value = outfit?.[slot] ?? null;
    const isManual = value === MANUAL_PRODUCT;
    const chosen = value && !isManual ? byId.get(value) ?? null : null;
    const filled = !!value;
    const image = chosen ? frontImageOf(chosen) : null;
    const src = image ? thumbOf(image) : '';
    const lineId = outfit?.id ?? null;
    const willLand = !!lineId && overId === lineId && dragging?.slot === slot;
    const outDrag: OutfitDrag | null =
      !outfit || !value ? null : isManual ? manualDrag(slot, outfit.id) : chosen ? dragFor(chosen, outfit.id) : null;
    const name = chosen ? chosen.name : isManual ? t('Manual upload') : null;

    return (
      <div key={key} className="relative w-16 shrink-0">
        <div
          draggable={!!outDrag}
          onDragStart={outDrag ? (e) => startDrag(e, outDrag) : undefined}
          onDragEnd={outDrag ? endDrag : undefined}
          title={name ? t('{name} — drag to another line to move it', { name }) : t('{label}: empty — this slot is rendered plain and unbranded', { label: t(label) })}
          className={`${SQUARE} border transition-all ${
            willLand
              ? 'border-yellow-500 ring-2 ring-yellow-300 bg-yellow-50'
              : filled
                ? 'bg-gray-900 border-gray-200 cursor-grab active:cursor-grabbing'
                : 'bg-gray-50 border-dashed border-gray-300'
          }`}
        >
          {src ? (
            <img src={src} alt={name ?? ''} draggable={false} className="w-full h-full object-contain pointer-events-none" />
          ) : (
            <span
              className={`text-[9px] font-bold uppercase tracking-wide text-center leading-tight px-1 select-none ${
                isManual ? 'text-gray-200' : 'text-gray-400'
              }`}
            >
              {isManual ? t('manual') : t(label)}
            </span>
          )}
        </div>
        {filled && outfit && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onChange(clearSlot(outfits, outfit.id, slot));
            }}
            title={t("Remove — this slot is then rendered plain")}
            aria-label={t('Remove {label} from {outfit}', { label: t(label), outfit: outfit.name })}
            className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full bg-white border border-gray-300 shadow-sm text-gray-500 hover:text-red-600 hover:border-red-300 flex items-center justify-center cursor-pointer"
          >
            <X className="w-2.5 h-2.5" />
          </button>
        )}
        <p className="text-[9px] text-gray-500 truncate mt-0.5 leading-tight text-center min-h-[11px]">{name ?? ''}</p>
      </div>
    );
  };

  /** A line: name, three slots, a one-line summary, actions. Ghost lines are empty and unnamed until dropped on. */
  const renderLine = ({ key, outfit, index }: { key: string; outfit: OutfitSpec | null; index: number }) => {
    const id = outfit?.id ?? `${GHOST}${index}`;
    const over = overId === id;
    return (
      <li
        key={key}
        {...lineProps(id)}
        className={`flex items-center gap-3 px-3 py-2 border-b border-gray-200 transition-colors ${
          over ? 'bg-yellow-50' : picked ? 'hover:bg-yellow-50/50 cursor-copy' : ''
        }`}
      >
        {outfit ? (
          <input
            value={outfit.name}
            onChange={(e) => rename(outfit.id, e.target.value)}
            onClick={(e) => e.stopPropagation()}
            className="w-20 shrink-0 text-xs font-bold text-gray-900 bg-transparent border-b border-transparent focus:border-yellow-400 outline-none"
            aria-label={t("Outfit name")}
          />
        ) : (
          <span className="w-20 shrink-0 text-xs font-bold text-gray-400 select-none">Outfit {index + 1}</span>
        )}

        <div className="flex gap-2 shrink-0">
          {SLOTS.map(({ slot, short }) => renderSlot({ key: slot, outfit, slot, label: short }))}
        </div>

        <p className="flex-1 min-w-0 text-[10px] text-gray-500 truncate">
          {outfit ? outfitLine(outfit, groups) : over ? t('Drop to start this outfit') : ''}
        </p>

        {outfit && (
          <div className="flex items-center gap-0.5 shrink-0">
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                duplicate(outfit.id);
              }}
              title={t("Duplicate this outfit")}
              className="p-1 rounded-md text-gray-400 hover:text-gray-900 hover:bg-gray-100 cursor-pointer"
            >
              <Copy className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                remove(outfit.id);
              }}
              title={t("Remove this outfit")}
              className="p-1 rounded-md text-gray-400 hover:text-red-600 hover:bg-red-50 cursor-pointer"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          </div>
        )}
      </li>
    );
  };

  const pickedLabel = picked
    ? picked.product === MANUAL_PRODUCT
      ? t('the manual upload')
      : byId.get(picked.product)?.name ?? t('the product')
    : null;

  // At least MIN_LINES lines, and always one empty line after the last outfit.
  const lines: (OutfitSpec | null)[] = [...outfits];
  while (lines.length < Math.max(MIN_LINES, outfits.length + 1)) lines.push(null);

  const box = 'bg-white rounded-xl border border-yellow-300 overflow-hidden';

  return (
    <div className={`grid grid-cols-1 md:grid-cols-[236px_minmax(0,1fr)] gap-3 ${disabled ? 'opacity-60 pointer-events-none' : ''}`}>
      {/* SHELF — every product once, by its front photo. */}
      <aside className={`${box} min-w-0`}>
        <div className="px-3 py-2.5 border-b border-gray-100">
          <p className="text-xs font-bold text-gray-900">{t("Products")}</p>
          <p className="text-[11px] text-gray-500 mt-0.5">{t("Drag onto a line. One product can go on many lines.")}</p>
        </div>
        <div className="p-3 space-y-3 max-h-[560px] overflow-y-auto">
          {SLOTS.map(({ slot, label }) => {
            const items = bySlot(slot);
            const hasManual = manual[slot];
            return (
              <section key={slot}>
                <p className="text-[10px] font-bold text-gray-500 uppercase tracking-wide mb-1.5">
                  {t(label)}
                  <span className="ml-1 font-medium text-gray-400 normal-case">{items.length + (hasManual ? 1 : 0)}</span>
                </p>
                {items.length === 0 && !hasManual ? (
                  <p className="text-[10px] text-gray-400">{t("None in this folder — set a product's category in Review.")}</p>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {items.map((g) => {
                      const image = frontImageOf(g);
                      return renderTile({ key: g.id, drag: dragFor(g), src: image ? thumbOf(image) : null, label: g.name });
                    })}
                    {hasManual && renderTile({ key: 'manual', drag: manualDrag(slot), src: null, label: t('Manual upload') })}
                  </div>
                )}
              </section>
            );
          })}
        </div>
      </aside>

      {/* PAGE — one ruled line per outfit, three slots per line. */}
      <div className={`${box} min-w-0`}>
        <div className="px-3 py-2.5 border-b border-gray-100">
          <p className="text-xs font-bold text-gray-900 flex items-center gap-1.5">
            <Layers className="w-3.5 h-3.5 text-yellow-600 shrink-0" />
            <span>{t("Outfits")}</span>
          </p>
          <p className="text-[11px] text-gray-500 mt-0.5">
            {pickedLabel
              ? `Click a line to place ${pickedLabel} · Esc to cancel`
              : t('Drop a product anywhere on a line — it takes its own slot. Empty slots are rendered plain and unbranded. One image per outfit per shot.')}
          </p>
        </div>
        <ul>{lines.map((outfit, index) => renderLine({ key: outfit?.id ?? `${GHOST}${index}`, outfit, index }))}</ul>
      </div>
    </div>
  );
};
