
import React, { useState, useEffect } from 'react';
import { Sparkles, Images, Menu, Moon, Sun } from 'lucide-react';
import { subscribeGeneratedCount } from '../services/generationCounter';
import { useUiPrefs } from '../services/uiPrefs';

export interface HeaderProps {
  onToggleSidebar?: () => void;
  isSidebarOpen?: boolean;
  activeView?: 'studio' | 'library';
  onNavigate?: (view: 'studio' | 'library') => void;
}

export const Header: React.FC<HeaderProps> = ({ onToggleSidebar, isSidebarOpen, activeView = 'studio', onNavigate }) => {
  const [generatedCount, setGeneratedCount] = useState(0);
  const { lang, setLang, theme, setTheme, t } = useUiPrefs();

  useEffect(() => subscribeGeneratedCount(setGeneratedCount), []);

  return (
    <header className="border-b border-gray-200 bg-white/95 backdrop-blur-md sticky top-0 z-50 w-full">
      <div className="container mx-auto px-3 sm:px-6 h-16 sm:h-20 flex items-center justify-between gap-2 max-w-full">
        <div className="flex items-center gap-2 sm:gap-4 shrink-0 min-w-0">
          {onToggleSidebar && (
            <button
              onClick={onToggleSidebar}
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl bg-yellow-400/20 hover:bg-yellow-400/30 text-yellow-950 border border-yellow-400/50 shadow-2xs transition-all cursor-pointer group shrink-0"
              title={t("Toggle Advanced Settings Drawer")}
              aria-label={t('Toggle Advanced Settings Drawer')}
            >
              <Menu className="w-5 h-5 text-yellow-800 transition-transform group-hover:scale-110" />
              <span className="text-xs font-bold hidden sm:inline text-yellow-900">{t('Settings')}</span>
            </button>
          )}
          <div className="flex flex-col leading-none">
            <span className="font-bold text-sm sm:text-base text-gray-900 tracking-tight">
              {t('AI Try-On Studio')}
            </span>
            <span className="hidden sm:block text-[11px] text-gray-400 mt-0.5">
              {t('Virtual apparel & footwear visualization')}
            </span>
          </div>
        </div>

        <div className="flex items-center gap-2 sm:gap-3 shrink-0">
          {onNavigate && (
            <nav className="flex items-center gap-1 p-1 rounded-full bg-gray-100 border border-gray-200" aria-label={t("Main navigation")}>
              <button
                onClick={() => onNavigate('studio')}
                className={`px-3.5 py-1.5 rounded-full text-xs font-bold whitespace-nowrap transition-colors cursor-pointer ${
                  activeView === 'studio'
                    ? 'bg-white text-gray-900 shadow-2xs border border-gray-200'
                    : 'text-gray-500 hover:text-gray-800'
                }`}
                aria-current={activeView === 'studio' ? 'page' : undefined}
              >
                {t('Studio')}
              </button>
              <button
                onClick={() => onNavigate('library')}
                className={`px-3.5 py-1.5 rounded-full text-xs font-bold whitespace-nowrap transition-colors cursor-pointer ${
                  activeView === 'library'
                    ? 'bg-white text-gray-900 shadow-2xs border border-gray-200'
                    : 'text-gray-500 hover:text-gray-800'
                }`}
                aria-current={activeView === 'library' ? 'page' : undefined}
              >
                {t('Library')}
              </button>
            </nav>
          )}

          <div className="flex items-center gap-1 p-1 rounded-full bg-gray-100 border border-gray-200" role="group" aria-label={t('Switch language')}>
            {(['en', 'ar'] as const).map((code) => (
              <button
                key={code}
                type="button"
                onClick={() => setLang(code)}
                aria-pressed={lang === code}
                className={`px-2.5 py-1 rounded-full text-xs font-bold transition-colors cursor-pointer ${
                  lang === code ? 'bg-white text-gray-900 shadow-2xs border border-gray-200' : 'text-gray-500 hover:text-gray-800'
                }`}
              >
                {code === 'en' ? 'EN' : 'ع'}
              </button>
            ))}
          </div>

          <button
            type="button"
            onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
            title={t('Switch theme')}
            aria-label={t('Switch theme')}
            className="flex items-center justify-center w-8 h-8 rounded-full bg-gray-100 border border-gray-200 text-gray-700 hover:text-gray-900 shadow-2xs transition-colors cursor-pointer shrink-0"
          >
            {theme === 'dark' ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
          </button>

          <div
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-bold bg-gray-100 text-gray-700 border border-gray-200 shadow-2xs"
            title={`${generatedCount} photo${generatedCount === 1 ? '' : 's'} generated`}
          >
            <Images className="w-3.5 h-3.5 text-gray-500 shrink-0" />
            <span className="tabular-nums font-bold text-gray-900">{generatedCount}</span>
            <span className="hidden md:inline font-medium">
              {generatedCount === 1 ? t('photo generated') : t('photos generated')}
            </span>
          </div>

          <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-yellow-400/15 border border-yellow-400/40 text-xs font-medium text-gray-800 shadow-2xs">
            <Sparkles className="w-3.5 h-3.5 text-yellow-600 fill-yellow-400 shrink-0" />
            <span className="hidden sm:inline">{t('Powered by')}</span>
            <span className="font-bold text-gray-900 hidden sm:inline">Gemini 2.5 AI</span>
          </div>
        </div>
      </div>
    </header>
  );
};
