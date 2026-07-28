# trains

Live UK mainline departure and arrival boards at **[trains.upyesp.org](https://trains.upyesp.org)**.
Updated every 30 seconds from [Real-Time Trains](https://realtimetrains.co.uk/) via a caching proxy.

Accessibility is a first-class concern (WCAG 2.2 AA, with screen-reader users as a primary
audience): only meaningful changes are announced, and platform state is never conveyed by
colour alone. See [CONTEXT.md](./CONTEXT.md) and [docs/adr/](./docs/adr/).

## Architecture

- **Frontend** — static [Astro](https://astro.build) site on GitHub Pages. Each station
  gets a pre-rendered shell at `/stations/<crs>` that live-refreshes in the browser.
- **Proxy** — Cloudflare Worker (`https://trains-api.upyesp.workers.dev`) holds the RTT
  credentials, caches boards for ~30s, and serves CORS. The RTT token never reaches the
  browser. See [`worker/`](./worker) and [`src/worker/`](./src/worker).
- **Pure core** — `src/lib/` is tested, platform-free logic (RTT→Board mapping,
  meaningful-change diffing, stale-while-error selection, token exchange) shared by both.

## Develop

```sh
npm install
npm run dev                       # http://localhost:4321, hits the live Worker
PUBLIC_MOCK=true npm run dev      # offline, canned board (no Worker needed)
```

Scripts: `dev`, `build`, `preview`, `typecheck` (`astro sync` + `tsc` for both the
client/DOM and Worker/no-DOM projects), `test`.

## Deploy

The site auto-deploys to GitHub Pages on push to `main` via
[`.github/workflows/deploy.yml`](./.github/workflows/deploy.yml).

**One-time setup** (repo → Settings → Pages): set **Source = GitHub Actions**. The custom
domain `trains.upyesp.org` is declared in [`public/CNAME`](./public/CNAME) and copied into
the build output; `public/.nojekyll` disables Jekyll so the `/_astro/` assets ship intact.

No secret is needed for the Pages build — the frontend only knows the Worker's public URL.
The RTT refresh token is a Cloudflare Worker secret (`RTT_TOKEN`); see
[ADR-0004](./docs/adr/0004-rtt-ng-api-data-rtt-io-bearer.md).
