import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const GRAPH = 'https://graph.instagram.com/v21.0';
const STORE = path.join(__dirname, 'data', 'scheduled-posts.json');
const MEDIA_DIR = path.join(__dirname, 'data', 'media');

for (const dir of [path.dirname(STORE), MEDIA_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// --- persistence -----------------------------------------------------------
// Flat JSON file. Fine for a single Cloud Run instance / local dev; swap for
// Firestore if this ever needs to survive multiple instances.

function readPosts() {
  try {
    return JSON.parse(fs.readFileSync(STORE, 'utf8'));
  } catch {
    return [];
  }
}

function writePosts(posts) {
  fs.writeFileSync(STORE, JSON.stringify(posts, null, 2));
}

// --- Instagram Graph API ---------------------------------------------------

async function graph(pathname, params, method = 'GET') {
  const token = process.env.IG_ACCESS_TOKEN;
  if (!token) throw new Error('IG_ACCESS_TOKEN is not set');

  const url = new URL(GRAPH + pathname);
  const body = new URLSearchParams({ ...params, access_token: token });

  const res =
    method === 'GET'
      ? await fetch(`${url}?${body}`)
      : await fetch(url, {
          method,
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body,
        });

  const json = await res.json();
  if (json.error) {
    const e = new Error(json.error.message || 'Instagram API error');
    e.igCode = json.error.code;
    e.igDetail = json.error;
    throw e;
  }
  return json;
}

/**
 * Publishes an image to Instagram. Two-step per Meta's Content Publishing API:
 * create a media container from a PUBLIC url, then publish it.
 */
export async function publishImage(imageUrl, caption) {
  const container = await graph('/me/media', { image_url: imageUrl, caption }, 'POST');

  // Containers are processed asynchronously; publishing too early fails.
  await waitForContainer(container.id);

  const published = await graph('/me/media_publish', { creation_id: container.id }, 'POST');
  return { containerId: container.id, mediaId: published.id };
}

async function waitForContainer(containerId, attempts = 12, delayMs = 5000) {
  for (let i = 0; i < attempts; i++) {
    const { status_code, status } = await graph(`/${containerId}`, {
      fields: 'status_code,status',
    });
    if (status_code === 'FINISHED') return;
    if (status_code === 'ERROR' || status_code === 'EXPIRED') {
      throw new Error(`Container ${status_code}: ${status || 'no detail'}`);
    }
    await new Promise((r) => setTimeout(r, delayMs));
  }
  throw new Error('Timed out waiting for Instagram to process the image');
}

export async function accountInfo() {
  return graph('/me', { fields: 'id,username,account_type' });
}

export async function publishingLimit() {
  return graph('/me/content_publishing_limit', {});
}

// --- scheduling ------------------------------------------------------------

/** Saves a generated image locally and returns its public path. */
export function saveMedia(base64, ext = 'jpg') {
  const name = `${Date.now()}-${Math.floor(Math.random() * 1e6)}.${ext}`;
  fs.writeFileSync(path.join(MEDIA_DIR, name), Buffer.from(base64, 'base64'));
  return `/media/${name}`;
}

export function schedulePost({ imagePath, caption, publishAt }) {
  const posts = readPosts();
  const post = {
    id: `post_${Date.now()}_${Math.floor(Math.random() * 1e6)}`,
    imagePath,
    caption: caption || '',
    publishAt,
    status: 'scheduled',
    createdAt: new Date().toISOString(),
    attempts: 0,
  };
  posts.push(post);
  writePosts(posts);
  return post;
}

export function listPosts() {
  return readPosts().sort((a, b) => new Date(a.publishAt) - new Date(b.publishAt));
}

export function cancelPost(id) {
  const posts = readPosts();
  const post = posts.find((p) => p.id === id);
  if (!post) return null;
  if (post.status === 'published') return post;
  post.status = 'cancelled';
  writePosts(posts);
  return post;
}

/**
 * Publishes anything that is due. Called on a timer by server.js.
 * publicBaseUrl must be reachable by Instagram's servers.
 */
export async function runDuePosts(publicBaseUrl) {
  const posts = readPosts();
  const now = Date.now();
  const results = [];

  for (const post of posts) {
    if (post.status !== 'scheduled') continue;
    if (new Date(post.publishAt).getTime() > now) continue;

    post.attempts += 1;
    try {
      const { mediaId } = await publishImage(publicBaseUrl + post.imagePath, post.caption);
      post.status = 'published';
      post.mediaId = mediaId;
      post.publishedAt = new Date().toISOString();
      delete post.error;
      results.push({ id: post.id, ok: true, mediaId });
      console.log(`[instagram] published ${post.id} -> ${mediaId}`);
    } catch (err) {
      post.error = err.message;
      // Give up after 3 tries so a bad post doesn't retry forever.
      if (post.attempts >= 3) post.status = 'failed';
      results.push({ id: post.id, ok: false, error: err.message });
      console.error(`[instagram] failed ${post.id}: ${err.message}`);
    }
  }

  if (results.length) writePosts(posts);
  return results;
}

export { MEDIA_DIR };
