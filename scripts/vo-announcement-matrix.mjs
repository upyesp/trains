// Announcement-technique matrix for Chromium + VoiceOver on macOS.
//
// WHY THIS EXISTS: the durability harness records live-region spokenness on
// Chromium as info, not failure. This script is the evidence behind that
// decision. It renders ONE page that fires the same announcement through
// EIGHT different live-region techniques (plus the combobox
// aria-activedescendant pattern), verifies in the DOM that every technique
// actually delivered its text, and listens with REAL VoiceOver using
// continuous 250ms phrase capture (spot-reads miss announcements between
// keystrokes — an earlier "silent" verdict for aria-activedescendant was
// exactly that artifact).
//
// VERDICT (Chromium for Testing 152.0.7977.54, macOS 27.0.1, 2026-10-21):
//   ALL live-region techniques are silent on Chromium+VoiceOver —
//   role=status+atomic, role=status child-replacement, role=alert,
//   aria-live=polite child-swap, aria-live=polite textContent, <output>,
//   aria-live=assertive, role=log append. The announcements never reach
//   VoiceOver even with DOM-verified delivery and the VO cursor inside the
//   web content. Safari/WebKit announces all of them. This is an engine
//   gap, not a markup problem: the site already ships the recommended
//   pattern (role="status" + aria-atomic="true", meaningful changes only).
//   aria-activedescendant option announcements DO work ("Iguana option
//   selected (1 of 3)") and are asserted in the main harness.
//
// Re-run after Chromium upgrades to check whether the engine gap closed:
//   npm run audit:matrix        # from a Terminal with AX/Automation grants
// (or: open -a Terminal ~/.vo-matrix.command)
//
// Takes over the Mac's audio while running (real VoiceOver).
import puppeteer from 'puppeteer';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Live region matrix</title></head>
<body>
<h1>Live region experiment</h1>
<button id="go">Run announcements</button>
<div id="r1" class="vh" role="status" aria-live="polite" aria-atomic="true"></div>
<div id="r2" class="vh" role="status"></div>
<div id="r3" class="vh" role="alert"></div>
<div id="r4" class="vh" aria-live="polite"></div>
<div id="r5" style="position:fixed;bottom:8px;left:8px" aria-live="polite"></div>
<output id="r6" class="vh"></output>
<div id="r7" class="vh" aria-live="assertive"></div>
<div id="r8" class="vh" role="log"></div>
<div id="combo-wrap">
  <input id="cb" role="combobox" aria-expanded="true" aria-controls="lb" aria-autocomplete="list" autocomplete="off">
  <ul id="lb" role="listbox">
    <li id="lb-opt-0" role="option" aria-selected="false">Iguana option</li>
    <li id="lb-opt-1" role="option" aria-selected="false">Jaguar option</li>
    <li id="lb-opt-2" role="option" aria-selected="false">Koala option</li>
  </ul>
</div>
<style>.vh{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}</style>
<script>
// Eight delivery techniques, each announcing a unique payload so the
// captured phrase log attributes speech to exactly one technique. The
// combobox pattern is driven separately with ArrowDown.
const seq = [
  ['r1', 'alpha status atomic text',   (el, txt) => { el.textContent = txt; }],
  ['r2', 'bravo status child replace', (el, txt) => { el.replaceChildren(); el.appendChild(document.createTextNode('')); el.textContent = txt; }],
  ['r3', 'charlie alert text',         (el, txt) => { el.textContent = txt; }],
  ['r4', 'delta polite child swap',    (el, txt) => { el.replaceChildren(Object.assign(document.createElement('span'), { textContent: txt })); }],
  ['r5', 'echo polite text',           (el, txt) => { el.textContent = txt; }],
  ['r6', 'foxtrot output',             (el, txt) => { el.textContent = txt; }],
  ['r7', 'golf assertive',             (el, txt) => { el.textContent = txt; }],
  ['r8', 'hotel log append',           (el, txt) => { const p = document.createElement('p'); p.textContent = txt; el.appendChild(p); }],
];
let i = 0;
document.getElementById('go').addEventListener('click', () => {
  const step = () => {
    if (i >= seq.length) return;
    const [id, txt, fn] = seq[i++];
    fn(document.getElementById(id), txt);
    setTimeout(step, 2200);
  };
  step();
});
const input = document.getElementById('cb');
const list = document.getElementById('lb');
let active = -1;
input.addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowDown') return;
  e.preventDefault();
  active = Math.min(active + 1, 2);
  [...list.children].forEach((li, idx) => li.setAttribute('aria-selected', idx === active ? 'true' : 'false'));
  input.setAttribute('aria-activedescendant', \`lb-opt-\${active}\`);
});
</script>
</body></html>`;

const PAYLOADS = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'Iguana', 'Jaguar', 'Koala'];
const PORT = 8899;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findChrome() {
  if (process.env.CHROME_BIN && existsSync(process.env.CHROME_BIN)) return process.env.CHROME_BIN;
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

const activateChrome = () =>
  new Promise((res) => execFile('/usr/bin/osascript', ['-e', 'tell application "Google Chrome for Testing" to activate'], () => res()));
const killVo = () =>
  new Promise((res) => execFile('/usr/bin/pkill', ['-f', 'VoiceOver.app/Contents/MacOS/VoiceOver'], () => res()));

async function attempt(n) {
  const { voiceOver } = await import('@guidepup/guidepup');
  const browser = await puppeteer.launch({
    headless: false,
    executablePath: findChrome(),
    args: ['--no-sandbox', '--no-first-run', '--no-default-browser-check', '--window-size=1100,800', '--window-position=60,60'],
  });
  const heard = [];
  const seen = new Set();
  // Continuous capture — the whole point (see header).
  const poll = setInterval(() => {
    voiceOver.lastSpokenPhrase().then((p) => {
      const t = p.trim();
      if (t && !seen.has(t)) { seen.add(t); heard.push(t); }
    }).catch(() => {});
  }, 250);
  try {
    await voiceOver.start();
    await sleep(800);
    await activateChrome();
    await sleep(1200);
    const page = (await browser.pages())[0] ?? (await browser.newPage());
    // http://localhost — NOT file://: omnibox tab-completion eats the Tab
    // on file:// URLs and the keyboard walk never enters the page.
    await page.goto(`http://localhost:${PORT}/vo-matrix.html`, { waitUntil: 'load', timeout: 60000 });
    await sleep(2000);
    let inContent = false;
    for (let i = 0; i < 8 && !inContent; i++) {
      await voiceOver.press('Tab');
      await sleep(450);
      const last = await voiceOver.lastSpokenPhrase();
      console.log(`  walk[${i}]: "${last.trim().slice(0, 50)}"`);
      if (/Run announcements/i.test(last)) inContent = true;
    }
    if (!inContent || heard.length === 0) return { ok: false, reason: `walk failed (heard=${heard.length})` };
    // Trigger via the DOM — this experiment measures announcement DELIVERY,
    // not click mechanics.
    await page.evaluate(() => document.getElementById('go').click());
    for (let s = 0; s < 22; s++) await sleep(1000);
    // Combobox: DOM-focus the input, then real ArrowDowns.
    await page.evaluate(() => document.getElementById('cb').focus());
    await sleep(400);
    for (let i = 0; i < 3; i++) {
      await voiceOver.press('ArrowDown');
      await sleep(1200);
    }
    await sleep(1500);
    const regions = await page.evaluate(() =>
      ['r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7', 'r8']
        .map((id) => `${id}="${(document.getElementById(id)?.textContent ?? '').slice(0, 14)}"`).join(' '));
    console.log('  region contents (DOM delivery check):', regions);
    return { ok: true, heard, regions };
  } finally {
    clearInterval(poll);
    try { await voiceOver.stop(); } catch { /* already off */ }
    await browser.close();
  }
}

console.log('VoiceOver announcement matrix — Chromium live-region delivery\n');
const server = createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(PAGE);
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
const dir = mkdtempSync(join(tmpdir(), 'vo-matrix-'));
try {
  writeFileSync(join(dir, 'vo-matrix.html'), PAGE);
  let result = null;
  for (let n = 1; n <= 3 && !result?.ok; n++) {
    console.log(`=== attempt ${n} ===`);
    result = await attempt(n);
    if (!result?.ok) { console.log(`  ${result?.reason}; restarting VoiceOver`); await killVo(); await sleep(3000); }
  }
  if (result?.ok) {
    console.log('=== captured phrases ===');
    result.heard.forEach((p) => console.log(' ·', p.slice(0, 100)));
    console.log('=== technique verdicts ===');
    for (const key of PAYLOADS) {
      const hit = result.heard.find((p) => p.toLowerCase().includes(key.toLowerCase()));
      console.log(`${hit ? 'SPOKEN ' : 'SILENT '} ${key}${hit ? ` — "${hit.trim().slice(0, 60)}"` : ''}`);
    }
  } else {
    console.log('MATRIX FAILED: no usable VoiceOver session in 3 attempts');
    process.exitCode = 2;
  }
} finally {
  server.close();
  rmSync(dir, { recursive: true, force: true });
}
