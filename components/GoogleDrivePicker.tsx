import * as React from 'react';
import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { X, Search, RefreshCw, LogOut, CheckCircle2, AlertCircle, Loader2, HardDrive, FileImage, ArrowRight, Folder, ChevronRight, CornerUpLeft, Home } from 'lucide-react';
import { 
  DriveFile, 
  DriveViewMode,
  initDriveAuth, 
  googleSignInForDrive, 
  getDriveAccessToken, 
  logoutDrive, 
  listDriveImages, 
  getDriveImageBase64 
} from '../services/driveService';
import { useT } from '../services/uiPrefs';
import { User } from 'firebase/auth';

interface GoogleDrivePickerProps {
  isOpen: boolean;
  onClose: () => void;
  onSelectImage: (base64: string, fileName: string) => void;
  title?: string;
}

export const GoogleDrivePicker: React.FC<GoogleDrivePickerProps> = ({
  isOpen,
  onClose,
  onSelectImage,
  title = "Select Image from Google Drive"
}) => {
  const t = useT();
  const [accessToken, setAccessToken] = useState<string | null>(getDriveAccessToken());
  const [user, setUser] = useState<User | null>(null);
  const [files, setFiles] = useState<DriveFile[]>([]);
  const [searchTerm, setSearchTerm] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isSigningIn, setIsSigningIn] = useState(false);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<DriveViewMode>('my_drive');
  const [breadcrumbs, setBreadcrumbs] = useState<{ id: string; name: string }[]>([
    { id: 'root', name: t('My Drive') }
  ]);

  useEffect(() => {
    const unsubscribe = initDriveAuth(
      (authUser, token) => {
        setUser(authUser);
        setAccessToken(token);
      },
      () => {
        setUser(null);
        setAccessToken(null);
      }
    );
    return () => unsubscribe();
  }, []);

  const loadFiles = async (token: string, search: string = '', folderId: string = 'root', mode: DriveViewMode = viewMode) => {
    setIsLoading(true);
    setError(null);
    try {
      const driveFiles = await listDriveImages(token, search, folderId, mode);
      setFiles(driveFiles);
    } catch (err: any) {
      console.error(err);
      setError(err.message || t('Failed to fetch files from Google Drive'));
      if (err.message?.includes('401') || err.message?.includes('auth')) {
        setAccessToken(null);
      }
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen && accessToken) {
      const currentFolderId = breadcrumbs[breadcrumbs.length - 1].id;
      loadFiles(accessToken, searchTerm, currentFolderId, viewMode);
    }
  }, [isOpen, accessToken, breadcrumbs, viewMode]);

  const handleSignIn = async () => {
    setIsSigningIn(true);
    setError(null);
    try {
      const result = await googleSignInForDrive();
      if (result) {
        setUser(result.user);
        setAccessToken(result.accessToken);
        const currentFolderId = breadcrumbs[breadcrumbs.length - 1].id;
        loadFiles(result.accessToken, searchTerm, currentFolderId, viewMode);
      }
    } catch (err: any) {
      console.error(err);
      setError(err.message || t('Failed to sign in with Google Drive'));
    } finally {
      setIsSigningIn(false);
    }
  };

  const handleLogout = async () => {
    await logoutDrive();
    setUser(null);
    setAccessToken(null);
    setFiles([]);
    setViewMode('my_drive');
    setBreadcrumbs([{ id: 'root', name: t('My Drive') }]);
  };

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (accessToken) {
      const currentFolderId = breadcrumbs[breadcrumbs.length - 1].id;
      loadFiles(accessToken, searchTerm, currentFolderId, viewMode);
    }
  };

  const handleFolderClick = (folder: DriveFile) => {
    setSearchTerm('');
    setViewMode('my_drive');
    setBreadcrumbs([...breadcrumbs, { id: folder.id, name: folder.name }]);
  };


  const handleBreadcrumbClick = (index: number) => {
    setSearchTerm('');
    setBreadcrumbs(breadcrumbs.slice(0, index + 1));
  };

  const handleUpLevel = () => {
    if (breadcrumbs.length > 1) {
      setSearchTerm('');
      setBreadcrumbs(breadcrumbs.slice(0, breadcrumbs.length - 1));
    }
  };

  const handleFileClick = async (file: DriveFile) => {
    if (file.mimeType === 'application/vnd.google-apps.folder') {
      handleFolderClick(file);
      return;
    }
    if (!accessToken || downloadingId) return;
    setDownloadingId(file.id);
    setError(null);
    try {
      const base64 = await getDriveImageBase64(file.id, accessToken);
      onSelectImage(base64, file.name);
      onClose();
    } catch (err: any) {
      console.error(err);
      setError(`Failed to download "${file.name}": ${err.message}`);
    } finally {
      setDownloadingId(null);
    }
  };

  if (!isOpen) return null;

  return (
    <AnimatePresence>
      <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-black/60 backdrop-blur-xs">
        <motion.div
          initial={{ opacity: 0, scale: 0.95, y: 10 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.95, y: 10 }}
          transition={{ duration: 0.2 }}
          className="bg-white w-full max-w-3xl rounded-3xl shadow-2xl overflow-hidden border border-gray-100 flex flex-col max-h-[85vh]"
        >
          {/* Header */}
          <div className="px-5 py-4 sm:px-6 sm:py-5 border-b border-gray-100 flex items-center justify-between bg-gray-50/80">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-2xl bg-yellow-400/20 border border-yellow-400/50 flex items-center justify-center shrink-0">
                <HardDrive className="w-5 h-5 text-yellow-600" />
              </div>
              <div>
                <h3 className="font-bold text-gray-900 text-base sm:text-lg">{t(title)}</h3>
                <p className="text-xs text-gray-500">{t("Access athlete & gear photos directly from your Google Drive")}</p>
              </div>
            </div>
            <button
              onClick={onClose}
              className="p-2 rounded-xl text-gray-400 hover:text-gray-600 hover:bg-gray-200/60 transition-colors cursor-pointer"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          {/* Body */}
          <div className="flex-1 overflow-y-auto p-5 sm:p-6">
            {error && (
              <div className="mb-4 p-3 rounded-2xl bg-red-50 border border-red-100 text-red-700 text-xs sm:text-sm flex items-start gap-2.5">
                <AlertCircle className="w-4 h-4 text-red-500 shrink-0 mt-0.5" />
                <span className="flex-1">{error}</span>
              </div>
            )}

            {!accessToken ? (
              /* Sign In View */
              <div className="py-12 px-4 text-center flex flex-col items-center justify-center max-w-md mx-auto">
                <div className="w-16 h-16 rounded-3xl bg-blue-50 border border-blue-100 flex items-center justify-center mb-5 text-blue-600 shadow-sm">
                  <HardDrive className="w-8 h-8" />
                </div>
                <h4 className="text-lg font-bold text-gray-900 mb-2">{t("Connect Google Drive")}</h4>
                <p className="text-xs sm:text-sm text-gray-600 mb-8 leading-relaxed">
                  Authorize EMSPORT to view and select photos from your Google Drive so you can seamlessly import athlete gear and sneakers into the Virtual Try-On studio.
                </p>

                {/* Styled Sign in with Google Button */}
                <button
                  onClick={handleSignIn}
                  disabled={isSigningIn}
                  className="w-full sm:w-auto px-6 py-3.5 rounded-2xl bg-white hover:bg-gray-50 text-gray-800 font-semibold text-sm border border-gray-300 shadow-sm flex items-center justify-center gap-3 transition-all cursor-pointer active:scale-98 disabled:opacity-50"
                >
                  {isSigningIn ? (
                    <Loader2 className="w-5 h-5 animate-spin text-blue-600" />
                  ) : (
                    <svg className="w-5 h-5" viewBox="0 0 48 48">
                      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
                      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
                      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
                      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
                      <path fill="none" d="M0 0h48v48H0z" />
                    </svg>
                  )}
                  <span>{isSigningIn ? t('Connecting to Google...') : t('Sign in with Google Drive')}</span>
                </button>
              </div>
            ) : (
              /* Signed In View - File Browser */
              <div className="space-y-4">
                {/* User Info & Search Bar */}
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-gray-50 p-3 rounded-2xl border border-gray-200/70">
                  <div className="flex items-center gap-2.5 text-xs text-gray-700 font-medium">
                    <div className="w-7 h-7 rounded-full bg-blue-600 text-white font-bold flex items-center justify-center uppercase text-xs">
                      {user?.displayName ? user.displayName[0] : 'U'}
                    </div>
                    <div>
                      <span className="block font-bold text-gray-900">{user?.displayName || t('Google User')}</span>
                      <span className="text-gray-500 text-[11px]">{user?.email}</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => {
                        const currentFolderId = breadcrumbs[breadcrumbs.length - 1].id;
                        loadFiles(accessToken, searchTerm, currentFolderId, viewMode);
                      }}
                      disabled={isLoading}
                      className="p-2 rounded-xl bg-white border border-gray-200 text-gray-600 hover:text-gray-900 hover:bg-gray-100 transition-all cursor-pointer text-xs flex items-center gap-1.5 font-medium shadow-2xs"
                    >
                      <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin' : ''}`} />
                      <span className="hidden sm:inline">{t("Refresh")}</span>
                    </button>
                    <button
                      onClick={handleLogout}
                      className="p-2 rounded-xl bg-white border border-gray-200 text-red-600 hover:bg-red-50 transition-all cursor-pointer text-xs flex items-center gap-1.5 font-medium shadow-2xs"
                    >
                      <LogOut className="w-3.5 h-3.5" />
                      <span className="hidden sm:inline">{t("Disconnect")}</span>
                    </button>
                  </div>
                </div>

                {/* Permission Upgrade Notice */}
                <div className="bg-amber-50 border border-amber-200/80 rounded-xl p-2.5 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2 text-xs text-amber-900 shadow-2xs">
                  <div className="flex items-center gap-2">
                    <AlertCircle className="w-4 h-4 text-amber-600 shrink-0" />
                    <span><strong>{t('Only see "Google AI Studio" or missing folders?')}</strong> {t("You need to upgrade permissions to see all folders.")}</span>
                  </div>
                  <button
                    type="button"
                    onClick={async () => {
                      await handleLogout();
                      handleSignIn();
                    }}
                    className="w-full sm:w-auto px-3 py-1.5 bg-amber-600 hover:bg-amber-700 text-white font-bold rounded-lg transition-all shrink-0 cursor-pointer text-xs shadow-2xs text-center"
                  >
                    {t("Reconnect & Grant Access")}
                  </button>
                </div>

                {/* View Mode Navigation Tabs */}
                <div className="flex items-center gap-1.5 p-1 bg-gray-100 rounded-2xl overflow-x-auto text-xs font-bold border border-gray-200/80">
                  <button
                    type="button"
                    onClick={() => { setViewMode('my_drive'); setSearchTerm(''); }}
                    className={`flex items-center gap-1.5 px-3 py-2 rounded-xl transition-all cursor-pointer shrink-0 ${
                      viewMode === 'my_drive' ? 'bg-white text-gray-900 shadow-2xs font-extrabold border border-gray-200/80' : 'text-gray-600 hover:text-gray-900'
                    }`}
                  >
                    <Folder className="w-3.5 h-3.5 text-blue-600 fill-blue-500/20" />
                    <span>{t("My Drive Folders")}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => { setViewMode('all_folders'); setSearchTerm(''); }}
                    className={`flex items-center gap-1.5 px-3 py-2 rounded-xl transition-all cursor-pointer shrink-0 ${
                      viewMode === 'all_folders' ? 'bg-white text-gray-900 shadow-2xs font-extrabold border border-gray-200/80' : 'text-gray-600 hover:text-gray-900'
                    }`}
                  >
                    <Folder className="w-3.5 h-3.5 text-amber-600 fill-amber-500/20" />
                    <span>{t("All Folders")}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => { setViewMode('all_photos'); setSearchTerm(''); }}
                    className={`flex items-center gap-1.5 px-3 py-2 rounded-xl transition-all cursor-pointer shrink-0 ${
                      viewMode === 'all_photos' ? 'bg-white text-gray-900 shadow-2xs font-extrabold border border-gray-200/80' : 'text-gray-600 hover:text-gray-900'
                    }`}
                  >
                    <FileImage className="w-3.5 h-3.5 text-yellow-600" />
                    <span>{t("All Photos (Entire Drive)")}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => { setViewMode('shared'); setSearchTerm(''); }}
                    className={`flex items-center gap-1.5 px-3 py-2 rounded-xl transition-all cursor-pointer shrink-0 ${
                      viewMode === 'shared' ? 'bg-white text-gray-900 shadow-2xs font-extrabold border border-gray-200/80' : 'text-gray-600 hover:text-gray-900'
                    }`}
                  >
                    <span className="text-sm">🤝</span>
                    <span>{t("Shared with Me")}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => { setViewMode('starred'); setSearchTerm(''); }}
                    className={`flex items-center gap-1.5 px-3 py-2 rounded-xl transition-all cursor-pointer shrink-0 ${
                      viewMode === 'starred' ? 'bg-white text-gray-900 shadow-2xs font-extrabold border border-gray-200/80' : 'text-gray-600 hover:text-gray-900'
                    }`}
                  >
                    <span className="text-sm">⭐</span>
                    <span>{t("Starred")}</span>
                  </button>
                </div>

                {/* Breadcrumbs (only show in My Drive folder hierarchy mode) */}
                {viewMode === 'my_drive' && (
                  <div className="flex items-center gap-1 overflow-x-auto py-2 px-3 bg-gray-100/80 rounded-xl border border-gray-200/60 text-xs font-semibold text-gray-700">
                    {breadcrumbs.length > 1 && (
                      <button
                        type="button"
                        onClick={handleUpLevel}
                        className="p-1.5 rounded-lg hover:bg-white hover:shadow-2xs text-gray-600 hover:text-gray-900 transition-all mr-1 shrink-0 flex items-center gap-1 cursor-pointer"
                        title={t("Up one folder")}
                      >
                        <CornerUpLeft className="w-3.5 h-3.5 text-blue-600" />
                        <span className="hidden sm:inline text-[11px]">{t("Back")}</span>
                      </button>
                    )}
                    {breadcrumbs.map((crumb, idx) => {
                      const isLast = idx === breadcrumbs.length - 1;
                      return (
                        <React.Fragment key={crumb.id + idx}>
                          {idx > 0 && <ChevronRight className="w-3.5 h-3.5 text-gray-400 shrink-0" />}
                          <button
                            type="button"
                            onClick={() => !isLast && handleBreadcrumbClick(idx)}
                            disabled={isLast}
                            className={`flex items-center gap-1.5 px-2 py-1 rounded-lg transition-all shrink-0 ${
                              isLast
                                ? 'bg-white shadow-2xs text-gray-900 font-bold border border-gray-200/80'
                                : 'hover:bg-white/60 text-gray-600 hover:text-gray-900 cursor-pointer'
                            }`}
                          >
                            {idx === 0 ? <Home className="w-3.5 h-3.5 text-blue-600" /> : <Folder className="w-3.5 h-3.5 text-yellow-500 fill-yellow-400/20" />}
                            <span className="truncate max-w-[120px] sm:max-w-[180px]">{crumb.name}</span>
                          </button>
                        </React.Fragment>
                      );
                    })}
                  </div>
                )}

                {/* Search input */}
                <form onSubmit={handleSearchSubmit} className="relative">
                  <Search className="w-4 h-4 text-gray-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
                  <input
                    type="text"
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                    placeholder={t("Search photos & folders in Google Drive...")}
                    className="w-full pl-10 pr-20 py-2.5 text-xs sm:text-sm bg-white border border-gray-300 rounded-xl focus:outline-none focus:border-yellow-500 focus:ring-2 focus:ring-yellow-400/20 transition-all"
                  />
                  <button
                    type="submit"
                    className="absolute right-1.5 top-1/2 -translate-y-1/2 px-3 py-1.5 bg-gray-900 text-yellow-400 rounded-lg text-xs font-bold hover:bg-black transition-colors cursor-pointer"
                  >
                    {t("Search")}
                  </button>
                </form>

                {/* Files Grid */}
                {isLoading ? (
                  <div className="py-16 text-center flex flex-col items-center justify-center text-gray-500">
                    <Loader2 className="w-8 h-8 animate-spin text-yellow-500 mb-3" />
                    <p className="text-xs sm:text-sm font-medium">{t("Loading photos & folders...")}</p>
                  </div>
                ) : files.length === 0 ? (
                  <div className="py-16 text-center bg-gray-50/50 rounded-2xl border border-dashed border-gray-200">
                    <Folder className="w-10 h-10 text-gray-300 mx-auto mb-3" />
                    <p className="text-sm font-bold text-gray-700 mb-1">{t("No photos found in this view")}</p>
                    <p className="text-xs text-gray-500 max-w-xs mx-auto">
                      {t('Try switching to the "All Photos (Entire Drive)" tab above, check "Shared with Me", or upload images to Google Drive.')}
                    </p>
                  </div>

                ) : (
                  <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3 max-h-[380px] overflow-y-auto pr-1">
                    {files.map((file) => {
                      const isFolder = file.mimeType === 'application/vnd.google-apps.folder';
                      const isDownloading = downloadingId === file.id;
                      return (
                        <div
                          key={file.id}
                          onClick={() => handleFileClick(file)}
                          className={`group relative rounded-2xl border border-gray-200 overflow-hidden aspect-square cursor-pointer transition-all hover:border-yellow-500 hover:shadow-md flex flex-col ${
                            isFolder ? 'bg-amber-50/50 hover:bg-amber-100/50 border-amber-200/70' : 'bg-gray-100'
                          } ${isDownloading ? 'ring-2 ring-yellow-500 opacity-80' : ''}`}
                        >
                          {/* Thumbnail / Icon */}
                          <div className={`flex-1 relative overflow-hidden flex items-center justify-center ${
                            isFolder ? 'bg-amber-100/40 group-hover:scale-105 transition-transform' : 'bg-gray-200'
                          }`}>
                            {isFolder ? (
                              <div className="flex flex-col items-center justify-center p-2 text-center">
                                <Folder className="w-12 h-12 text-amber-500 fill-amber-400/30 mb-1" />
                                <span className="text-[10px] font-bold text-amber-800 bg-amber-200/80 px-2 py-0.5 rounded-full">
                                  {t("Folder")}
                                </span>
                              </div>
                            ) : file.thumbnailLink ? (
                              <img
                                src={file.thumbnailLink}
                                alt={file.name}
                                referrerPolicy="no-referrer"
                                className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                              />
                            ) : (
                              <FileImage className="w-10 h-10 text-gray-400" />
                            )}
                            {isDownloading && !isFolder && (
                              <div className="absolute inset-0 bg-black/60 flex flex-col items-center justify-center text-white p-2 text-center">
                                <Loader2 className="w-6 h-6 animate-spin text-yellow-400 mb-1" />
                                <span className="text-[10px] font-bold">{t("Importing...")}</span>
                              </div>
                            )}
                          </div>
                          {/* File label */}
                          <div className={`p-2 bg-white border-t ${isFolder ? 'border-amber-100' : 'border-gray-100'}`}>
                            <p className="text-[11px] font-semibold text-gray-800 truncate" title={file.name}>
                              {file.name}
                            </p>
                            <p className="text-[9px] text-gray-400">
                              {isFolder ? t('Tap to open folder') : (file.modifiedTime ? new Date(file.modifiedTime).toLocaleDateString() : t('Photo'))}
                            </p>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="px-5 py-3.5 sm:px-6 bg-gray-50 border-t border-gray-100 flex items-center justify-between text-xs text-gray-500">
            <span>{t("Powered by Google Workspace API")}</span>
            <button
              onClick={onClose}
              className="px-4 py-1.5 rounded-xl bg-gray-200 hover:bg-gray-300 font-bold text-gray-700 transition-colors cursor-pointer"
            >
              {t("Close")}
            </button>
          </div>
        </motion.div>
      </div>
    </AnimatePresence>
  );
};
