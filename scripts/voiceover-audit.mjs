// VoiceOver durability harness for VIPTrains.
//
// Two layers, both asserting on the same durability properties (no focus
// loss across refreshes, silent quiet ticks, meaningful-change
// announcements), at the REAL 30s refresh cadence — no timer tampering:
//
//   default  — Chromium accessibility-tree layer: puppeteer's page
//              .accessibility.snapshot() is the exact AX tree macOS screen
//              readers consume. Zero macOS permissions; runs headless
//              (CI-friendly). Board/service data comes from an in-page
//              fetch patch with a deterministic fixture (the Worker's CORS
//              allowlist blocks localhost, and live data can't be mutated
//              on demand).
//
//   --vo     — real VoiceOver via GuidePup: drives the actual screen
//              reader on this Mac's GUI session and asserts on what it
//              SPEAKS. Needs a one-time macOS approval (System Settings →
//              Privacy & Security → Accessibility/Automation for the host
//              process); run `npx @guidepup/setup setup` first. Takes
//              over the Mac's audio while running.
//
// Usage:
//   node scripts/voiceover-audit.mjs                 # AX layer
//   node scripts/voiceover-audit.mjs --vo            # real VoiceOver
//   AXE_BASE=http://localhost:4321 node scripts/...  # other target
//
// Board fixture: 3 services; `mutate()` makes S1 cancelled, S2 platform
// change (7→9 confirmed), S3 +7 min swing — the three ADR-0002 meaningful
// change classes.
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import puppeteer from 'puppeteer';

const BASE = process.env.AXE_BASE || 'https://www.viptrains.org.uk';
const VO = process.argv.includes('--vo');
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findChrome() {
  if (process.env.CHROME_BIN && existsSync(process.env.CHROME_BIN)) {
    return process.env.CHROME_BIN;
  }
  try {
    const root = join(homedir(), '.cache', 'puppeteer', 'chrome');
    for (const platform of readdirSync(root).sort().reverse()) {
      for (const mid of readdirSync(join(root, platform)).sort().reverse()) {
        for (const base of [join(root, platform, mid), join(root, platform)]) {
          for (const rel of [
            ['chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'],
            ['chrome-mac-x64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'],
            ['chrome-linux64', 'chrome'],
          ]) {
            const p = join(base, ...rel);
            if (existsSync(p)) return p;
          }
        }
      }
    }
  } catch {
    // no cache
  }
  throw new Error('No Chrome found — run `npx puppeteer browsers install chrome`');
}

const today = new Date().toISOString().slice(0, 10);
const t = (h, m) => `${today}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00`;
const FIXTURE = JSON.stringify({
  today,
  services: [
    { id: 'S1', scheduledTime: t(10, 38), expectedTime: t(10, 38), platform: { number: '3', state: 'confirmed' }, destination: 'Leeds', origin: 'London King’s Cross', finalDestination: 'Leeds', operator: 'LNER', coaches: 9, journeyMins: 45, originDeparture: t(9, 53), cancelled: false },
    { id: 'S2', scheduledTime: t(10, 42), expectedTime: t(10, 48), platform: { number: '7', state: 'provisional' }, destination: 'Newcastle', origin: 'London King’s Cross', finalDestination: 'Newcastle', operator: 'LNER', coaches: 9, journeyMins: 90, originDeparture: t(9, 12), cancelled: false },
    { id: 'S3', scheduledTime: t(10, 45), expectedTime: t(10, 45), platform: null, destination: 'York', origin: 'London King’s Cross', finalDestination: 'York', operator: 'LNER', coaches: null, journeyMins: null, cancelled: false },
  ],
  detail: {
    detail: {
      id: 'X1', origin: 'London King’s Cross', destination: 'Edinburgh', operator: 'LNER', coaches: 9, cancelled: false,
      points: [
        { station: 'London King’s Cross', scheduledTime: t(10, 0), expectedTime: t(10, 0), platform: { number: '1', state: 'confirmed' }, cancelled: false },
        { station: 'Peterborough', scheduledTime: t(10, 48), expectedTime: t(10, 52), platform: { number: '3', state: 'confirmed' }, cancelled: false },
        { station: 'Reading', scheduledTime: t(11, 38), expectedTime: t(11, 38), platform: { number: '4', state: 'provisional' }, cancelled: false },
        { station: 'York', scheduledTime: t(12, 28), expectedTime: t(12, 35), platform: null, cancelled: false },
        { station: 'Edinburgh', scheduledTime: t(13, 30), expectedTime: t(13, 38), platform: { number: '7', state: 'confirmed' }, cancelled: false },
      ],
    },
    asAt: 0,
    stale: false,
  },
});

/** Patch the page's fetch with the deterministic fixture + `__mutate()`. */
async function patchPage(page) {
  await page.evaluateOnNewDocument((fixtureJson) => {
    const fx = JSON.parse(fixtureJson);
    const iso = (h, m) => `${fx.today}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00`;
    let boardCalls = 0;
    let serviceCalls = 0;
    let mutated = false;
    window.__mutate = () => { mutated = true; };
    const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    const services = () => fx.services.map((s) => ({ ...s }));
    const mutatedServices = () => {
      const s = services();
      s[0].cancelled = true;
      s[1].platform = { number: '9', state: 'confirmed' };
      s[2].expectedTime = iso(10, 52);
      return s;
    };
    const origFetch = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.includes('/board/')) {
        boardCalls++;
        const kind = url.includes('kind=arrivals') ? 'arrivals' : 'departures';
        const svcs = boardCalls === 1 || !mutated ? services() : mutatedServices();
        return json({ board: { station: 'RDG', kind, services: svcs }, asAt: Date.now(), stale: false });
      }
      if (url.includes('/service?')) {
        serviceCalls++;
        const d = JSON.parse(JSON.stringify(fx.detail));
        d.asAt = Date.now();
        return json(d);
      }
      return origFetch(input, init);
    };
  }, FIXTURE);
}

// ---- shared durability scenarios (AX assertions) -------------------------

async function axWalk(node, fn) {
  if (!node) return;
  fn(node);
  for (const c of node.children ?? []) axWalk(c, fn);
}

async function axFocusedName(page) {
  const snap = await page.accessibility.snapshot();
  let found = null;
  axWalk(snap, (n) => { if (n.focused && !found) found = `${n.role}«${n.name ?? ''}»`; });
  return found;
}

async function axHas(page, needle) {
  const snap = await page.accessibility.snapshot();
  return JSON.stringify(snap).includes(needle);
}

// ---- AX layer ------------------------------------------------------------

async function runAx() {
  const browser = await puppeteer.launch({ headless: 'new', executablePath: findChrome(), args: ['--no-sandbox'] });
  try {
    // -- Station board ------------------------------------------------------
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    await patchPage(page);
    await page.goto(BASE + '/stations/rdg', { waitUntil: 'networkidle2', timeout: 60000 });
    await page.waitForFunction(() => document.querySelectorAll('.board .svc').length >= 3, { timeout: 20000 });
    await sleep(600); // let the first-load announcement land

    check('ax: first-load announcement exposed to AT',
      await axHas(page, 'Live board loaded — 3 departures.'));

    // Focus a service link, then ride out one REAL refresh tick untouched.
    await page.evaluate(() => document.querySelector('.board a.svc-link')?.focus());
    const before = await axFocusedName(page);
    check('ax: service link focusable & named for AT', /link«.*view calling points/.test(before ?? ''), before ?? '(none)');
    await sleep(34000);
    const afterQuiet = await axFocusedName(page);
    check('ax: focus survives quiet refresh tick (AT view)', afterQuiet === before, `${before} -> ${afterQuiet}`);
    check('ax: quiet tick keeps the announcement readable',
      await axHas(page, 'Live board loaded — 3 departures.'));

    // Mutated board: announcements must surface, focus must stay put.
    await page.evaluate(() => window.__mutate());
    await sleep(34000);
    check('ax: cancellation announced through the live region',
      await axHas(page, 'has been cancelled'));
    check('ax: platform change announced (provisional → confirmed 9)',
      await axHas(page, 'platform confirmed — platform 9.'));
    const afterMut = await axFocusedName(page);
    check('ax: focus survives CHANGED refresh tick', afterMut === before, `${before} -> ${afterMut}`);

    // Combobox, in AT terms: expanded input + listbox + options.
    await page.evaluate(() => document.getElementById('station-input')?.focus());
    await page.keyboard.type('lei');
    await sleep(1200);
    const comboOk = await page.evaluate(() => {
      const input = document.getElementById('station-input');
      const opts = document.querySelectorAll('#station-list [role="option"]');
      return input?.getAttribute('aria-expanded') === 'true' && opts.length > 0;
    });
    const leedsInAx = await axHas(page, 'Leeds');
    check('ax: combobox expands with options (AT view)', comboOk && leedsInAx);
    await page.close();

    // -- History dialog (real visit recorded, then delete flow) -------------
    const hist = await browser.newPage();
    await hist.setViewport({ width: 1280, height: 900 });
    await patchPage(hist);
    await hist.goto(BASE + '/service/?id=X1&from=RDG', { waitUntil: 'networkidle2', timeout: 60000 });
    await hist.waitForFunction(() => document.querySelectorAll('.stop-item').length >= 5, { timeout: 20000 });
    await hist.goto(BASE + '/history', { waitUntil: 'networkidle2', timeout: 60000 });
    await hist.waitForFunction(() => document.querySelectorAll('.hist-item').length >= 1, { timeout: 20000 });
    const histAx = JSON.stringify(await hist.accessibility.snapshot());
    const delNames = (histAx.match(/"name":"[^"]*Delete[^"]*"/g) ?? []).join(' || ');
    // \s (not a literal space): the date separator is a deliberate U+2009
    // thin space — screen readers announce it as a normal gap.
    check('ax: history delete buttons carry the full service description',
      /Delete \d{2}:\d{2} .+ to .+,[\s\u2009]\d{1,2}\s\w{3}\sfrom history/.test(histAx), delNames || '(no Delete names in AX tree)');
    await hist.evaluate(() => document.querySelector('.hist-delete')?.click());
    await sleep(400);
    check('ax: confirmation dialog exposed (name + description + buttons)',
      await axHas(hist, 'Delete from history?') && await axHas(hist, 'Cancel') && await axHas(hist, 'Delete'));
    await hist.keyboard.press('Escape');
    await sleep(300);
    check('ax: Escape closes the dialog (back to the list)',
      !(await axHas(hist, 'Delete from history?')));
    await hist.close();
  } finally {
    await browser.close();
  }
}

// ---- real VoiceOver layer (GuidePup) --------------------------------------

async function runVo() {
  const { voiceOver } = await import('@guidepup/guidepup');
  const browser = await puppeteer.launch({
    headless: false,
    executablePath: findChrome(),
    args: ['--no-sandbox', '--no-first-run', '--no-default-browser-check', '--window-size=1280,900', '--window-position=40,40'],
  });
  try {
    const page = (await browser.pages())[0] ?? (await browser.newPage());
    await patchPage(page);
    await page.goto(BASE + '/stations/rdg', { waitUntil: 'networkidle2', timeout: 60000 });
    await page.bringToFront();
    await sleep(1500);

    await voiceOver.start();
    await voiceOver.interact(); // enter the web area

    // VO should speak the polite first-load announcement.
    let heard = null;
    for (let i = 0; i < 60 && !heard; i++) {
      const log = (await voiceOver.spokenPhraseLog()).join(' | ');
      heard = log.includes('Live board loaded') ? log.match(/Live board loaded[^|]*/)?.[0] : null;
      if (!heard) await sleep(500);
    }
    check('vo: first-load announcement SPOKEN by real VoiceOver', !!heard, heard ?? 'not heard in 30s');

    // Durability: a quiet tick must not make VoiceOver say ANYTHING new.
    const logBefore = (await voiceOver.spokenPhraseLog()).length;
    await sleep(34000);
    const logAfter = (await voiceOver.spokenPhraseLog()).length;
    check('vo: quiet refresh tick is silent (no interruptions)', logAfter === logBefore, `${logBefore} -> ${logAfter} phrases`);

    // Tab to a service row and confirm the spoken name carries the hint.
    for (let i = 0; i < 8; i++) {
      await voiceOver.press('Tab');
      await sleep(350);
      const last = await voiceOver.lastSpokenPhrase();
      if (last.includes('view calling points')) {
        check('vo: service row spoken with its purpose', true, last.trim().slice(0, 90));
        break;
      }
    }
    if (!(await voiceOver.spokenPhraseLog()).join('|').includes('view calling points')) {
      check('vo: service row spoken with its purpose', false, 'not reached in 8 tabs');
    }

    // Focus durability in spoken terms: after the next quiet tick, Tabbing
    // continues from the same row (no jump back to the top of the list).
    const rowPhrases = (await voiceOver.spokenPhraseLog()).length;
    await sleep(34000);
    await voiceOver.press('Tab');
    await sleep(500);
    const last = await voiceOver.lastSpokenPhrase();
    const jumpedToTop = /Skip to content|banner|heading .*Reading \(RDG\)/i.test(last);
    check('vo: focus keeps its place across refresh (next Tab stays in the board)',
      !jumpedToTop && (await voiceOver.spokenPhraseLog()).length >= rowPhrases, last.trim().slice(0, 90));

    // Mutations must be SPOKEN.
    await page.evaluate(() => window.__mutate());
    let cancelled = false;
    for (let i = 0; i < 80 && !cancelled; i++) {
      cancelled = (await voiceOver.spokenPhraseLog()).join(' ').includes('has been cancelled');
      if (!cancelled) await sleep(500);
    }
    check('vo: cancellation SPOKEN through the live region', cancelled);

    // Combobox, spoken.
    await page.evaluate(() => document.getElementById('station-input')?.focus());
    await voiceOver.type('lei');
    await sleep(1500);
    const comboSpoken = (await voiceOver.spokenPhraseLog()).join(' ').includes('Leeds');
    check('vo: station matches SPOKEN in the listbox', comboSpoken);
  } finally {
    try { await voiceOver.stop(); } catch { /* already off */ }
    await browser.close();
  }
}

console.log(`VoiceOver durability harness — ${VO ? 'REAL VOICEOVER (GuidePup)' : 'AX-tree layer'} — target ${BASE}\n`);
const t0 = Date.now();
try {
  if (VO) await runVo();
  else await runAx();
} catch (e) {
  console.error(`HARNESS ERROR: ${e.message}`);
  process.exitCode = 2;
} finally {
  const failed = results.filter((r) => !r.ok);
  console.log(`\n==== ${results.length - failed.length}/${results.length} checks passed in ${Math.round((Date.now() - t0) / 1000)}s ====`);
  if (failed.length) process.exitCode = 1;
}
