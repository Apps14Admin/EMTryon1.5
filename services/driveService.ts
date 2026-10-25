import { auth } from '../firebase';
import { signInWithPopup, GoogleAuthProvider, onAuthStateChanged, User } from 'firebase/auth';

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  thumbnailLink?: string;
  webContentLink?: string;
  size?: string;
  modifiedTime?: string;
}

const provider = new GoogleAuthProvider();
provider.addScope('https://www.googleapis.com/auth/drive');
provider.addScope('https://www.googleapis.com/auth/drive.readonly');
provider.addScope('https://www.googleapis.com/auth/drive.file');
provider.addScope('https://www.googleapis.com/auth/drive.photos.readonly');
provider.addScope('https://www.googleapis.com/auth/drive.metadata.readonly');

provider.setCustomParameters({
  prompt: 'select_account consent',
  access_type: 'offline'
});

let isSigningIn = false;
let cachedAccessToken: string | null = null;


export const initDriveAuth = (
  onAuthSuccess?: (user: User, token: string) => void,
  onAuthFailure?: () => void
) => {
  return onAuthStateChanged(auth, async (user: User | null) => {
    if (user) {
      if (cachedAccessToken) {
        if (onAuthSuccess) onAuthSuccess(user, cachedAccessToken);
      } else if (!isSigningIn) {
        cachedAccessToken = null;
        if (onAuthFailure) onAuthFailure();
      }
    } else {
      cachedAccessToken = null;
      if (onAuthFailure) onAuthFailure();
    }
  });
};

export const googleSignInForDrive = async (): Promise<{ user: User; accessToken: string } | null> => {
  try {
    isSigningIn = true;
    const result = await signInWithPopup(auth, provider);
    const credential = GoogleAuthProvider.credentialFromResult(result);
    if (!credential?.accessToken) {
      throw new Error('Failed to get access token from Google Auth Provider');
    }

    cachedAccessToken = credential.accessToken;
    return { user: result.user, accessToken: cachedAccessToken };
  } catch (error: any) {
    console.error('Drive Sign-in error:', error);
    throw error;
  } finally {
    isSigningIn = false;
  }
};

export const getDriveAccessToken = (): string | null => {
  return cachedAccessToken;
};

export const logoutDrive = async () => {
  await auth.signOut();
  cachedAccessToken = null;
};

export type DriveViewMode = 'all_photos' | 'my_drive' | 'all_folders' | 'shared' | 'starred';

export const listDriveImages = async (
  accessToken: string,
  searchTerm: string = '',
  folderId: string = 'root',
  viewMode: DriveViewMode = 'all_photos'
): Promise<DriveFile[]> => {
  try {
    let query = "";
    
    if (viewMode === 'all_photos') {
      // Query EVERY image file across the entire Google Drive (ignoring folder hierarchy!)
      query = "(mimeType contains 'image/' or mimeType = 'application/vnd.google-apps.photo') and trashed = false";
    } else if (viewMode === 'all_folders') {
      // Query ALL folders across the entire Google Drive
      query = "mimeType = 'application/vnd.google-apps.folder' and trashed = false";
    } else if (viewMode === 'shared') {
      // Query shared folders and photos
      query = "(mimeType = 'application/vnd.google-apps.folder' or mimeType contains 'image/' or mimeType = 'application/vnd.google-apps.photo') and trashed = false and sharedWithMe = true";
    } else if (viewMode === 'starred') {
      // Query starred items
      query = "(mimeType = 'application/vnd.google-apps.folder' or mimeType contains 'image/' or mimeType = 'application/vnd.google-apps.photo') and trashed = false and starred = true";
    } else {
      // Standard My Drive folder navigation
      query = "(mimeType = 'application/vnd.google-apps.folder' or mimeType contains 'image/' or mimeType = 'application/vnd.google-apps.photo') and trashed = false";
      if (!searchTerm.trim() && folderId) {
        query += ` and '${folderId}' in parents`;
      }
    }

    if (searchTerm.trim()) {
      // When searching, always include both folders and images so user can find folders like "em tryon" from any tab!
      query = "(mimeType = 'application/vnd.google-apps.folder' or mimeType contains 'image/' or mimeType = 'application/vnd.google-apps.photo') and trashed = false";
      const cleanTerm = searchTerm.replace(/'/g, "\\'");
      query += ` and name contains '${cleanTerm}'`;
    }

    const params = new URLSearchParams({
      q: query,
      fields: 'files(id, name, mimeType, thumbnailLink, webContentLink, size, modifiedTime)',
      orderBy: 'modifiedTime desc',
      pageSize: '500',
      supportsAllDrives: 'true',
      includeItemsFromAllDrives: 'true'
    });


    const response = await fetch(`https://www.googleapis.com/drive/v3/files?${params.toString()}`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Google Drive API error (${response.status}): ${errText}`);
    }

    const data = await response.json();
    const files: DriveFile[] = data.files || [];
    
    // Sort folders first, then files
    return files.sort((a, b) => {
      const isAFolder = a.mimeType === 'application/vnd.google-apps.folder';
      const isBFolder = b.mimeType === 'application/vnd.google-apps.folder';
      if (isAFolder && !isBFolder) return -1;
      if (!isAFolder && isBFolder) return 1;
      return 0;
    });
  } catch (error) {
    console.error('Error listing Drive files:', error);
    throw error;
  }
};

export const getDriveImageBase64 = async (fileId: string, accessToken: string): Promise<string> => {
  try {
    const response = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Failed to download file from Drive (${response.status}): ${errText}`);
    }

    const blob = await response.blob();
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        if (typeof reader.result === 'string') {
          resolve(reader.result);
        } else {
          reject(new Error('Failed to convert Blob to base64 string'));
        }
      };
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  } catch (error) {
    console.error('Error downloading Drive image base64:', error);
    throw error;
  }
};
