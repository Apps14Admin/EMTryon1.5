
import React, { useEffect, useState } from 'react';
import { TryOnTool } from './components/TryOnTool';
import { Header } from './components/Header';
import { LibraryPage } from './components/LibraryPage';
import { UiPrefsProvider, useT } from './services/uiPrefs';

export type AppView = 'studio' | 'library';

const viewFromHash = (): AppView => (window.location.hash === '#library' ? 'library' : 'studio');

const Studio: React.FC = () => {
  const t = useT();
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [view, setView] = useState<AppView>(viewFromHash);

  useEffect(() => {
    // Fire-and-forget: begin the ~100MB SigLIP download while the user is
    // still choosing a folder, so grouping never waits on it (spec 12.1).
    import('./services/visualEmbedding').then(({ embedderReady }) => {
      embedderReady().catch(() => {});
    });
  }, []);

  // The Library lives at #library so a reload — or a shared link — lands on
  // the same view. The Studio stays MOUNTED underneath while the Library is
  // open: a batch mid-run must survive a glance at past work.
  useEffect(() => {
    const onHashChange = () => setView(viewFromHash());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const navigate = (next: AppView) => {
    window.location.hash = next === 'library' ? '#library' : '';
  };

  return (
    <div className="min-h-screen flex flex-col bg-[#f8f9fa] text-gray-900 selection:bg-yellow-400 selection:text-black font-sans overflow-x-hidden w-full">
      <Header
        onToggleSidebar={view === 'studio' ? () => setIsSidebarOpen(prev => !prev) : undefined}
        isSidebarOpen={isSidebarOpen}
        activeView={view}
        onNavigate={navigate}
      />

      <main className="flex-grow container mx-auto px-3 sm:px-6 py-5 sm:py-12 max-w-6xl w-full min-w-0">
        <div className={view === 'studio' ? '' : 'hidden'}>
          <div className="mb-6 sm:mb-8">
            <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-gray-900">
              {t('AI Virtual Try-On Studio')}
            </h1>
            <p className="text-sm text-gray-500 mt-1">
              {t('Upload your footwear or athletic apparel and visualize them instantly on a model using Gemini AI.')}
            </p>
          </div>

          <TryOnTool isSidebarOpen={isSidebarOpen} setIsSidebarOpen={setIsSidebarOpen} />
        </div>

        {view === 'library' && (
          <div>
            <div className="mb-6 sm:mb-8">
              <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-gray-900">
                {t('Library')}
              </h1>
              <p className="text-sm text-gray-500 mt-1">
                {t('Every image generated in the Studio, saved permanently — browse, filter and search past renders.')}
              </p>
            </div>
            <LibraryPage />
          </div>
        )}
      </main>

      <footer className="py-8 border-t border-gray-200 mt-16 bg-white text-gray-600">
        <div className="container mx-auto px-4 sm:px-6 max-w-6xl flex flex-col sm:flex-row items-center justify-between gap-4 text-sm">
          <div className="flex items-center gap-3">
            <div className="flex flex-col text-left">
              <span className="font-bold text-sm text-gray-900 tracking-tight leading-none">
                {t('AI Try-On Studio')}
              </span>
              <span className="text-gray-400 text-[11px] mt-0.5">{t('AI Virtual Try-On')}</span>
            </div>
          </div>

          <p className="text-xs text-gray-400">&copy; {new Date().getFullYear()} AI Try-On Studio. Powered by Google Gemini AI.</p>
        </div>
      </footer>
    </div>
  );
};

/** The provider wraps the whole tree so language and theme reach every screen. */
const App: React.FC = () => (
  <UiPrefsProvider>
    <Studio />
  </UiPrefsProvider>
);

export default App;
