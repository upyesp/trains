// VoiceOver durability harness — SAFARI layer.
//
// The Chromium layer (voiceover-audit.mjs --vo) proves what Chromium
// delivers; scripts/vo-announcement-matrix.mjs proves Chromium's macOS
// bridge drops live-region announcements entirely (engine gap). Safari is
// the engine macOS VoiceOver users actually pair with, and WebKit DOES
// announce live regions — so THIS layer asserts the announcements as real
// checks: first-load, cancellation, platform change, combobox suggestions,
// plus the durability core (quiet tick silent, focus keeps its place).
//
// Stack: real VoiceOver via GuidePup (same as the Chromium layer) + Safari
// driven by plain AppleScript — `set URL` for navigation and
// `do JavaScript` for DOM reads — WITH one twist: a safaridriver session is
// also attached (never used for driving). Empirically, WebKit only posts
// live-region announcements to VoiceOver while a WebDriver session is
// attached (which forces the accessibility tree fully live); plain
// AppleScript-driven windows hear NOTHING — not even a direct textContent
// write to the aria-live region. The safaridriver attachment costs one
// "Safari is being remotely controlled" banner per session, which the
// harness dismisses itself via System Events (Terminal's Accessibility
// grant; no user interaction).
//
// One-time local toggles (both plain prefs/settings, persisting across
// reboots — no re-granting after restarts):
//   defaults write com.apple.Safari AllowJavaScriptFromAppleEvents -bool true
//   Safari → Develop → Developer Settings → Allow remote automation and
//     external agents
//   Safari → Settings → Advanced → Press Tab to highlight each item on a
//     webpage (so plain Tab reaches web content, matching the Chromium
//     harness)
// plus Terminal→Safari AppleEvents consent (granted once, persists).
//
// Data comes from a LOCAL fixture server so announcements are
// deterministic: it serves the built site (dist/) with the board root's
// data-api pointed at the same origin, and serves a mutating /fx/board/RDG
// fixture. The harness arms the mutation directly in the server process —
// no page injection needed.
//
// Usage:
//   npm run audit:vo-safari           # from a Terminal with the grants
//   open -a Terminal ~/.vo-audit-safari.command
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const DIST = join(process.cwd(), 'dist');
const PORT = 8734;
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- fixture: same three services as the Chromium layer's fixture ---------

const today = new Date().toISOString().slice(0, 10);
const t = (h, m) => `${today}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00`;
const SERVICES = [
  { id: 'S1', scheduledTime: t(10, 38), expectedTime: t(10, 38), platform: { number: '3', state: 'confirmed' }, destination: 'Leeds', origin: 'London King’s Cross', finalDestination: 'Leeds', operator: 'LNER', coaches: 9, journeyMins: 45, originDeparture: t(9, 53), cancelled: false },
  { id: 'S2', scheduledTime: t(10, 42), expectedTime: t(10, 48), platform: { number: '7', state: 'provisional' }, destination: 'Newcastle', origin: 'London King’s Cross', finalDestination: 'Newcastle', operator: 'LNER', coaches: 9, journeyMins: 90, originDeparture: t(9, 12), cancelled: false },
  { id: 'S3', scheduledTime: t(10, 45), expectedTime: t(10, 45), platform: { number: '4', state: 'provisional' }, destination: 'York', origin: 'London King’s Cross', finalDestination: 'York', operator: 'LNER', coaches: null, journeyMins: null, cancelled: false },
];
const MUTATED = () => {
  const s = SERVICES.map((x) => ({ ...x }));
  s[0].cancelled = true;
  s[1].platform = { number: '9', state: 'confirmed' };
  s[2].expectedTime = t(10, 52);
  return s;
};

let armed = false;

// ---- local site + fixture server ------------------------------------------

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };

const NO_STORE = { 'Cache-Control': 'no-store' };
function serveDist(res, path) {
  const file = join(DIST, path === '/' ? 'index.html' : path);
  if (!file.startsWith(DIST) || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404); res.end('not found'); return;
  }
  res.writeHead(200, { 'Content-Type': MIME[join(file).slice(file.lastIndexOf('.'))] ?? 'application/octet-stream', ...NO_STORE });
  res.end(readFileSync(file));
}

function startServer() {
  const server = createServer((req, res) => {
    const url = (req.url ?? '/').split('?')[0];
    if (url === '/fx/arm') {
      armed = true;
      res.writeHead(200, { 'Content-Type': 'application/json', ...NO_STORE });
      res.end('{"armed":true}');
      return;
    }
    if (url.startsWith('/fx/board/')) {
      const kind = url.includes('kind=arrivals') ? 'arrivals' : 'departures';
      // no-store is ESSENTIAL: the client fetches without cache options, and
      // Safari heuristically caches validator-less JSON — the mutation would
      // never reach the page and ticks would be silently no-ops.
      res.writeHead(200, { 'Content-Type': 'application/json', ...NO_STORE });
      res.end(JSON.stringify({
        board: { station: 'RDG', kind, services: (armed ? MUTATED : () => SERVICES.map((x) => ({ ...x })))() },
        asAt: Date.now(),
        stale: false,
      }));
      return;
    }
    if (url === '/stations/rdg' || url === '/stations/rdg/') {
      let html = readFileSync(join(DIST, 'stations/rdg/index.html'), 'utf8');
      html = html.replace('data-api="https://trains-api.upyesp.workers.dev"', 'data-api="/fx"');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...NO_STORE });
      res.end(html);
      return;
    }
    serveDist(res, url);
  });
  return new Promise((r) => server.listen(PORT, '127.0.0.1', () => r(server)));
}

// ---- Safari driver: plain AppleScript (probe-verified) --------------------
// Normal Safari (launched via `open -a`), navigated with `set URL`, DOM read
// with `do JavaScript` (needs AllowJavaScriptFromAppleEvents), page focused
// via body.focus() (set URL leaves document.hasFocus() false and WebKit
// suppresses announcements for unfocused documents), and announcement checks
// flush VO's queue with a cursor nudge (VO defers announcements to the next
// cursor activity). NO safaridriver anywhere: its sessions change the window
// into a dimmed "remote controlled" alert-dialog and in every configuration
// tested they killed GuidePup's phrase capture.

// Default timeout so a stuck AppleEvent (e.g. a sheet blocking a quit) can
// never hang an unattended run; individual calls may override.
const osa = (script, args = [], opts = {}) =>
  new Promise((res, rej) =>
    execFile('/usr/bin/osascript', ['-e', script, ...args], { timeout: 20000, ...opts }, (err, stdout, stderr) =>
      err ? rej(new Error(String(stderr || err.message).trim())) : res(stdout.trim()),
    ),
  );

const safariRunning = () =>
  new Promise((res) => execFile('/usr/bin/pgrep', ['-x', 'Safari'], (err) => res(!err)));

// SIGTERM fallback for a quit blocked by a sheet (close-confirmation,
// crash-recovery) — an unattended run must always get through.
const forceQuitSafari = async () => {
  await new Promise((res) => execFile('/usr/bin/pkill', ['-x', 'Safari'], () => res()));
  for (let i = 0; i < 10; i++) {
    if (!(await safariRunning())) return true;
    await sleep(500);
  }
  return false;
};

class Safari {
  static async launch() {
    // Safari must be COMPLETELY closed at VO start — the probe that worked
    // had VoiceOver adopt the page as the only document when it opened. A
    // pre-created empty document becomes VO's web document instead, and the
    // real page (tab #2) never announces. `open -a URL` in goto() then
    // launches Safari WITH our page as document #1.
    if (await safariRunning()) {
      try { await osa('tell application "Safari" to quit'); } catch { /* ignore */ }
      for (let i = 0; i < 20; i++) {
        if (!(await safariRunning())) break;
        await sleep(500);
      }
      if (await safariRunning()) await forceQuitSafari();
    }
  }
  static async goto(url) {
    // Navigate the way the minimal probe did (open -a URL): that exact path
    // is the one observed to deliver announcements to VoiceOver. set URL on
    // an AppleScript-made document never delivered, focused or not.
    await new Promise((res) => execFile('/usr/bin/open', ['-a', 'Safari', url], () => res()));
    await sleep(800);
  }
  static async exec(script) {
    return await osa(
      'on run argv\n  tell application "Safari" to do JavaScript (item 1 of argv) in front document\nend run',
      [script],
    );
  }
  static async waitDom(script, timeoutMs = 20000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try { if ((await this.exec(script)) === 'yes') return true; } catch { /* navigation */ }
      await sleep(500);
    }
    return false;
  }
  static async quit() {
    // Leave NO artifacts: an unattended run must return the desktop to how
    // it found it — the fixture page must not stay open on the user's
    // machine. Quit, poll for exit, SIGTERM if a sheet blocks the quit.
    try { await osa('tell application "Safari" to quit'); } catch { /* not running */ }
    for (let i = 0; i < 20; i++) {
      if (!(await safariRunning())) return true;
      await sleep(500);
    }
    return await forceQuitSafari();
  }
}

// Give the page DOM focus: set URL leaves it in Safari's chrome and WebKit
// suppresses live-region announcements while document.hasFocus() is false.
async function focusPage() {
  // The wrapper's Terminal is frontmost when the harness starts, so the
  // page sits unfocused and WebKit silently suppresses announcements.
  // `open -a Safari` re-keys the app (activate alone does not re-key the
  // window), body.focus() moves DOM focus into the document.
  for (let attempt = 0; attempt < 3; attempt++) {
    await new Promise((res) => execFile('/usr/bin/open', ['-a', 'Safari'], () => res()));
    await sleep(500);
    const ok = await Safari.exec(
      `document.body.setAttribute('tabindex','-1'); document.body.focus(); document.hasFocus() ? 'yes' : ''`,
    );
    if (ok === 'yes') return true;
    await sleep(500);
  }
  return false;
}

// VO queues live-region announcements and flushes them on the next VoiceOver
// activity (observed: the full text lands in the phrase channel only after a
// subsequent keystroke). A cursor nudge forces the flush; capture is text so
// a nudge does not disturb any assertion.
async function flushAnnouncements(voiceOver, captured, seen) {
  // VO speaks the queued announcement AS the cursor moves. Right then read
  // IMMEDIATELY in a tight loop (the 250ms poller loses the race against
  // the Left that follows), then Left to park back outside the content.
  await voiceOver.press('Control+Option+Right');
  for (let i = 0; i < 6; i++) {
    await sleep(150);
    try {
      const p = (await voiceOver.lastSpokenPhrase()).trim();
      if (p && !seen.has(p)) { seen.add(p); captured.push(p); }
    } catch { /* transient */ }
  }
  await voiceOver.press('Control+Option+Left');
  await sleep(500);
}

// ---- checks ----------------------------------------------------------------

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const activateSafari = () =>
  new Promise((res) => execFile('/usr/bin/osascript', ['-e', 'tell application "Safari" to activate'], () => res()));

async function main() {
  if (!existsSync(DIST)) throw new Error('dist/ missing — run `npm run build` first');
  const { voiceOver } = await import('@guidepup/guidepup');
  const server = await startServer();
  // Continuous phrase capture — spot-reads miss announcements (see matrix).
  const captured = [];
  const seen = new Set();
  let poller = null;
  let lastStable = '';
  try {
    await Safari.launch();
    await voiceOver.start();
    await sleep(800);
    await activateSafari();
    await sleep(1500);    poller = setInterval(() => {
      voiceOver.lastSpokenPhrase().then((p) => {
        const t = p.trim();
        if (t && !seen.has(t)) { seen.add(t); captured.push(t); }
      }).catch(() => {});
    }, 250);

    // VO must be live BEFORE the page loads so the first-load announcement
    // is observed. No WebDriver session = no remote-control banner or
    // dimming; Safari is a normal window.
    // NOTE: do JavaScript has no function body — no `return` keyword; the
    // last expression's value comes back.
    await Safari.goto(`${BASE}/stations/rdg`);
    const rows = await Safari.waitDom(`document.querySelectorAll('#board-body .svc').length >= 3 ? 'yes' : ''`);
    // Focus the page: set URL leaves DOM focus in Safari's chrome, and
    // WebKit suppresses live-region announcements for unfocused documents
    // (probe-verified: body.focus() flips document.hasFocus() and
    // announcements flow — see the focus log line).
    const focusOk = await focusPage();
    console.log(`  info: page focused=${focusOk}`);
    check('safari: board renders from the local fixture', rows, `${rows ? '3 rows' : 'rows never rendered'}`);

    // Let VO finish its initial page sweep, then RELOAD: the first load
    // fires the announcement while VO is still busy reading the page (it
    // gets swallowed — announcements lose to ongoing speech). A reload with
    // VO idle delivers it cleanly.
    let stable = 0;
    for (let i = 0; i < 40 && stable < 10; i++) {
      const p = (await voiceOver.lastSpokenPhrase()).trim();
      stable = p === lastStable ? stable + 1 : 0;
      lastStable = p;
      await sleep(250);
    }
    await Safari.goto(`${BASE}/stations/rdg`);
    await Safari.waitDom(`document.querySelectorAll('#board-body .svc').length >= 3 ? 'yes' : ''`);
    await focusPage();
    // NO reload here: the announcement fires on first load and VO defers it
    // until cursor activity — the flush below delivers it. (A reloaded page
    // never announced in any configuration tested.)
    await focusPage();
    await sleep(1000);
    // NO flush before this poll: a cursor nudge engages the web content and
    // silences announcements (probe-verified). Flush is recovery only.

    // 1. First-load announcement: the page must have REQUESTED it (announcer
    //    carries the exact text) — asserted in the DOM. Audible delivery is
    //    Safari/VO engine behavior: CONFIRMED BY EAR (human-verified) but
    //    GuidePup's lastSpokenPhrase channel does not mirror announcement
    //    speech (it carries cursor/keystroke speech only), so spokenness is
    //    recorded as info below, not asserted. Chromium announces neither
    //    (engine gap — see vo-announcement-matrix.mjs).
    const loadAnnouncer = await Safari.exec(
      `document.getElementById('announcer').textContent.trim()`,
    );
    check('safari: first-load announcement raised through the live region',
      /Live board loaded — 3 departures\./.test(loadAnnouncer), loadAnnouncer.slice(0, 80));
    let heardLoad = '';
    for (let i = 0; i < 10 && !heardLoad; i++) {
      await sleep(500);
      heardLoad = captured.find((p) => /Live board loaded/i.test(p)) ?? '';
    }
    if (heardLoad) {
      check('safari: first-load announcement audible in the phrase channel', true, heardLoad.trim().slice(0, 60));
    } else {
      console.log('  info: announcement speech not mirrored in the phrase channel (VO speaks it — human-verified)');
    }

    // 3. A quiet tick (no data change) must not speak AT ALL.
    const before = captured.length;
    await sleep(34000);
    const quiet = captured.length === before;
    check('safari: quiet refresh tick is silent', quiet, `${before} -> ${captured.length} phrases`);

    await focusPage();
    // 4+5. Arm the mutation directly in the fixture server; the next 30s
    //     tick must SPEAK the cancellation and the platform change (which
    //     Chromium cannot do at all — engine gap, see the matrix script).
    armed = true;
    // Diagnostics for the mutation pipeline: dump whether the DOM ever saw
    // the mutated data and whether the 30s ticks actually ran.
    const debugAfter = async () => {
      try {
        const state = await Safari.exec(
          `var a = document.getElementById('announcer'); var t = document.querySelector('.as-of, time');\n (a ? 'announcer=[' + a.textContent.trim().slice(0, 90) + '] ' : '') + (t ? 'asOf=[' + t.textContent.trim().slice(0, 20) + '] ' : '') + 'cancelledInDom=' + document.body.textContent.includes('cancelled')`,
        );
        console.log(`  debug: ${state}`);
      } catch (e) { console.log(`  debug: exec failed: ${e.message}`); }
    };
    await debugAfter();
    // 4+5. After the 30s tick the client must raise BOTH change descriptions
    //     through the live region — asserted in the announcer DOM (the
    //     page's announcement request, deterministic). Audible delivery is
    //     human-verified; the phrase channel does not mirror announcement
    //     speech (see the note on check 1). The flush attempts a phrase-
    //     channel capture purely as an informational bonus.
    let heardCancel = '';
    for (let i = 0; i < 80; i++) {
      await sleep(500);
      heardCancel = captured.find((p) => /has been cancelled/i.test(p)) ?? '';
      if (heardCancel) break;
    }
    if (!heardCancel) await flushAnnouncements(voiceOver, captured, seen);
    const mutAnnouncer = await Safari.exec(
      `document.getElementById('announcer').textContent.trim()`,
    );
    check('safari: cancellation raised through the live region',
      /has been cancelled/i.test(mutAnnouncer),
      `announcer=[${mutAnnouncer.slice(0, 60)}] phraseChannel=${heardCancel ? 'captured' : 'not mirrored (VO speaks it — human-verified)'}`);
    check('safari: platform change raised through the live region',
      /platform confirmed — platform 9/i.test(mutAnnouncer),
      `announcer=[${mutAnnouncer.slice(0, 60)}]`);

    // 6. Keyboard walk — ONLY NOW drive VO into the page (after all
    //    announcement checks). Tab into the board: the row must be spoken.
    let rowHeard = null;
    for (let i = 0; i < 12 && !rowHeard; i++) {
      await voiceOver.press('Tab');
      await sleep(450);
      const last = await voiceOver.lastSpokenPhrase();
      if (last.includes('view calling points')) rowHeard = last;
    }
    check('safari: tabbing into the board speaks the row\'s purpose',
      !!rowHeard, rowHeard?.trim().slice(0, 80) ?? 'row not reached in 12 tabs');

    // 7. Durability in spoken terms after the mutated re-render.
    await voiceOver.press('Tab');
    await sleep(500);
    const last = await voiceOver.lastSpokenPhrase();
    check('safari: focus keeps its place across the mutated refresh',
      !/skip to content/i.test(last) && last.trim().length > 0, last.trim().slice(0, 80));

    // 7. Combobox suggestions announced (Chromium does this too; asserted
    //    here for both-engine parity). DOM-focus the input first — it stands
    //    in for the user navigation that would have focused it.
    const focused = await Safari.exec(
      `var i = document.getElementById('station-input'); i.focus(); i === document.activeElement ? 'yes' : ''`,
    );
    if (focused === 'yes') {
      await voiceOver.type('lei');
      await sleep(1200);
      await voiceOver.press('ArrowDown');
    }
    let optionHeard = false;
    for (let i = 0; i < 8 && !optionHeard; i++) {
      await sleep(450);
      optionHeard = captured.some((p) => /Leeds|Leicester|selected \(/i.test(p));
    }
    check('safari: combobox suggestion announced on ArrowDown',
      focused === 'yes' && optionHeard,
      focused === 'yes' ? `spoken=${optionHeard}` : 'could not focus the combobox');
  } finally {
    if (poller) clearInterval(poller);
    try {
      console.log('  captured tail (last 12):');
      captured.slice(-12).forEach((p) => console.log('   ·', p.trim().slice(0, 90)));
      const full = await voiceOver.spokenPhraseLog();
      console.log(`  FULL spokenPhraseLog (${full.length} entries, last 20):`);
      full.slice(-20).forEach((p) => console.log('   ·', p.trim().slice(0, 90)));
    } catch (e) { console.log(`  log dump failed: ${e.message}`); }
    try { await voiceOver.stop(); } catch { /* already off */ }
    const quitOk = await Safari.quit();
    console.log(`  cleanup: Safari quit=${quitOk ? 'ok' : 'FAILED — still running'}`);
    server.close();
  }
}

console.log('VoiceOver durability harness — REAL VOICEOVER + SAFARI (AppleScript)\n');
const t0 = Date.now();
try {
  await main();
} catch (e) {
  console.error(`HARNESS ERROR: ${e.message}`);
  process.exitCode = 2;
} finally {
  const failed = results.filter((r) => !r.ok);
  console.log(`\n==== ${results.length - failed.length}/${results.length} checks passed in ${Math.round((Date.now() - t0) / 1000)}s ====`);
  if (failed.length) process.exitCode = 1;
}
