// axe-core WCAG 2.2 A/AA audit for the live VIPTrains site. Run:
//   node scripts/axe-audit.mjs
// Audits every page type (home/search, static pages, live station board,
// service/calling-points, platform board) in BOTH colour themes, plus a
// mobile-viewport pass on the calling-points page. Prints violations grouped
// by rule so repeats across pages are easy to see.
import puppeteer from 'puppeteer';
import axePkg from 'axe-core';
const axeSource = axePkg.source;

const BASE = process.env.AXE_BASE || 'https://www.viptrains.org.uk';
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

const browser = await puppeteer.launch({
  headless: 'new',
  // Reuse the Playwright-cached Chromium (the puppeteer download is blocked
  // on this box); any recent Chromium works for axe.
  executablePath: process.env.CHROME_BIN || '/home/pete/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome',
  args: ['--no-sandbox'],
});

/** Run axe on one page. `wait` = optional [description, predicate-source]. */
async function audit(page, { name, path, theme, mobile = false, wait = null }) {
  await page.setViewport({
    width: mobile ? 375 : 1280,
    height: mobile ? 812 : 900,
  });
  await page.evaluateOnNewDocument((t) => {
    try { localStorage.setItem('theme', t); } catch { /* no-op */ }
  }, theme);
  const url = BASE + path;
  const resp = await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
  const http = `${resp.status()}`;
  if (!resp.ok()) console.log(`  !! ${name}: HTTP ${http} ${url}`);
  if (wait) {
    const ok = await page
      .waitForFunction(wait[1], { timeout: 25000 })
      .then(() => 'yes')
      .catch(() => 'TIMEOUT');
    if (ok === 'TIMEOUT') console.log(`  !! ${name}: content wait timed out (${wait[0]})`);
  }
  await page.evaluate(() => (document.fonts ? document.fonts.ready : null)).catch(() => {});
  await new Promise((r) => setTimeout(r, 400));

  if (!(await page.evaluate(() => 'axe' in window))) {
    await page.addScriptTag({ content: axeSource });
  }
  const res = await page.evaluate(async (tags) => {
    return await window.axe.run(document, {
      runOnly: { type: 'tag', values: tags },
      resultTypes: ['violations'],
    });
  }, TAGS);

  const found = res.violations.map((v) => ({
    id: v.id,
    impact: v.impact,
    help: v.help,
    tags: v.tags.filter((t) => TAGS.includes(t)),
    nodes: v.nodes.map((n) => ({
      target: n.target.join(' '),
      html: n.html.length > 160 ? n.html.slice(0, 160) + '…' : n.html,
      summary: (n.failureSummary || '').replace(/\n\s+/g, ' | '),
    })),
  }));
  return { name, theme, http, url, found };
}

// ---- discover a live service + platform URL from a real board -------------
const disc = await browser.newPage();
await disc.setViewport({ width: 1280, height: 900 });
let serviceUrl = null;
let platformUrl = null;
try {
  await disc.goto(BASE + '/stations/rdg', { waitUntil: 'networkidle2', timeout: 60000 });
  await disc
    .waitForFunction(() => document.querySelector('.board a[href*="/service/?"]'), { timeout: 25000 })
    .catch(() => {});
  serviceUrl = await disc.evaluate(() => document.querySelector('.board a[href*="/service/?"]')?.getAttribute('href') || null);
  platformUrl = await disc.evaluate(() => document.querySelector('.board a[href*="/platform/"]')?.getAttribute('href') || null);
  // Platform chips only link when the board has platform data; fall back to a
  // known-good calling-points link from the service page itself.
  if (!platformUrl && serviceUrl) {
    await disc.goto(BASE + serviceUrl, { waitUntil: 'networkidle2', timeout: 60000 });
    await disc
      .waitForFunction(() => document.querySelector('#stops a[href*="/platform/"]'), { timeout: 20000 })
      .catch(() => {});
    platformUrl = await disc.evaluate(
      () => document.querySelector('a[href*="/platform/"]')?.getAttribute('href') || null,
    );
  }
} catch (e) {
  console.log(`  !! discovery failed: ${e.message}`);
}
await disc.close();
console.log(`discovery: service=${serviceUrl} platform=${platformUrl}\n`);

const boardWait = ['board rows or message', `() => document.querySelector('.board .svc, .board-msg')`];

const pages = [
  { name: 'home', path: '/', wait: null },
  { name: 'about', path: '/about', wait: null },
  { name: 'contact', path: '/contact', wait: null },
  { name: 'privacy', path: '/privacy', wait: null },
  { name: 'history', path: '/history', wait: null },
  { name: 'station-board', path: '/stations/rdg', wait: boardWait },
  ...(serviceUrl ? [{ name: 'service', path: serviceUrl, wait: boardWait }] : []),
  ...(serviceUrl ? [{ name: 'service-mobile', path: serviceUrl, mobile: true, wait: boardWait }] : []),
  ...(platformUrl ? [{ name: 'platform', path: platformUrl, wait: boardWait }] : []),
];

const all = [];
for (const theme of ['dark', 'light']) {
  const page = await browser.newPage();
  for (const p of pages) {
    const r = await audit(page, { ...p, theme });
    const n = r.found.reduce((a, v) => a + v.nodes.length, 0);
    console.log(`[${theme}] ${r.http} ${r.name}: ${r.found.length} violation rules, ${n} nodes`);
    all.push(r);
  }
  await page.close();
}
await browser.close();

// ---- grouped report --------------------------------------------------------
console.log('\n================ VIOLATIONS BY RULE ================\n');
const byRule = new Map();
for (const r of all) {
  for (const v of r.found) {
    const key = `${v.id} [${v.impact || 'none'}]`;
    if (!byRule.has(key)) byRule.set(key, { ...v, pages: [] });
    const entry = byRule.get(key);
    for (const nd of v.nodes) entry.pages.push(`${r.theme}/${r.name}: ${nd.target} — ${nd.html} — ${nd.summary}`);
  }
}
if (byRule.size === 0) {
  console.log('No WCAG 2.2 A/AA violations found. 🎉');
} else {
  const order = { critical: 0, serious: 1, moderate: 2, minor: 3, none: 4 };
  const rules = [...byRule.entries()].sort(
    (a, b) => (order[a[1].impact] ?? 9) - (order[b[1].impact] ?? 9) || a[0].localeCompare(b[0]),
  );
  for (const [key, v] of rules) {
    console.log(`\n■ ${key} — ${v.help}  (${v.tags.join(',')})`);
    const seen = new Set();
    for (const line of v.pages) {
      if (seen.has(line)) continue;
      seen.add(line);
      console.log(`   • ${line}`);
    }
  }
}
