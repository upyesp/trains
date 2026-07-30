# Architecture: GitHub Pages (static frontend) + Cloudflare Worker (data proxy)

The frontend is a statically-generated site hosted on **GitHub Pages** at the custom domain `www.viptrains.org`. A single **Cloudflare Worker** acts as the data proxy: it holds the Real-Time Trains credentials, applies the 30s station-keyed cache, and serves the browser over CORS. **The browser never calls RTT directly.**

## Considered Options

- **Consolidate on one platform** (Cloudflare Pages / Vercel / Netlify) doing static + serverless + edge cache together. Rejected to honour the GitHub Pages hosting requirement and keep the static frontend where intended; consolidation remains a trivial future move since nothing real is deployed yet.
- **Browser calls RTT directly.** Rejected as impossible: RTT uses HTTP Basic auth (credentials cannot ship in client JS), there is no browser CORS from RTT, and there is no place for the shared cache.

## Consequences

- **Two platforms to operate:** GitHub Pages (frontend) + Cloudflare Workers (proxy). Both free-tier-friendly for a small public site.
- The proxy serves a **separate origin** (e.g. `api.viptrains.org` or a `*.workers.dev` URL) and must set **CORS** to allow the Pages origin only.
- The **30s cache** lives in the Worker via Cloudflare's Cache API / KV — edge-cached, purpose-built for "cache this station's board JSON for 30s."
- **RTT credentials live only in the Worker** (Cloudflare secrets) — never in the client bundle, never in the repo.
- **SSG pages are scaffolding only.** Board data is fetched client-side through the proxy at runtime; builds never call RTT (avoids ~2500 calls per build). Trade-off: board content is not in crawlable HTML, only the page structure is.
- **The cache serves stale-while-error.** On upstream failure (RTT down, 429, network error) the Worker keeps serving the last-good cached board **past its 30s TTL**, and exposes the entry's timestamp so the UI can show an accessible *"live data temporarily unavailable — showing board as at \<time\>"* notice. Only when there is no cached board at all does the UI show a hard "board unavailable" state.
