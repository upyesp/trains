// WCAG contrast audit for the trains site. Run: node scripts/contrast-audit.mjs
// Computes the actual contrast ratio for every text/background pair in both the
// dark board and the light concourse, and reports AA / AAA pass/fail.
function lin(hex) {
  const c = hex.replace('#', '');
  return [0, 2, 4].map((i) => parseInt(c.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
}
function lum(hex) { const [a, b, c] = lin(hex); return 0.2126 * a + 0.7152 * b + 0.0722 * c; }
function ratio(fg, bg) {
  const f = lum(fg), b = lum(bg);
  return (Math.max(f, b) + 0.05) / (Math.min(f, b) + 0.05);
}
// Blend a translucent fg over bg in linear space, return an sRGB hex.
function blend(fg, alpha, bg) {
  const a = lin(fg), base = lin(bg);
  const out = a.map((v, i) => v * alpha + base[i] * (1 - alpha));
  return '#' + out.map((v) => Math.round(
    (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055) * 255)
    .toString(16).padStart(2, '0')).join('');
}
function verdict(r, large) {
  const aa = large ? 3 : 4.5, aaa = large ? 4.5 : 7;
  return r >= aaa ? 'AAA' : r >= aa ? 'AA ' : 'FAIL';
}
function report(title, rows) {
  console.log(`\n=== ${title} ===`);
  for (const [name, fg, bg, large] of rows) {
    const r = ratio(fg, bg);
    console.log(`  ${verdict(r, large)}  ${r.toFixed(2).padStart(5)}:1  ${name}`);
  }
}

const ink = '#0d1117', panel = '#151b23';
const paper = '#f6f7f9', paper2 = '#eceef2', white = '#ffffff';
const chalk = '#e6edf3', ash = '#94a3b8', slate = '#1b232e', mute = '#5a6573';
const amber = '#f0b429', redBright = '#ff7d80', ph = '#6b727c';

// Chips now have transparent backgrounds, so text sits directly on --ink.

report('DARK BOARD  (text on --ink #0d1117)', [
  ['destination + on-time time (chalk)', chalk, ink, false],
  ['delay expected time (amber)', amber, ink, true],   // 1.4rem bold ~ large
  ['delay scheduled time (ash)', ash, ink, false],
  ['operator .toc (ash)', ash, ink, false],
  ['platform number (chalk on --panel)', chalk, panel, false],
  ['platform PROVISIONAL label (ash on panel)', ash, panel, false],
  ['no-platform dash (ash)', ash, ink, false],
  ['column header .board-cols (ash)', ash, ink, false],
  ['as-of / loading message (ash)', ash, ink, false],
  ['delay chip text (amber on ink, transparent bg)', amber, ink, false],
  ['cancel chip text (red-bright on ink, transparent bg)', redBright, ink, false],
  ['error message .board-msg.error (red-bright)', redBright, ink, false],
]);

report('LIGHT CONCOURSE  (text on --paper #f6f7f9)', [
  ['station name / brand (slate)', slate, paper, true],
  ['live label / input text (slate)', slate, paper, false],
  ['CRS code (slate)', slate, paper, false],
  ['CRS label + clock (slate-mute)', mute, paper, false],
  ['selected tab (slate on #fff)', slate, white, false],
  ['unselected tab (slate-mute on paper-2)', mute, paper2, false],
  ['search label (slate-mute)', mute, paper, false],
  ['search placeholder (#6b727c on #fff)', ph, white, false],
  ['station link card (slate on #fff)', slate, white, false],
]);
