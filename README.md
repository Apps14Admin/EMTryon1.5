# EM Try-On

AI virtual try-on studio for EM Sport sportswear and footwear. A React + Vite
front end, served by a small Express server (`server.js`) that also proxies
Gemini/OpenAI (so API keys never reach the browser) and stores the Generation
Library in Cloud Storage + Firestore.

## Layout

| Path | What it is |
|---|---|
| `App.tsx`, `index.tsx`, `components/`, `services/` | Front end (React 19, TypeScript) |
| `server.js` | Production server: static `dist/`, `/api/gemini`, `/api/openai`, `/api/library`, `/api/instagram`, `/healthz` |
| `libraryStore.js` | Generation Library (Cloud Storage + Firestore, or `data/library/` locally) |
| `counterStore.js`, `externalCounter.js` | Generated-images counter |
| `instagram.js` | Optional Instagram scheduled publishing |
| `vite.config.ts` | Dev server on :3000, mirroring the production proxies |
| `Dockerfile` | Build image used by Cloud Run |
| `.env.example` | Every environment variable, documented |

## Run locally

Requires Node 20+.

```sh
npm install
cp .env.example .env      # then fill in GEMINI_API_KEY at minimum
npm run dev               # http://localhost:3000
```

Production mode on your machine (`server.js` does not read `.env` itself):

```sh
npm run build
node --env-file=.env server.js   # http://localhost:8080, or $PORT
```

Leave `LIBRARY_BUCKET` empty locally unless your Google credentials can reach
the production bucket; the Library then uses `data/library/` (git-ignored).

Checks: `npm run lint` (type-check) and `npm test`.

## Environment variables

Set on the Cloud Run service, never committed. See `.env.example` for details.

| Variable | Production | Notes |
|---|---|---|
| `GEMINI_API_KEY` | required | Server exits on startup without it |
| `LIBRARY_BUCKET` | `em-tryon-library-catchy-496207` | Library images; records go to Firestore `generations` |
| `OPENAI_API_KEY` | not set | Optional second image provider |
| `IG_ACCESS_TOKEN`, `PUBLIC_BASE_URL` | not set | Optional Instagram scheduler |
| `IMAGE_COUNTER_NAMESPACE`, `IMAGE_COUNTER_KEY` | not set | Optional off-site counter |

## Production

| | |
|---|---|
| Host | Google Cloud Run |
| Project / region / service | `catchy-496207` / `us-central1` / `em-tryon` |
| URL | https://em-tryon-7kjmumq2tq-uc.a.run.app (also https://em-tryon-423659149456.us-central1.run.app) |
| Data | Bucket `em-tryon-library-catchy-496207`, Firestore `(default)` collection `generations` |
| Runtime | 1 CPU, 1 GiB, concurrency 80, timeout 600 s, max 20 instances, startup CPU boost, public (`allUsers` invoker), default compute service account |

### Deploy

Put the production variables in an env file outside the repo (YAML,
`KEY: "value"` per line; `env.yaml` is git-ignored), then from this directory:

```sh
gcloud run deploy em-tryon --source . \
  --project=catchy-496207 --region=us-central1 \
  --cpu=1 --memory=1Gi --timeout=600 --concurrency=80 --max-instances=20 --cpu-boost \
  --allow-unauthenticated --env-vars-file=/path/outside/repo/env.yaml
```

`--source .` builds with the `Dockerfile` via Cloud Build; `.gcloudignore`
keeps `.env`, `data/` and `node_modules/` out of the upload. Redeploying never
touches the Library bucket or Firestore. Note that `--env-vars-file` replaces
the service's whole variable set, so the file must list every variable.

Cloud Run reserves `/healthz` on its public URLs, so check a deploy with
`/api/openai/status` (returns JSON) instead.
