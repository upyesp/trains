// @ts-check
import { defineConfig } from 'astro/config';

// Static site published to GitHub Pages on the custom domain www.viptrains.org
// (apex via CNAME, served at the site root -> no base path). Live board data is
// served by a separate Cloudflare Worker (worker/ + src/worker/); the client
// talks to it via the PUBLIC_API URL (default: the deployed Worker).
//
// Public env vars (exposed to the client automatically by Astro):
//   PUBLIC_API   - Worker base URL (default https://trains-api.upyesp.workers.dev)
//   PUBLIC_MOCK  - "true" to serve a canned board for offline dev
export default defineConfig({
  site: 'https://www.viptrains.org',
  output: 'static',
});
