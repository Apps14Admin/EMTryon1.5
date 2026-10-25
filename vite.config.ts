import path from 'path';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { counterDevPlugin } from './counterStore.js';
import { libraryDevPlugin } from './libraryStore.js';

/**
 * The Gemini models the dev proxy is configured to serve — the same
 * configuration server.js holds in production, so `npm run dev` and the
 * deployed app address the same models.
 *
 * Keep identical to GEMINI_MODEL_IDS in services/aiModels.ts.
 */
const GEMINI_MODELS = [
  'gemini-3.1-flash-lite-image',
  'gemini-3.1-flash-image',
  'gemini-3-pro-image',
];

/**
 * Answers, rather than forwards, two kinds of request: one naming a model this
 * deployment is not configured for, and model listing (`GET /models`), which
 * this application does not use because its ids come from configuration.
 *
 * Installed via a direct `server.middlewares.use`, which runs BEFORE Vite's
 * internal proxy middleware — so neither reaches Google, and neither is
 * billed.
 */
const geminiConfigDevPlugin = () => ({
  name: 'gemini-model-config-dev',
  configureServer(server: any) {
    server.middlewares.use('/api/gemini', (req: any, res: any, next: any) => {
      const deny = (code: number, message: string) => {
        res.statusCode = code;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ error: { code, message } }));
      };

      const url: string = req.url || '';

      if (req.method === 'GET' && /\/models\/?(\?|$)/.test(url)) {
        console.warn(`[dev proxy] model listing is not served: ${url}`);
        return deny(
          403,
          'This application takes its model ids from configuration and does not discover them. Model listing is not served.'
        );
      }

      const match = /\/models\/([^:/?]+)/.exec(url);
      const model = match ? decodeURIComponent(match[1]) : null;
      if (model && !GEMINI_MODELS.includes(model)) {
        console.warn(`[dev proxy] model outside this deployment's configuration: ${model}`);
        return deny(
          400,
          `'${model}' is not part of this deployment's Gemini configuration. ` +
            `The configured models are ${GEMINI_MODELS.join(', ')}. ` +
            'The request was not forwarded and was not billed.'
        );
      }

      next();
    });
  },
});

/**
 * Answers `/api/openai/status` in dev, the way server.js does in production, so
 * the UI can grey out the OpenAI option when no key is configured instead of
 * offering a render that can only fail.
 */
const openaiStatusDevPlugin = (configured: boolean) => ({
  name: 'openai-status-dev',
  configureServer(server: any) {
    server.middlewares.use('/api/openai/status', (_req: any, res: any) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ configured }));
    });
  },
});

export default defineConfig(({ mode }) => {
    const env = loadEnv(mode, '.', '');
    const apiKey = env.GEMINI_API_KEY;
    const openaiKey = env.OPENAI_API_KEY;

    return {
      server: {
        port: 3000,
        strictPort: true,
        host: '0.0.0.0',
        // Mirrors the production proxy in server.js so dev and prod behave the
        // same. The key is attached here, in the Node process, and is never
        // exposed to the browser bundle.
        proxy: {
          '/api/gemini': {
            target: 'https://generativelanguage.googleapis.com',
            changeOrigin: true,
            // The key is appended here, in the rewrite, and NOT in a `proxyReq`
            // listener: by the time that event fires the request line can
            // already be on the wire for a body of any size, so a large upload
            // (a folder of photos) went out keyless and came back 403 while
            // small ones happened to make it. The rewrite runs before the
            // request exists, so every call carries the key.
            rewrite: (p) => {
              const path = p.replace(/^\/api\/gemini/, '');
              const sep = path.includes('?') ? '&' : '?';
              return `${path}${sep}key=${apiKey}`;
            },
          },
          // OpenAI authenticates by header, so the key goes in `headers` rather
          // than the rewrite. Static headers are set when the proxy request is
          // created, which sidesteps the large-upload race described above.
          '/api/openai': {
            target: 'https://api.openai.com',
            changeOrigin: true,
            headers: openaiKey ? { Authorization: `Bearer ${openaiKey}` } : {},
            rewrite: (p) => p.replace(/^\/api\/openai/, ''),
          },
        },
      },
      plugins: [
        react(),
        counterDevPlugin(),
        libraryDevPlugin(),
        geminiConfigDevPlugin(),
        openaiStatusDevPlugin(Boolean(openaiKey)),
      ],
      resolve: {
        alias: {
          '@': path.resolve(__dirname, '.'),
        }
      }
    };
});
