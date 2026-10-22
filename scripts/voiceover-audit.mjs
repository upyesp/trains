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
//              SPEAKS. Takes over the Mac's audio while running.
//
// Environment (macOS 27, one-time setup — see git history for the saga):
//   • Full Disk Access + Accessibility toggled ON for BOTH the Terminal
//     app and the Node binary (Homebrew Node upgrades change the versioned
//     path and invalidate the Node grants). GUI toggles only — macOS 27
//     SIP-blocks direct TCC.db writes even as root.
//   • `sudo npx @guidepup/setup setup` once (writes
//     /private/var/db/Accessibility/.VoiceOverAppleScriptEnabled).
//   • GuidePup's cached preferences DMG ships a speech-suppressing
//     verbosity (SCRVerbosity_StaticText_valueUpdate=ToneAtChanges);
//     it was repacked to stock defaults (backup /tmp/gp-prefs-backup.dmg).
//     If GuidePup re-downloads it, spoken output degrades to tones.
//   • Launch the audit under Terminal to inherit its grants://     `open -a Terminal ~/.vo-audit.command` (the wrapper redirects output
//     to /tmp/vo-audit-out.log). A background daemon chain cannot get the
//     control-VoiceOver consent: the Automation-pane toggle for node is
//     broken on macOS 27 (snaps back off) and background consent prompts
//     never surface.
//
// Known limitation (engine-level, PROVEN — see scripts/vo-announcement-matrix.mjs):
// Chromium on macOS does not deliver live-region announcements to VoiceOver
// in ANY markup form — role=status+atomic, role=alert, child-replacement,
// visible region, <output>, assertive, role=log were ALL silent with
// DOM-verified delivery and the VO cursor in web content (Chromium
// 152.0.7977.54, macOS 27.0.1). Safari/WebKit — the screen-reader browser
// macOS VO users actually pair with — announces them all. The site's
// announcer markup is already best practice; the harness therefore asserts
// live-region MECHANISM via the AX layer and records Chromium speech as
// info. What Chromium DOES deliver — aria-activedescendant option
// announcements — is asserted for real in the VO layer.
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
import { execFile } from 'node:child_process';
import puppeteer from 'puppeteer';

// Pete: VO speech must be barely audible during automated runs — capture is
// text-based. VoiceOver exposes NO scriptable cursor volume (its AppleScript
// dictionary has no such property — `set the volume of the vo cursor` fails
// with -1700), so clamp the SYSTEM output volume instead: VO speech tracks
// it. The pre-run value is restored in runVo()'s finally. Override with
// VO_SYSTEM_VOLUME=n (n of 100).
const VO_SYSTEM_VOLUME = Number(process.env.VO_SYSTEM_VOLUME ?? 5);
let savedSystemVolume = null; // null = nothing to restore
const osaOut = (script) =>
  new Promise((res, rej) =>
    execFile('/usr/bin/osascript', ['-e', script], (err, stdout, stderr) =>
      err ? rej(new Error(String(stderr || err.message).trim())) : res(stdout.trim()),
    ),
  );
async function setVoVolume() {
  try {
    const cur = Number(await osaOut('output volume of (get volume settings)'));
    if (cur <= VO_SYSTEM_VOLUME) return; // already quiet — leave it
    savedSystemVolume = cur;
    await osaOut(`set volume output volume ${VO_SYSTEM_VOLUME}`);
    console.log(`  info: system output volume ${cur} -> ${VO_SYSTEM_VOLUME} for the run`);
  } catch (e) { console.log(`  info: system volume clamp failed: ${e.message}`); }
}
async function restoreSystemVolume() {
  if (savedSystemVolume === null) return;
  const to = savedSystemVolume;
  savedSystemVolume = null;
  try {
    await osaOut(`set volume output volume ${to}`);
    console.log(`  cleanup: system output volume restored to ${to}`);
  } catch { /* best effort */ }
}

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
    { id: 'S3', scheduledTime: t(10, 45), expectedTime: t(10, 45), platform: { number: '4', state: 'provisional' }, destination: 'York', origin: 'London King’s Cross', finalDestination: 'York', operator: 'LNER', coaches: null, journeyMins: null, cancelled: false },
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
        // CRS-aware: the platform page refetches /board/<station> for the
        // station in its query, so serve each station a coherent fixture.
        const crs = (url.match(/\/board\/([A-Za-z]{3})/)?.[1] ?? 'RDG').toUpperCase();
        const kind = url.includes('kind=arrivals') ? 'arrivals' : 'departures';
        let svcs = boardCalls === 1 || !mutated ? services() : mutatedServices();
        if (crs === 'KGX') {
          // King's Cross: everything on platform 1, so a platform-chip link
          // opened from the calling-points fixture lands on a populated board.
          svcs = [
            { id: 'K1', scheduledTime: iso(9, 5), expectedTime: iso(9, 5), platform: { number: '1', state: 'confirmed' }, destination: 'Leeds', origin: 'London King’s Cross', finalDestination: 'Leeds', operator: 'LNER', coaches: 8, journeyMins: 90, originDeparture: iso(9, 5), cancelled: false },
            { id: 'K2', scheduledTime: iso(9, 20), expectedTime: iso(9, 24), platform: { number: '1', state: 'confirmed' }, destination: 'York', origin: 'London King’s Cross', finalDestination: 'York', operator: 'LNER', coaches: 11, journeyMins: 105, originDeparture: iso(9, 20), cancelled: false },
          ];
        }
        return json({ board: { station: crs, kind, services: svcs }, asAt: Date.now(), stale: false });
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
    await page.keyboard.press('ArrowDown');
    await sleep(400);
    const activeDesc = await page.evaluate(() => {
      const id = document.getElementById('station-input')?.getAttribute('aria-activedescendant');
      const first = document.querySelector('#station-list [role="option"]');
      return { desc: id ? document.getElementById(id)?.textContent ?? '' : '', first: first?.textContent ?? '' };
    });
    check('ax: ArrowDown highlights the top option (aria-activedescendant follows)',
      activeDesc.desc.length > 0 && activeDesc.desc === activeDesc.first,
      `${activeDesc.desc || '(no activedescendant)'} vs first option: ${activeDesc.first}`);
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
  const { execFile } = await import('node:child_process');
  const activateChrome = () =>
    new Promise((res) =>
      execFile('/usr/bin/osascript', ['-e', 'tell application "Google Chrome for Testing" to activate'], () => res()),
    );
  // Continuous phrase capture: GuidePup's log only advances at operation
  // boundaries, so time-based announcements (load, refresh ticks) land
  // BETWEEN reads and get lost. Poll lastSpokenPhrase every 250ms and
  // accumulate — this is what made the activedescendant announcements
  // visible and turns the combobox check into a real assertion.
  let poller = null;
  const captured = [];
  const seenPhrases = new Set();
  const browser = await puppeteer.launch({
    headless: false,
    executablePath: findChrome(),
    args: ['--no-sandbox', '--no-first-run', '--no-default-browser-check', '--window-size=1280,900', '--window-position=40,40'],
  });
  try {
    const page = (await browser.pages())[0] ?? (await browser.newPage());
    await patchPage(page);
    // Pull keyboard focus out of Chrome's toolbar (a fresh-profile launch
    // focuses the address bar, and VoiceOver's cursor follows it — every
    // Tab then cycles the browser UI instead of the page). Moving keyboard
    // focus to the page moves the VO cursor with it.
    const focusBody = () =>
      page.evaluate(() => {
        document.body.setAttribute('tabindex', '-1');
        document.body.focus();
      });
    // Chrome launches with key focus in the omnibox and no synthetic click
    // can take window-level key focus out of it — but the keyboard can:
    // Tab walks the toolbar into the page, and the first page element
    // announces as a link or heading. That also puts the VO cursor inside
    // the web content, where live-region announcements are watched.
    const enterPageByKeyboard = async () => {
      for (let i = 0; i < 15; i++) {
        await voiceOver.press('Tab');
        await sleep(450);
        const last = await voiceOver.lastSpokenPhrase();
        if (/\b(link|heading)\b/i.test(last)) return last;
      }
      return null;
    };

    // VoiceOver must be LIVE BEFORE the page loads: aria-live announcements
    // only speak for changes that happen while the screen reader is running.
    // And Chrome must be genuinely frontmost (bringToFront races Terminal),
    // or the keystrokes land in whatever app is active instead of the page.
    await voiceOver.start();
    await setVoVolume();
    await sleep(800);
    await activateChrome();
    await sleep(1200);
    poller = setInterval(() => {
      voiceOver.lastSpokenPhrase().then((p) => {
        const t = p.trim();
        if (t && !seenPhrases.has(t)) { seenPhrases.add(t); captured.push(t); }
      }).catch(() => {});
    }, 250);

    // First load warms Chrome's accessibility tree: Chromium only switches
    // AX support on when it notices a screen reader, which takes a moment.
    await page.goto(BASE + '/stations/rdg', { waitUntil: 'networkidle2', timeout: 60000 });
    await page.waitForFunction(() => document.querySelectorAll('.board .svc').length >= 3, { timeout: 20000 });
    await sleep(2000);
    // Walk key focus out of the omnibox into the page.
    await enterPageByKeyboard();
    await focusBody();
    try { await voiceOver.stopInteracting(); } catch { /* not interacting */ }
    await voiceOver.interact(); // VO cursor now inside the web content
    await sleep(1000);
    // Reload NOW: key focus stays in the web contents across a reload, and
    // the reload re-fires the first-load announcement while VO is watching.
    await page.reload({ waitUntil: 'networkidle2', timeout: 60000 });
    await page.waitForFunction(() => document.querySelectorAll('.board .svc').length >= 3, { timeout: 20000 });
    await focusBody();
    await sleep(2000);

    // INFO only: Chromium does not deliver live-region announcements to
    // VoiceOver AT ALL on macOS (proven: scripts/vo-announcement-matrix.mjs).
    // The live-region mechanism itself is asserted by the AX layer.
    const firstLoadHeard = captured.find((p) => p.includes('Live board loaded'));
    console.log(`  info: live-region speech of first-load announcement: ${firstLoadHeard ? `spoken: ${firstLoadHeard.trim().slice(0, 70)}` : 'not spoken (Chromium engine gap — see scripts/vo-announcement-matrix.mjs)'}`);

    // TAB-ONLY ASSERTIONS from here: real keystrokes are what a user does,
    // and they survive DOM rebuilds where programmatic focus does not.

    // Tab into the reloaded board: page structure must be spoken on the way
    // (banner, menu, combobox…), and the row's name must carry its purpose.
    let rowHeard = null;
    let structureHeard = null;
    for (let i = 0; i < 12 && !rowHeard; i++) {
      await voiceOver.press('Tab');
      await sleep(400);
      const last = await voiceOver.lastSpokenPhrase();
      if (/banner|menu|combo|heading|list box|tab group/i.test(last)) structureHeard ??= last;
      if (last.includes('view calling points')) rowHeard = last;
    }
    check('vo: tabbing into the reloaded board speaks structure and the row\'s purpose',
      !!(rowHeard && structureHeard),
      rowHeard?.trim().slice(0, 90) ?? 'row not reached in 12 tabs');

    // Durability: a quiet tick must not make VoiceOver say ANYTHING new.
    const logBefore = (await voiceOver.spokenPhraseLog()).length;
    await sleep(34000);
    const logAfter = (await voiceOver.spokenPhraseLog()).length;
    check('vo: quiet refresh tick is silent (no interruptions)', logAfter === logBefore, `${logBefore} -> ${logAfter} phrases`);

    // Focus durability in spoken terms: the next Tab continues from the rows
    // (a phrase about the platform link), NOT back to the page top.
    await voiceOver.press('Tab');
    await sleep(500);
    const last = await voiceOver.lastSpokenPhrase();
    const jumpedToTop = /skip to content/i.test(last);
    check('vo: focus keeps its place across refresh (next Tab stays in the board)',
      !jumpedToTop && last.trim().length > 0, last.trim().slice(0, 90));

    // Mutations must be perceivable. The polite live region carries the
    // announcement (AX layer asserts its text); Chromium+VO does not speak
    // it. What must hold for a real user: the mutation re-render leaves
    // keyboard navigation intact and rows keep being spoken — continue
    // Tabbing from the current position and listen.
    await page.evaluate(() => window.__mutate());
    let updated = false;
    for (let i = 0; i < 80 && !updated; i++) {
      updated = await page.evaluate(() =>
        (document.getElementById('announcer')?.textContent ?? '').toLowerCase().includes('cancel'));
      if (!updated) await sleep(500);
    }
    let navAfterMutation = null;
    for (let i = 0; i < 8 && !navAfterMutation; i++) {
      await voiceOver.press('Tab');
      await sleep(400);
      const last = await voiceOver.lastSpokenPhrase();
      if (last.includes('view calling points')) navAfterMutation = last;
    }
    check('vo: board stays keyboard-navigable and SPOKEN after mutation',
      updated && !!navAfterMutation,
      updated ? (navAfterMutation?.trim().slice(0, 90) ?? 'no row spoken in 12 tabs after mutation') : 'mutation not applied within 40s');

    // Combobox: walk BACK to it with real Shift+Tab keystrokes, then type.
    let backAtCombo = false;
    for (let i = 0; i < 12 && !backAtCombo; i++) {
      await voiceOver.press('Shift+Tab');
      await sleep(400);
      const last = await voiceOver.lastSpokenPhrase();
      if (/CHANGE STATION/i.test(last)) backAtCombo = true;
    }
    const beforeCombo = (await voiceOver.spokenPhraseLog()).length;
    await voiceOver.type('lei');
    await sleep(1500);
    const expanded = await page.evaluate(() => document.getElementById('station-input')?.getAttribute('aria-expanded') === 'true');
    const spoke = (await voiceOver.spokenPhraseLog()).length > beforeCombo;
    check('vo: combobox reached by keyboard, expands and VoiceOver reacts', backAtCombo && expanded && spoke,
      backAtCombo ? `expanded=${expanded} spoke=${spoke}` : 'combobox not reached in 12 Shift+Tabs');

    // ---- site navigation & functionality (spoken, keystroke-only) ---------

    // The listbox is open with 'lei' typed: ArrowDown highlights the top
    // suggestion and Chromium+VO DOES announce activedescendant changes
    // (proven by the announcement matrix with continuous capture — earlier
    // "silent" readings were a capture artifact). This is a REAL assertion.
    await voiceOver.press('ArrowDown');
    let optionHeard = false;
    for (let i = 0; i < 8 && !optionHeard; i++) {
      await sleep(450);
      optionHeard = captured.some((p) => /Leeds|Leicester|selected \(/i.test(p));
    }
    await voiceOver.press('Enter');
    let navigated = false;
    try {
      await page.waitForFunction(() => /\/stations\/lei\/?$/.test(location.pathname), { timeout: 20000 });
      await page.waitForFunction(() => document.querySelectorAll('#board-body .svc, .board-msg').length >= 1, { timeout: 20000 });
      navigated = true;
    } catch { /* url checked below */ }
    await sleep(1200);
    check('vo: combobox suggestion announced and Enter navigates to the station board',
      optionHeard && navigated,
      `suggestion spoken=${optionHeard} url=${page.url()}`);

    // Fresh tab: keyboard starts in Chrome's omnibox, exactly like a new
    // user. The FIRST thing the page must offer is the skip link.
    const page2 = await browser.newPage();
    await page2.setViewport({ width: 1280, height: 900 });
    await patchPage(page2);
    await page2.goto(BASE + '/stations/rdg', { waitUntil: 'networkidle2', timeout: 60000 });
    await page2.waitForFunction(() => document.querySelectorAll('.board .svc').length >= 3, { timeout: 20000 });
    await sleep(2000);
    await voiceOver.press('Tab');
    await sleep(500);
    const firstTab = await voiceOver.lastSpokenPhrase();
    check('vo: skip link is the first element the keyboard reaches',
      /skip to content/i.test(firstTab), firstTab.trim().slice(0, 70));

    // Activating it must move focus past the header into main content.
    // Poll for the announcements: GuidePup's phrase capture lags the keypress
    // by its stability window, and a fixed 500ms read races it.
    await voiceOver.press('Enter');
    let afterEnter = '';
    for (let i = 0; i < 6 && !afterEnter; i++) {
      await sleep(450);
      const p = await voiceOver.lastSpokenPhrase();
      if (p.trim()) afterEnter = p;
    }
    // A single press occasionally returns silence (VO phrase capture lags);
    // retry the Tab up to 3 times before declaring failure.
    let afterSkip = '';
    for (let t = 0; t < 3 && !afterSkip; t++) {
      await voiceOver.press('Tab');
      for (let i = 0; i < 5 && !afterSkip; i++) {
        await sleep(450);
        const p = await voiceOver.lastSpokenPhrase();
        if (p.trim() && p !== afterEnter) afterSkip = p;
      }
    }
    check('vo: activating the skip link lands keyboard focus in main content',
      afterSkip.trim().length > 0 && !/skip to content|banner|menu bar/i.test(afterSkip),
      afterSkip.trim().slice(0, 70) || '(nothing spoken)');

    // Board type tabs: walk to Departures, then ArrowRight to Arrivals —
    // the tab must announce as selected and the rows must re-render as
    // arrivals (their link names say "due", not "departs").
    let atTab = null;
    for (let i = 0; i < 14 && !atTab; i++) {
      await voiceOver.press('Tab');
      await sleep(400);
      const last = await voiceOver.lastSpokenPhrase();
      if (/Departures selected tab/i.test(last)) atTab = last;
    }
    let arrivalsSelected = false;
    let arrivalsRow = '';
    if (atTab) {
      // Manual-activation tablist: ArrowRight moves focus (roving tabindex),
      // Enter/Space activates. DOM focus moves even though the VO cursor
      // doesn't follow it — Enter fires click from DOM focus.
      await voiceOver.press('ArrowRight');
      await sleep(600);
      await voiceOver.press('Enter');
      await sleep(1600); // refetch + rerender
      arrivalsSelected = await page2.evaluate(() =>
        document.querySelector('[role="tab"][data-kind="arrivals"]')?.getAttribute('aria-selected') === 'true');
      // Walk into the panel: tabs → CALLING AT filter → rows. Arrivals rows
      // say "due" (not "departs") — the spoken proof the board switched.
      for (let i = 0; i < 6 && !/due \d|view calling points/i.test(arrivalsRow); i++) {
        await voiceOver.press('Tab');
        await sleep(450);
        arrivalsRow = await voiceOver.lastSpokenPhrase();
      }
    }
    check('vo: Arrivals tab announced and the board switches to arrivals',
      !!atTab && arrivalsSelected && /due \d|view calling points/i.test(arrivalsRow),
      atTab ? (arrivalsSelected ? arrivalsRow.trim().slice(0, 80) : 'aria-selected not set') : 'tabs not reached in 14 tabs');

    // A service row link opens the calling-points page; its platform chips
    // must be spoken (they carry the full 2.4.4 name).
    let onRow = /view calling points/i.test(arrivalsRow);
    for (let i = 0; i < 6 && !onRow; i++) {
      await voiceOver.press('Tab');
      await sleep(400);
      onRow = /view calling points/i.test(await voiceOver.lastSpokenPhrase());
    }
    await voiceOver.press('Enter');
    let onService = false;
    try {
      await page2.waitForFunction(() => /\/service\//.test(location.pathname), { timeout: 15000 });
      await page2.waitForFunction(() => document.querySelectorAll('.stop-item').length >= 5, { timeout: 20000 });
      onService = true;
    } catch { /* url checked below */ }
    await sleep(1500);
    let detailPlat = null;
    for (let i = 0; i < 20 && !detailPlat; i++) {
      await voiceOver.press('Tab');
      await sleep(400);
      const last = await voiceOver.lastSpokenPhrase();
      if (/view this platform's departures and arrivals/i.test(last)) detailPlat = last;
    }
    check('vo: service row link opens calling points and platform chips are spoken',
      onService && !!detailPlat,
      detailPlat ? detailPlat.trim().slice(0, 80) : `url=${page2.url()}; platform chip not reached in 20 tabs`);

    // A platform chip opens the per-platform board; its rows must be spoken.
    await voiceOver.press('Enter');
    let onPlatform = false;
    try {
      await page2.waitForFunction(() => /\/platform\//.test(location.pathname), { timeout: 15000 });
      await page2.waitForFunction(() => document.querySelectorAll('.svc-item, .board-msg').length >= 1, { timeout: 20000 });
      onPlatform = true;
    } catch { /* url checked below */ }
    await sleep(1500);
    let platformRow = null;
    for (let i = 0; i < 15 && !platformRow; i++) {
      await voiceOver.press('Tab');
      await sleep(400);
      const last = await voiceOver.lastSpokenPhrase();
      if (/view calling points/i.test(last)) platformRow = last;
    }
    check('vo: platform chip link opens a platform board whose services are spoken',
      onPlatform && !!platformRow,
      platformRow ? platformRow.trim().slice(0, 80) : `url=${page2.url()}; rows not reached in 15 tabs`);

    // History: the delete button must SPEAK the full service description
    // (a links-list user hears it out of context), and the confirm dialog
    // must open and close on Escape (its name/description/buttons are
    // asserted by the AX layer; Chromium+VO cannot follow programmatic
    // focus into the dialog, so the spoken part is the button name).
    await page2.goto(BASE + '/service/?id=X1&from=RDG', { waitUntil: 'networkidle2', timeout: 60000 });
    await page2.waitForFunction(() => document.querySelectorAll('.stop-item').length >= 5, { timeout: 20000 });
    await page2.goto(BASE + '/history', { waitUntil: 'networkidle2', timeout: 60000 });
    await page2.waitForFunction(() => document.querySelectorAll('.hist-item').length >= 1, { timeout: 20000 });
    await sleep(1500);
    let delHeard = null;
    for (let i = 0; i < 20 && !delHeard; i++) {
      await voiceOver.press('Tab');
      await sleep(400);
      const last = await voiceOver.lastSpokenPhrase();
      if (/from history/i.test(last)) delHeard = last;
    }
    let dialogOpened = false;
    let dialogClosed = false;
    if (delHeard) {
      await voiceOver.press('Enter');
      await sleep(700);
      dialogOpened = await page2.evaluate(() => !document.getElementById('history-dialog')?.hidden);
      await page2.keyboard.press('Escape');
      await sleep(600);
      dialogClosed = await page2.evaluate(() => !!document.getElementById('history-dialog')?.hidden);
    }
    check('vo: history delete speaks the full service description; confirm opens, Escape closes',
      !!delHeard && dialogOpened && dialogClosed,
      delHeard ? `open=${dialogOpened} closed=${dialogClosed} — "${delHeard.trim().slice(0, 60)}"` : 'delete button not reached in 20 tabs');
  } finally {
    if (poller) clearInterval(poller);
    try {
      const log = captured.length ? captured : await voiceOver.spokenPhraseLog();
      console.log('  spoken log tail (last 12):');
      log.slice(-12).forEach((p) => console.log('   ·', p.trim().slice(0, 90)));
    } catch { /* already off */ }
    try { await voiceOver.stop(); } catch { /* already off */ }
    await browser.close();
    await restoreSystemVolume();
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
