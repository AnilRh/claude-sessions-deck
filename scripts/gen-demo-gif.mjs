#!/usr/bin/env node
// Generates the animated hero GIF (store-assets/demo.gif) from the plugin's
// REAL renderer — no hardware or screen recording needed, and it can't drift
// from the actual tile design. Tiles are composed as data-URI <image>s (same
// technique as gen-marketplace-images.mjs), one board SVG per frame; frames are
// rasterized with rsvg-convert and encoded to a looping GIF with ffmpeg.
//
//   node scripts/gen-demo-gif.mjs      (or: npm run demo)
//
// Story (~7 s loop): a session goes thinking -> waiting-on-you (amber) ->
// thinking -> done with the freshness pop settling; a neighbour keeps thinking,
// one sits idle, and a remote (mini) session finishes too.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';
import { renderTile } from '../com.ulanzi.claudesessions.ulanziPlugin/plugin/renderer.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'store-assets', 'demo.gif');
const FPS = 4;
const FRAMES = 28;
const S = 130; // tile size (px)
const GAP = 12;
const PAD = 22;

// Dots pulse once per second (toggle every 2 frames at 4 fps), matching the deck.
const dotFrame = (f) => Math.floor(f / 2) % 2;

// The five tiles for frame f. `state` uses the generator's 'done'; mapped to the
// renderer's 'done_unread' in tile().
function tilesAt(f) {
  // Protagonist: thinking -> waiting -> thinking -> done (freshness settling).
  let t0;
  if (f < 8) t0 = { state: 'thinking', name: 'web-app', elapsed: '4m', frame: dotFrame(f) };
  else if (f < 14) t0 = { state: 'waiting', name: 'web-app', elapsed: 'now' };
  else if (f < 18) t0 = { state: 'thinking', name: 'web-app', elapsed: 'now', frame: dotFrame(f) };
  else t0 = { state: 'done', name: 'web-app', elapsed: 'now', fresh: Math.max(0, 1 - (f - 18) / 9) };

  const t1 = { state: 'thinking', name: 'api', elapsed: '2m', frame: dotFrame(f) };
  const t2 = { state: 'done', name: 'worker', elapsed: '11m' }; // settled green (backlog)
  const t3 = { state: 'idle', name: 'docs', elapsed: '3h' };

  let t4; // remote (mini): thinking -> done (fresh)
  if (f < 20) t4 = { state: 'thinking', name: 'infra', elapsed: '6m', frame: dotFrame(f), machine: 'mini' };
  else t4 = { state: 'done', name: 'infra', elapsed: 'now', fresh: Math.max(0, 1 - (f - 20) / 7), machine: 'mini' };

  return [t0, t1, t2, t3, t4];
}

function tile(x, t) {
  const url = renderTile({
    state: t.state === 'done' ? 'done_unread' : t.state,
    projectName: t.name || '',
    elapsed: t.elapsed || '',
    serverLabel: t.machine || '',
    frame: t.frame || 0,
    freshness: t.fresh || 0,
  });
  return `<image xlink:href="${url}" x="${x}" y="${PAD}" width="${S}" height="${S}"/>`;
}

function frameSvg(f) {
  const tiles = tilesAt(f);
  const W = PAD * 2 + tiles.length * S + (tiles.length - 1) * GAP;
  const H = PAD * 2 + S;
  const body = tiles.map((t, i) => tile(PAD + i * (S + GAP), t)).join('');
  return {
    W,
    H,
    svg:
      `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ` +
      `viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">` +
      `<rect width="${W}" height="${H}" fill="#0b0b0d"/>${body}</svg>`,
  };
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-demo-'));
let W = 0;
for (let f = 0; f < FRAMES; f++) {
  const { svg, W: fw } = frameSvg(f);
  W = fw;
  const svgPath = path.join(tmp, `f_${String(f).padStart(3, '0')}.svg`);
  const pngPath = path.join(tmp, `f_${String(f).padStart(3, '0')}.png`);
  fs.writeFileSync(svgPath, svg);
  execFileSync('rsvg-convert', ['-w', String(W), svgPath, '-o', pngPath]);
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
// One-shot palette generation + use → small, clean, infinitely-looping GIF.
execFileSync('ffmpeg', [
  '-y',
  '-framerate', String(FPS),
  '-i', path.join(tmp, 'f_%03d.png'),
  '-vf', 'split[s0][s1];[s0]palettegen=max_colors=64[p];[s1][p]paletteuse=dither=bayer:bayer_scale=3',
  '-loop', '0',
  OUT,
], { stdio: ['ignore', 'ignore', 'inherit'] });

const kb = Math.round(fs.statSync(OUT).size / 1024);
console.log(`wrote ${path.relative(ROOT, OUT)} (${W}px, ${FRAMES} frames @ ${FPS}fps, ${kb} KB)`);
console.log(`frames kept for inspection: ${tmp}`);
