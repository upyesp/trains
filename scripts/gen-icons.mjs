// Generates the PWA raster icons (PNG) from on-brand SVG source.
// Re-run after changing the icon design:
//     npm i -D sharp && node scripts/gen-icons.mjs
// `sharp` is a build-time tool only; it is deliberately NOT in package.json so
// CI stays lean. The PNGs it emits are committed to public/.
import sharp from 'sharp';

// Faithful 512-scale of public/favicon.svg: a dark "live screen" tile with the
// amber signal bar, chalk schedule rows, and a platform/status dot.
function tile(rounded) {
  const bg = rounded
    ? `<rect width="512" height="512" rx="112" fill="#0d1117"/>`
    : `<rect width="512" height="512" fill="#0d1117"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  ${bg}
  <rect x="96" y="96" width="320" height="42" rx="21" fill="#f0b429"/>
  <rect x="96" y="184" width="240" height="38" rx="16" fill="#e6edf3"/>
  <rect x="96" y="266" width="304" height="38" rx="16" fill="#e6edf3"/>
  <rect x="96" y="347" width="176" height="38" rx="16" fill="#e6edf3"/>
  <rect x="378" y="347" width="42" height="38" rx="16" fill="#f0b429"/>
</svg>`;
}

const jobs = [
  // "any" purpose: rounded tile — reads as an app icon in install UI / desktop.
  ['public/icon-192.png', tile(true), 192],
  ['public/icon-512.png', tile(true), 512],
  // maskable: full-bleed square so OS masks (Android adaptive, etc.) are clean.
  ['public/icon-maskable-512.png', tile(false), 512],
  // iOS home-screen icon (full-bleed; iOS applies its own squircle mask).
  ['public/apple-touch-icon.png', tile(false), 180],
];

for (const [out, svg, size] of jobs) {
  await sharp(Buffer.from(svg)).resize(size, size).png().toFile(out);
  console.log('wrote', out, `${size}x${size}`);
}
