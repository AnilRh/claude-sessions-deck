#!/usr/bin/env node
// Generates marketplace images (thumbnail + gallery) from the plugin's actual
// tile design, so the store shots match what the deck renders. Writes SVGs and
// rasterizes them to 366x244 PNGs with rsvg-convert.
//
//   node scripts/gen-marketplace-images.mjs
//
// Output: assets/marketplace/*.png (+ .svg sources)

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';
import { renderTile } from '../com.ulanzi.claudesessions.ulanziPlugin/plugin/renderer.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
// Store-listing images live outside the plugin folder: they're for the
// marketplace submission, not shipped in the installed .ulanziPlugin.
const OUT = path.join(ROOT, 'store-assets');
const APP_ICON_SVG = path.join(ROOT, 'com.ulanzi.claudesessions.ulanziPlugin', 'assets', 'store-icon.svg');
const W = 366;
const H = 244;
const FONT = 'Helvetica, Arial, sans-serif';

// Tiles are drawn by the SAME renderer the deck/board use (plugin/renderer.js),
// embedded as data-URI <image>s — so store shots always match the real design
// and can never drift. `machine` -> remote footer; `fresh` (0..1) shows the
// recently-changed highlight. The generator's 'done' maps to the renderer's
// 'done_unread'; other state names match.
const STATE_MAP = { done: 'done_unread' };

function place(x, y, size, state, { name = '', elapsed = '', machine = '', fresh = 0 } = {}) {
  const dataUrl = renderTile({
    state: STATE_MAP[state] || state,
    projectName: name,
    elapsed,
    serverLabel: machine,
    freshness: fresh,
  });
  return `<image xlink:href="${dataUrl}" x="${x}" y="${y}" width="${size}" height="${size}"/>`;
}

function doc(inner) {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">` +
    `<rect width="${W}" height="${H}" rx="20" fill="#0C0C0F"/>` +
    inner +
    `</svg>`
  );
}

function title(t, sub) {
  return (
    `<text x="20" y="34" font-family="${FONT}" font-size="21" font-weight="700" fill="#F4F4F6">${t}</text>` +
    (sub ? `<text x="20" y="55" font-family="${FONT}" font-size="12" font-weight="500" fill="#9A9AA2">${sub}</text>` : '')
  );
}

function caption(t) {
  return `<text x="${W / 2}" y="${H - 16}" font-family="${FONT}" font-size="14" font-weight="600" text-anchor="middle" fill="#B9B9C0">${t}</text>`;
}

// Grid helper: lays tiles left-to-right, wrapping.
function grid(items, { x0, y0, size, gap, cols }) {
  return items
    .map((it, i) => {
      const c = i % cols;
      const r = Math.floor(i / cols);
      return place(x0 + c * (size + gap), y0 + r * (size + gap), size, it.state, it);
    })
    .join('');
}

const IMAGES = {
  'thumbnail': doc(
    title('Claude Sessions', 'Live Claude Code status on your Ulanzi deck') +
      grid(
        [
          { state: 'thinking', name: 'web-app', elapsed: '4m' },
          { state: 'waiting', name: 'api' },
          { state: 'done', name: 'worker', elapsed: '2m' },
          { state: 'done', name: 'billing', elapsed: '1m', machine: 'mini' },
          { state: 'idle', name: 'docs', elapsed: '3h' },
          { state: 'thinking', name: 'infra', elapsed: '7m', machine: 'mini' },
          { state: 'error', name: 'search' },
          { state: 'empty' },
        ],
        { x0: 20, y0: 70, size: 78, gap: 9, cols: 4 }
      )
  ),
  'gallery-1-states': doc(
    title('Five states, one glance') +
      grid(
        [
          { state: 'thinking', name: 'web-app', elapsed: '4m' },
          { state: 'waiting', name: 'api' },
          { state: 'error', name: 'worker' },
          { state: 'done', name: 'billing', elapsed: '2m' },
          { state: 'idle', name: 'docs', elapsed: '3h' },
        ],
        { x0: 18, y0: 60, size: 58, gap: 10, cols: 5 }
      ) +
      `<text x="47"  y="142" font-family="${FONT}" font-size="12" text-anchor="middle" fill="#D07A56" font-weight="600">working</text>` +
      `<text x="115" y="142" font-family="${FONT}" font-size="12" text-anchor="middle" fill="#FFC53D" font-weight="600">needs you</text>` +
      `<text x="183" y="142" font-family="${FONT}" font-size="12" text-anchor="middle" fill="#E5484D" font-weight="600">errored</text>` +
      `<text x="251" y="142" font-family="${FONT}" font-size="12" text-anchor="middle" fill="#3CB262" font-weight="600">done</text>` +
      `<text x="319" y="142" font-family="${FONT}" font-size="12" text-anchor="middle" fill="#9A9AA2" font-weight="600">idle</text>` +
      caption('Amber needs you · red hit an error')
  ),
  'gallery-2-board': doc(
    title('Every session at once') +
      grid(
        [
          { state: 'thinking', name: 'web-app', elapsed: '4m' },
          { state: 'waiting', name: 'api' },
          { state: 'thinking', name: 'worker', elapsed: '1m' },
          { state: 'done', name: 'billing', elapsed: '6m' },
          { state: 'idle', name: 'docs', elapsed: '2h' },
          { state: 'done', name: 'infra', elapsed: '3m' },
          { state: 'error', name: 'search' },
          { state: 'idle', name: 'mobile', elapsed: '5h' },
          { state: 'waiting', name: 'auth' },
          { state: 'empty' },
        ],
        { x0: 20, y0: 66, size: 60, gap: 8, cols: 5 }
      ) +
      caption('Run many Claude Code sessions without losing track')
  ),
  'gallery-3-remote': doc(
    title('Local and remote machines') +
      grid(
        [
          { state: 'thinking', name: 'web-app', elapsed: '4m' },
          { state: 'done', name: 'worker', elapsed: '2m' },
          { state: 'thinking', name: 'infra', elapsed: '7m', machine: 'mini' },
          { state: 'waiting', name: 'build', machine: 'mini' },
        ],
        { x0: 17, y0: 74, size: 74, gap: 12, cols: 4 }
      ) +
      caption('A coloured footer marks sessions on another machine')
  ),
};

fs.mkdirSync(OUT, { recursive: true });
for (const [name, svg] of Object.entries(IMAGES)) {
  const svgPath = path.join(OUT, `${name}.svg`);
  const pngPath = path.join(OUT, `${name}.png`);
  fs.writeFileSync(svgPath, svg);
  execFileSync('rsvg-convert', ['-w', String(W), '-h', String(H), svgPath, '-o', pngPath]);
  console.log(`wrote ${path.relative(ROOT, pngPath)} (${W}x${H})`);
}

// Marketplace "application program icon" variant (288x288) from the app-icon
// source, in case the submission form wants exactly that size.
const appIcon288 = path.join(OUT, 'app-icon-288.png');
execFileSync('rsvg-convert', ['-w', '288', '-h', '288', APP_ICON_SVG, '-o', appIcon288]);
console.log(`wrote ${path.relative(ROOT, appIcon288)} (288x288)`);
