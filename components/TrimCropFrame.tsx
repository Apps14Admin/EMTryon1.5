import React, { useEffect, useRef, useState } from 'react';
import { useT } from '../services/uiPrefs';
import { type Trim, type TrimHandle, moveTrimHandle, pointerPercent } from '../services/trimCrop';

/**
 * The cutting edge, as a picture frame: the render with a draggable yellow
 * line at its top and bottom. Everything outside the lines is dimmed, and the
 * trim is reported up as percentages of the picture's height so the caller
 * can cut the real bytes with `renderTrimmed`.
 *
 * The frame sizes itself to the picture (an inline block around the <img>),
 * so a percent of the frame is a percent of the picture — no letterboxing to
 * account for.
 */
export interface TrimCropFrameProps {
  src: string;
  alt: string;
  trim: Trim;
  onTrimChange: (trim: Trim) => void;
  onError?: () => void;
  onImageClick?: () => void;
  /** Sizing for the <img>; the frame follows it. */
  imgClassName?: string;
}

const KEY_STEP = 1;
const KEY_STEP_LARGE = 5;

export const TrimCropFrame: React.FC<TrimCropFrameProps> = ({
  src, alt, trim, onTrimChange, onError, onImageClick, imgClassName = '',
}) => {
  const t = useT();
  const boxRef = useRef<HTMLDivElement>(null);
  const trimRef = useRef(trim);
  trimRef.current = trim;
  const [active, setActive] = useState<TrimHandle | null>(null);

  useEffect(() => {
    if (!active) return;
    const moveTo = (clientY: number) => {
      const box = boxRef.current;
      if (!box) return;
      onTrimChange(moveTrimHandle(trimRef.current, active, pointerPercent(clientY, box.getBoundingClientRect())));
    };
    const onMouseMove = (e: MouseEvent) => moveTo(e.clientY);
    const onTouchMove = (e: TouchEvent) => {
      if (e.touches.length === 0) return;
      if (e.cancelable) e.preventDefault();
      moveTo(e.touches[0].clientY);
    };
    const end = () => setActive(null);
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', end);
    window.addEventListener('touchmove', onTouchMove, { passive: false });
    window.addEventListener('touchend', end);
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', end);
      window.removeEventListener('touchmove', onTouchMove);
      window.removeEventListener('touchend', end);
    };
  }, [active, onTrimChange]);

  const nudge = (handle: TrimHandle, e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault();
    const step = e.shiftKey ? KEY_STEP_LARGE : KEY_STEP;
    const down = e.key === 'ArrowDown';
    // The top line moves with the arrow; the bottom line is measured from the
    // bottom edge, so "down" means a smaller cut there.
    const pointerPct = handle === 'top'
      ? trim.top + (down ? step : -step)
      : 100 - (trim.bottom + (down ? -step : step));
    onTrimChange(moveTrimHandle(trim, handle, pointerPct));
  };

  const handleClass = 'absolute left-0 right-0 h-16 flex items-center z-30 cursor-ns-resize group outline-none focus-visible:ring-2 focus-visible:ring-yellow-400/80';
  const grip = (
    <>
      <div className="w-full h-0.5 bg-yellow-400 shadow-sm" />
      <div className="absolute left-4 w-10 h-10 bg-white text-gray-700 rounded-full flex items-center justify-center border border-gray-200 shadow-md active:scale-105 transition-transform group-hover:border-yellow-500 group-focus-visible:border-yellow-500">
        <div className="w-4 h-0.5 bg-gray-400 group-hover:bg-yellow-500 rounded-full transition-colors" />
      </div>
    </>
  );

  return (
    <div
      ref={boxRef}
      className="relative inline-block max-w-full overflow-hidden rounded-xl select-none touch-none"
      style={{ touchAction: 'none' }}
    >
      <img
        src={src}
        alt={alt}
        draggable={false}
        onError={onError}
        onClick={onImageClick}
        className={`block max-w-full ${onImageClick ? 'cursor-zoom-in' : ''} ${imgClassName}`}
        style={{ clipPath: `inset(${trim.top}% 0 ${trim.bottom}% 0)` }}
      />

      <div className="absolute inset-0 pointer-events-none">
        <div className="absolute top-0 left-0 right-0 bg-black/70" style={{ height: `${trim.top}%` }} />
        <div className="absolute bottom-0 left-0 right-0 bg-black/70" style={{ height: `${trim.bottom}%` }} />
      </div>

      <div
        className={`${handleClass} -mt-8`}
        style={{ top: `${trim.top}%` }}
        role="slider"
        tabIndex={0}
        aria-label={t("Trim from the top")}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(trim.top)}
        onMouseDown={(e) => { e.preventDefault(); setActive('top'); }}
        onTouchStart={() => setActive('top')}
        onKeyDown={(e) => nudge('top', e)}
      >
        {grip}
      </div>

      <div
        className={`${handleClass} -mb-8`}
        style={{ bottom: `${trim.bottom}%` }}
        role="slider"
        tabIndex={0}
        aria-label={t("Trim from the bottom")}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(trim.bottom)}
        onMouseDown={(e) => { e.preventDefault(); setActive('bottom'); }}
        onTouchStart={() => setActive('bottom')}
        onKeyDown={(e) => nudge('bottom', e)}
      >
        {grip}
      </div>
    </div>
  );
};
