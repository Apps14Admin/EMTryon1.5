
import React, { useCallback, useState } from 'react';
import { Upload, X, Image as ImageIcon, HardDrive, RefreshCw } from 'lucide-react';
import { GoogleDrivePicker } from './GoogleDrivePicker';
import { useT } from '../services/uiPrefs';
import { prepareImageFile, formatBytes, PreparedImage } from '../services/imageUtils';

interface ImageInputProps {
  onImageSelected: (base64: string) => void;
  selectedImage: string | null;
  label?: string;
  /** One line explaining what this particular input is used for. */
  hint?: string;
  compact?: boolean;
  className?: string;
  icon?: React.ReactNode;
  /** Set false for inputs that must come from the user's own device only. */
  allowDrive?: boolean;
  /** Adds an explicit Replace control next to the existing remove button. */
  allowReplace?: boolean;
}

export const ImageInput: React.FC<ImageInputProps> = ({
  onImageSelected,
  selectedImage,
  label = "Upload Footwear / Gear",
  hint,
  compact = false,
  className = "",
  icon,
  allowDrive = true,
  allowReplace = false
}) => {
  const t = useT();
  const [isDragging, setIsDragging] = useState(false);
  const [isDrivePickerOpen, setIsDrivePickerOpen] = useState(false);
  const [meta, setMeta] = useState<PreparedImage | null>(null);
  const [busy, setBusy] = useState(false);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    processFile(file);
  };

  const processFile = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    try {
      // Downscaled here so large phone photos can't blow the request limit.
      const prepared = await prepareImageFile(file);
      setMeta(prepared);
      onImageSelected(prepared.base64);
    } finally {
      setBusy(false);
    }
  };

  const handleDriveImageSelected = (base64String: string, fileName: string) => {
    const base64Data = base64String.includes(',') ? base64String.split(',')[1] : base64String;
    onImageSelected(base64Data);
  };

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files[0];
    processFile(file);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  }, []);

  const minHeightClass = compact ? 'min-h-[110px]' : 'min-h-[130px] sm:min-h-[220px]';
  const paddingClass = compact ? 'p-2 sm:p-3' : 'p-2.5 sm:p-4';

  const containerClass = className ? className : `w-full h-full ${minHeightClass}`;

  const getImageSrc = (img: string | null) => {
    if (!img) return '';
    if (img.startsWith('http://') || img.startsWith('https://') || img.startsWith('data:') || img.startsWith('blob:')) {
      return img;
    }
    // Files served from /public are referenced by path, not base64.
    if (img.startsWith('/') && /\.(jpe?g|png|webp|gif|svg)$/i.test(img)) {
      return img;
    }
    return `data:image/png;base64,${img}`;
  };

  return (
    <div className={containerClass}>
      <div
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        className={`group/drop relative w-full h-full overflow-hidden border-2 border-dashed transition-all duration-300 flex flex-col items-center justify-center rounded-2xl cursor-pointer
          ${isDragging
            ? 'border-yellow-500 bg-yellow-100/70 scale-[1.02] shadow-lg shadow-yellow-500/25 ring-4 ring-yellow-400/30'
            : 'border-yellow-400/70 bg-gradient-to-br from-yellow-50 via-white to-amber-50 hover:border-yellow-500 hover:from-yellow-100 hover:to-amber-100 hover:shadow-lg hover:shadow-yellow-500/20 hover:-translate-y-0.5'}
          ${selectedImage ? 'border-none p-0 overflow-hidden bg-gray-900 shadow-sm hover:translate-y-0 hover:shadow-sm' : paddingClass}
        `}
      >
        {/* Sheen sweep on hover — draws the eye to the drop zone. */}
        {!selectedImage && (
          <span
            aria-hidden
            className="pointer-events-none absolute inset-0 -translate-x-full bg-gradient-to-r from-transparent via-white/70 to-transparent group-hover/drop:translate-x-full transition-transform duration-700 ease-out"
          />
        )}
        {selectedImage ? (
          <div className="relative w-full h-full flex items-center justify-center bg-gray-900 group">
            <img 
              src={getImageSrc(selectedImage)} 
              alt={t("Selected item")} 
              className="max-h-full max-w-full object-contain p-2 transition-transform duration-300 group-hover:scale-102"
            />
            <div className="absolute top-2.5 right-2.5 flex items-center gap-1.5 z-10">
              {allowReplace && (
                <label
                  className="bg-white/90 hover:bg-white text-gray-700 hover:text-gray-900 px-2 py-1 rounded-full shadow-md transition-all hover:scale-105 cursor-pointer text-[10px] font-bold flex items-center gap-1"
                  title={t("Replace image")}
                >
                  <RefreshCw className="w-3 h-3" />
                  <span>{t("Replace")}</span>
                  <input type="file" className="sr-only" accept="image/*" onChange={handleFileChange} />
                </label>
              )}
              <button
                onClick={() => {
                  setMeta(null);
                  onImageSelected('');
                }}
                className="bg-white/90 hover:bg-white text-gray-700 hover:text-gray-900 p-1.5 rounded-full shadow-md transition-all hover:scale-105 cursor-pointer"
                title={t("Remove image")}
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
            <div className="absolute bottom-2.5 left-2.5 flex flex-col items-start gap-1">
              <div className="bg-gray-900/90 backdrop-blur-sm border border-gray-700 text-white px-2.5 py-0.5 text-[10px] sm:text-xs font-medium rounded-full shadow-md">
                <span>{t(label)}</span>
              </div>
              {meta && meta.width > 0 && (
                <div className="bg-yellow-400/95 text-gray-900 px-2 py-0.5 text-[9px] font-bold rounded-full shadow-md">
                  {meta.width}×{meta.height} · {formatBytes(meta.bytes)}
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="text-center w-full max-w-xs mx-auto px-1 flex flex-col items-center justify-between h-full py-1">
            <div className="flex flex-col items-center justify-center my-auto">
              <div className="relative mx-auto mb-1.5 shrink-0">
                {/* Pulsing halo behind the icon. */}
                <span
                  aria-hidden
                  className="absolute inset-0 rounded-xl bg-yellow-400/40 blur-md animate-pulse group-hover/drop:bg-yellow-400/60"
                />
                <div className="relative h-9 w-9 sm:h-12 sm:w-12 flex items-center justify-center rounded-xl bg-gradient-to-br from-yellow-300 to-amber-500 shadow-md shadow-yellow-500/40 border border-yellow-300 text-gray-900 group-hover/drop:scale-110 group-hover/drop:rotate-3 transition-transform duration-300">
                  {icon || <Upload className="w-4 h-4 sm:w-5 sm:h-5 text-gray-900" />}
                </div>
              </div>
              <p className="mt-0.5 text-[11px] sm:text-xs md:text-sm text-gray-800 font-medium leading-tight line-clamp-2">
                <label className="relative cursor-pointer text-yellow-700 hover:text-yellow-800 font-semibold focus-within:outline-none transition-colors underline decoration-yellow-400/60 decoration-2 underline-offset-2 hover:decoration-yellow-600">
                  <span>{t(label)}</span>
                  <input type="file" className="sr-only" accept="image/*" onChange={handleFileChange} />
                </label>
              </p>
              {hint && (
                <p className="text-[10px] leading-tight text-gray-500 mt-0.5 px-1 truncate max-w-[180px]" title={hint}>
                  {hint}
                </p>
              )}
              {busy && (
                <p className="text-[9px] text-gray-400 mt-1">{t("Optimizing…")}</p>
              )}
            </div>

            {allowDrive && (
            <div className="mt-1 w-full pt-1 border-t border-gray-200/80 flex flex-col items-center shrink-0">
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setIsDrivePickerOpen(true);
                }}
                className="w-full inline-flex items-center justify-center gap-1 px-1.5 py-1.5 rounded-lg bg-white hover:bg-blue-50 text-gray-700 hover:text-blue-700 font-bold text-[9px] sm:text-xs border border-gray-300 hover:border-blue-400 shadow-2xs hover:shadow-md hover:shadow-blue-500/15 transition-all active:scale-98 cursor-pointer truncate"
              >
                <HardDrive className="w-3 h-3 text-blue-600 shrink-0" />
                <span className="truncate">Google Drive</span>
              </button>
            </div>
            )}
          </div>
        )}
      </div>

      {allowDrive && (
        <GoogleDrivePicker
          isOpen={isDrivePickerOpen}
          onClose={() => setIsDrivePickerOpen(false)}
          onSelectImage={handleDriveImageSelected}
          title={t('Import {what} from Google Drive', { what: t(label) })}
        />
      )}
    </div>
  );
};
