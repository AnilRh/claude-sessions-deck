// The on-screen board — a software mirror of the deck for when the physical
// device isn't in reach (undocked laptop, second monitor). Served by the
// plugin's loopback HTTP server at GET /board; it polls GET /board/state for
// the same session tiles the deck shows (identical SVGs from renderer.js) and
// lays them out in a responsive grid: tiles reflow to fill the window width,
// so the window size IS the layout control (want 5 per row? size the window
// to 5 tiles). Installable as a standalone macOS web app via Safari's
// File > Add to Dock (manifest + apple-touch-icon below).
//
// Input parity with the device: click = short press (acknowledge + jump to the
// session), hold >= 600ms = long press (clear the tile) — both POST to
// /board/action, which runs the SAME handlers as a physical key press.

import fs from 'fs';

// Tiles are at least this wide; the grid packs as many columns as fit the
// window and stretches them evenly, so tiles range roughly MIN..2xMIN px and
// shrink/reflow as the window is resized.
const TILE_MIN = 84;

export const BOARD_MANIFEST = JSON.stringify({
  name: 'Claude Sessions',
  // Safari's Add to Dock uses short_name (when present) as the default app
  // name, so keep it the full name — "Sessions" alone showed up in the dialog.
  short_name: 'Claude Sessions',
  description: 'Live Claude Code session board',
  start_url: '/board',
  scope: '/board',
  display: 'standalone',
  background_color: '#0b0b0d',
  theme_color: '#0b0b0d',
  icons: [{ src: '/board/icon.png', sizes: '512x512', type: 'image/png' }],
});

// App icon for the dock / manifest — reuse the plugin's store icon. Loaded
// lazily and cached; null if the asset is missing (routes then 404).
let iconCache;
export function boardIcon() {
  if (iconCache === undefined) {
    try {
      iconCache = fs.readFileSync(new URL('../assets/store-icon@2x.png', import.meta.url));
    } catch {
      iconCache = null;
    }
  }
  return iconCache;
}

export const BOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#0b0b0d">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="Claude Sessions">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<link rel="manifest" href="/board/manifest.webmanifest">
<link rel="apple-touch-icon" href="/board/icon.png">
<link rel="icon" href="/board/icon.png">
<title>Claude Sessions</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; }
  body {
    background: #0b0b0d;
    color: #e7e7ea;
    font: 500 13px/1.3 -apple-system, Helvetica, Arial, sans-serif;
    -webkit-font-smoothing: antialiased;
    padding: 14px;
    display: flex;
    flex-direction: column;
    gap: 12px;
    min-height: 100%;
  }
  header {
    display: flex;
    align-items: center;
    gap: 8px;
    color: #9a9aa2;
    font-size: 12px;
    letter-spacing: 0.2px;
    user-select: none;
  }
  header .title { color: #cfcfd6; font-weight: 700; }
  header .count { color: #7d7d86; }
  header .dot {
    width: 8px; height: 8px; border-radius: 50%;
    background: #34a853; margin-left: auto;
    box-shadow: 0 0 0 3px rgba(52,168,83,0.18);
    transition: background 0.2s, box-shadow 0.2s;
  }
  header .dot.off { background: #d1483d; box-shadow: 0 0 0 3px rgba(209,72,61,0.18); }
  #grid {
    display: grid;
    /* Responsive: as many columns as fit, tiles shrink/reflow with the window.
       auto-fill keeps phantom tracks when there are few sessions, so tiles
       stay tile-sized instead of ballooning to fill a wide window. */
    grid-template-columns: repeat(auto-fill, minmax(${TILE_MIN}px, 1fr));
    gap: 10px;
    width: 100%;
  }
  .tile {
    position: relative; aspect-ratio: 1 / 1;
    cursor: pointer; user-select: none; -webkit-user-select: none;
    -webkit-touch-callout: none;
  }
  .tile img {
    width: 100%; height: 100%; display: block;
    transition: transform 0.08s ease, filter 0.08s ease;
    pointer-events: none;
  }
  .tile:active img { transform: scale(0.95); }
  /* Held past the long-press threshold: release now clears the tile. */
  .tile.armed img { transform: scale(0.9); filter: brightness(1.25) saturate(0.6); }
  .tile.armed::after {
    content: ''; position: absolute; inset: 2px; border-radius: 26%;
    border: 3px solid #E5484D; pointer-events: none;
  }
  #empty, #offline {
    margin: auto; text-align: center; color: #6c6c74; font-size: 13px; padding: 40px 0;
  }
  #offline { color: #d1907f; display: none; }
  #empty { display: none; }
</style>
</head>
<body>
  <header>
    <span class="title">Claude Sessions</span>
    <span class="count" id="count"></span>
    <span class="dot" id="dot" title="connection"></span>
  </header>
  <div id="grid"></div>
  <div id="empty">No active sessions</div>
  <div id="offline">Not connected — is the plugin running? (Ulanzi Studio, or headless mode)</div>
<script>
  const grid = document.getElementById('grid');
  const dot = document.getElementById('dot');
  const countEl = document.getElementById('count');
  const emptyEl = document.getElementById('empty');
  const offlineEl = document.getElementById('offline');
  const nodes = new Map(); // id -> { wrap, img, svg }
  const LONG_PRESS_MS = 600; // same threshold as the physical keys

  function setConnected(ok) {
    dot.classList.toggle('off', !ok);
    offlineEl.style.display = ok ? 'none' : 'block';
  }

  async function sendAction(id, action) {
    try {
      await fetch('/board/action', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-claude-sessions-board': '1' },
        body: JSON.stringify({ id, action }),
      });
    } catch (e) { /* connection dot already reflects server loss */ }
    refresh();
  }

  // Click = press (acknowledge + jump to the session); hold ≥600ms = clear —
  // identical semantics and threshold to the physical keys. The .armed class
  // signals "release now clears" once the hold crosses the threshold.
  function attachPress(wrap, id) {
    let downAt = 0;
    let armTimer = null;
    const reset = () => {
      if (armTimer) { clearTimeout(armTimer); armTimer = null; }
      wrap.classList.remove('armed');
      downAt = 0;
    };
    wrap.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      downAt = Date.now();
      armTimer = setTimeout(() => wrap.classList.add('armed'), LONG_PRESS_MS);
    });
    wrap.addEventListener('pointerup', () => {
      if (!downAt) return;
      const held = Date.now() - downAt;
      reset();
      sendAction(id, held >= LONG_PRESS_MS ? 'clear' : 'press');
    });
    wrap.addEventListener('pointerleave', reset);
    wrap.addEventListener('pointercancel', reset);
    wrap.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  async function refresh() {
    let data;
    try {
      const r = await fetch('/board/state', { cache: 'no-store' });
      if (!r.ok) throw new Error('bad status');
      data = await r.json();
    } catch (e) {
      setConnected(false);
      return;
    }
    setConnected(true);
    const sessions = Array.isArray(data.sessions) ? data.sessions : [];
    const seen = new Set();
    sessions.forEach((s, i) => {
      seen.add(s.id);
      let n = nodes.get(s.id);
      if (!n) {
        const wrap = document.createElement('div');
        wrap.className = 'tile';
        wrap.title = 'click: open · hold: clear';
        const img = document.createElement('img');
        img.alt = '';
        img.draggable = false;
        wrap.appendChild(img);
        attachPress(wrap, s.id);
        n = { wrap, img, svg: '' };
        nodes.set(s.id, n);
      }
      if (n.svg !== s.svg) { n.img.src = s.svg; n.svg = s.svg; }
      if (grid.children[i] !== n.wrap) grid.insertBefore(n.wrap, grid.children[i] || null);
    });
    for (const [id, n] of nodes) {
      if (!seen.has(id)) { n.wrap.remove(); nodes.delete(id); }
    }
    countEl.textContent = sessions.length ? sessions.length + (sessions.length === 1 ? ' session' : ' sessions') : '';
    emptyEl.style.display = sessions.length ? 'none' : 'block';
  }

  refresh();
  setInterval(refresh, 1000);
  window.addEventListener('focus', refresh);
</script>
</body>
</html>`;
