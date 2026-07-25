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

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
// Store-listing images live outside the plugin folder: they're for the
// marketplace submission, not shipped in the installed .ulanziPlugin.
const OUT = path.join(ROOT, 'store-assets');
const APP_ICON_SVG = path.join(ROOT, 'com.ulanzi.claudesessions.ulanziPlugin', 'assets', 'store-icon.svg');
const W = 366;
const H = 244;
const FONT = 'Helvetica, Arial, sans-serif';
const MINI = '#3B4CC0'; // machine accent for "mini" (matches originColor hash)

let clipN = 0;

// Inner tile art in the renderer's 0..200 coordinate space, so shapes match
// plugin/renderer.js. `machine` truthy -> remote footer; else local elapsed.
function tileBody(state, { name = '', elapsed = '', machine = '' } = {}) {
  const nameText = (y, fill) =>
    name
      ? `<text x="100" y="${y}" font-family="${FONT}" font-size="30" font-weight="700" text-anchor="middle" fill="${fill}">${name}</text>`
      : '';
  const elapsedText = (y, fill) =>
    elapsed
      ? `<text x="100" y="${y}" font-family="${FONT}" font-size="26" font-weight="600" text-anchor="middle" fill="${fill}">${elapsed}</text>`
      : '';
  const footer = () => {
    const id = `clip${clipN++}`;
    return (
      `<clipPath id="${id}"><rect x="6" y="6" width="188" height="188" rx="44"/></clipPath>` +
      `<g clip-path="url(#${id})">` +
      `<rect x="6" y="154" width="188" height="40" fill="${MINI}"/>` +
      `<text x="24" y="181" font-family="${FONT}" font-size="22" font-weight="700" letter-spacing="1" text-anchor="start" fill="#EEF3FA">${machine.toUpperCase()}</text>` +
      (elapsed
        ? `<text x="176" y="181" font-family="${FONT}" font-size="22" font-weight="600" text-anchor="end" fill="#EEF3FA">${elapsed}</text>`
        : '') +
      `</g>`
    );
  };
  const R = `x="6" y="6" width="188" height="188" rx="44"`;
  switch (state) {
    case 'empty':
      return `<rect ${R} fill="#141416"/><circle cx="100" cy="100" r="7" fill="#3A3A3E"/>`;
    case 'idle':
      return (
        `<rect ${R} fill="#2C2C33"/>` +
        `<circle cx="100" cy="70" r="7" fill="#6E7F94"/>` +
        nameText(124, '#DEDEE4') +
        (machine
          ? footer()
          : `<text x="100" y="156" font-family="${FONT}" font-size="20" font-weight="600" text-anchor="middle" fill="#7E7E88">idle · ${elapsed}</text>`)
      );
    case 'thinking': {
      const dots = [0, 1, 2]
        .map((i) => `<circle cx="${100 + (i - 1) * 30}" cy="66" r="${i === 1 ? 11 : 8}" fill="#FFFFFF" opacity="${i === 1 ? 0.95 : 0.55}"/>`)
        .join('');
      return (
        `<rect ${R} fill="url(#grad)"/>` +
        dots +
        nameText(128, '#FFFFFF') +
        (machine ? footer() : elapsedText(164, '#FFF3EC'))
      );
    }
    case 'waiting':
      return (
        `<rect ${R} fill="#FFC53D"/>` +
        `<text x="100" y="98" font-family="${FONT}" font-size="82" font-weight="800" text-anchor="middle" fill="#1C1C1E">?</text>` +
        nameText(138, '#1C1C1E') +
        (machine ? footer() : elapsedText(172, '#4A3A10'))
      );
    case 'done':
      return (
        `<rect ${R} fill="#2E9E4F"/>` +
        `<path d="M 76 78 l 16 16 l 32 -34" stroke="#FFFFFF" stroke-width="12" stroke-linecap="round" stroke-linejoin="round" fill="none"/>` +
        nameText(134, '#FFFFFF') +
        (machine ? footer() : elapsedText(168, '#DDF5E4'))
      );
    case 'error':
      return (
        `<rect ${R} fill="#E5484D"/>` +
        `<text x="100" y="98" font-family="${FONT}" font-size="82" font-weight="800" text-anchor="middle" fill="#FFFFFF">!</text>` +
        nameText(138, '#FFFFFF') +
        (machine ? footer() : elapsedText(172, '#FCE4E4'))
      );
    default:
      return '';
  }
}

function place(x, y, size, state, opts) {
  const s = (size / 200).toFixed(4);
  return `<g transform="translate(${x},${y}) scale(${s})">${tileBody(state, opts)}</g>`;
}

function doc(inner) {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">` +
    `<defs><linearGradient id="grad" x1="0" y1="0" x2="0" y2="1">` +
    `<stop offset="0" stop-color="#E08862"/><stop offset="1" stop-color="#C7603C"/></linearGradient></defs>` +
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
