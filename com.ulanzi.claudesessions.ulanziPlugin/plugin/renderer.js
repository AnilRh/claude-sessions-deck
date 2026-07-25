// Renders 200x200 session tiles as SVG data URLs (same technique as the
// claude-usage plugin proven on the D200: setBaseDataIcon accepts
// data:image/svg+xml;base64 at 200x200).

const SIZE = 200;
const RADIUS = 44;
const INSET = 6;
const TILE = SIZE - INSET * 2;
const FONT = '-apple-system,Helvetica,Arial,sans-serif';

// Vertical layout (shared by every state so tiles line up). The title sits
// mid-tile; the status glyph is centered between the tile's top edge and the
// top of the title text, so it's equidistant from both regardless of glyph
// size; the elapsed label sits low, at the same height as the remote footer
// text (see ELAPSED_Y below) so local and remote tiles are consistent.
const TITLE_Y = 138; // name block anchor: 1-line baseline / 2-line straddle center
const GLYPH_CY = 57; // status glyph vertical center = midpoint(tile top, title top)

export const STATES = Object.freeze({
  EMPTY: 'empty',
  IDLE: 'idle',
  THINKING: 'thinking',
  WAITING: 'waiting',
  DONE_UNREAD: 'done_unread',
  ERROR: 'error',
});

function escapeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function svgDoc(body) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SIZE} ${SIZE}" width="${SIZE}" height="${SIZE}">${body}</svg>`;
}

function toDataUrl(svg) {
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

function tile(fill, extraAttrs = '') {
  return `<rect x="${INSET}" y="${INSET}" width="${TILE}" height="${TILE}" rx="${RADIUS}" ry="${RADIUS}" fill="${fill}" ${extraAttrs}/>`;
}

// Truncate a single-line name. nameBlock only sends names up to 13 chars here
// (longer ones wrap to two lines), so the cap is 14 and the textLength clamp in
// nameText() squeezes the 10–13 range to fit width without chopping.
function truncateName(name, max = 14) {
  if (!name) return '';
  if (name.length <= max) return name;
  return name.slice(0, max - 1) + '…';
}

function nameText(name, y, color, opacity = 1) {
  if (!name) return '';
  const t = escapeXml(truncateName(name));
  // textLength clamp only when the name is long enough to risk overflow
  const clamp = name.length >= 10 ? `textLength="${TILE - 36}" lengthAdjust="spacingAndGlyphs"` : '';
  return `<text x="${SIZE / 2}" y="${y}" font-family="${FONT}" font-size="30" font-weight="700" text-anchor="middle" fill="${color}" opacity="${opacity}" ${clamp}>${t}</text>`;
}

function clip(s, n) {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

// Split a long name into two balanced lines, preferring a space near the middle.
function splitTwo(s) {
  const mid = Math.floor(s.length / 2);
  let best = -1;
  for (let i = 1; i < s.length - 1; i++) {
    if (s[i] === ' ' && (best < 0 || Math.abs(i - mid) < Math.abs(best - mid))) best = i;
  }
  if (best > 0) return [s.slice(0, best).trim(), s.slice(best + 1).trim()];
  return [s.slice(0, mid), s.slice(mid)];
}

// One line for short names (folders, brackets, short titles — the original
// look); two smaller lines for long names (full session titles) so they stay
// readable instead of being squeezed onto one line. `y` is the 1-line baseline;
// the two-line block straddles it.
function nameBlock(name, y, color, opacity = 1) {
  if (!name) return '';
  if (name.length <= 13) return nameText(name, y, color, opacity);
  const [a, b] = splitTwo(name);
  const line = (t, yy) => {
    const clamp = t.length >= 15 ? `textLength="${TILE - 24}" lengthAdjust="spacingAndGlyphs"` : '';
    return `<text x="${SIZE / 2}" y="${yy}" font-family="${FONT}" font-size="22" font-weight="700" text-anchor="middle" fill="${color}" opacity="${opacity}" ${clamp}>${escapeXml(clip(t, 16))}</text>`;
  };
  // A touch more space between the two lines than a tight 1.0 line-height.
  return line(a, y - 16) + line(b, y + 9);
}

function elapsedText(label, y, color, opacity = 0.85) {
  if (!label) return '';
  return `<text x="${SIZE / 2}" y="${y}" font-family="${FONT}" font-size="26" font-weight="600" text-anchor="middle" fill="${color}" opacity="${opacity}">${escapeXml(label)}</text>`;
}

// Accent colours for remote machines — cool hues kept clear of the warm state
// fills (terracotta / amber / green) so the band never reads as a state. A
// machine's colour is derived from its origin label, so it's stable and the
// same across every one of that machine's tiles (glanceable grouping).
const FOOTER_H = 40;
const FOOTER_Y = SIZE - INSET - FOOTER_H; // colored footer occupies the bottom strip
const FOOTER_BASELINE = FOOTER_Y + 27; // text baseline within the remote footer
// Local tiles (no footer) put their elapsed label at this same height, so the
// time reads at a consistent position whether or not a machine footer is drawn.
const ELAPSED_Y = FOOTER_BASELINE;
const MACHINE_COLORS = ['#2E6FB5', '#6D4AC9', '#0E7C6B', '#B0396E', '#3B4CC0'];

function originColor(label) {
  let h = 0;
  for (let i = 0; i < label.length; i++) h = (h + label.charCodeAt(i)) | 0;
  return MACHINE_COLORS[Math.abs(h) % MACHINE_COLORS.length];
}

// Coloured footer naming the machine a remote session lives on: MACHINE left,
// elapsed right, on a machine-colour bar clipped to the tile's rounded bottom.
// Empty for local sessions (single-machine setups look unchanged). Sitting at
// the bottom, it leaves the whole top free for the status glyph and replaces
// the separate elapsed line, so nothing crowds the check/dots.
function footerBand(label, elapsed) {
  if (!label || label === 'local') return '';
  const color = originColor(label);
  const name = escapeXml(label.slice(0, 10).toUpperCase());
  const clamp = name.length >= 8 ? `textLength="${TILE - 96}" lengthAdjust="spacingAndGlyphs"` : '';
  const time = elapsed ? escapeXml(elapsed) : '';
  const baseline = FOOTER_BASELINE;
  return (
    `<defs><clipPath id="ob"><rect x="${INSET}" y="${INSET}" width="${TILE}" height="${TILE}" rx="${RADIUS}" ry="${RADIUS}"/></clipPath></defs>` +
    `<g clip-path="url(#ob)">` +
    `<rect x="${INSET}" y="${FOOTER_Y}" width="${TILE}" height="${SIZE - INSET - FOOTER_Y}" fill="${color}"/>` +
    `<text x="24" y="${baseline}" font-family="${FONT}" font-size="22" font-weight="700" letter-spacing="1" text-anchor="start" fill="#EEF3FA" ${clamp}>${name}</text>` +
    (time
      ? `<text x="${SIZE - 24}" y="${baseline}" font-family="${FONT}" font-size="22" font-weight="600" text-anchor="end" fill="#EEF3FA" opacity="0.9">${time}</text>`
      : '') +
    `</g>`
  );
}

/** Format ms elapsed as "4m", "1h2m", "3d". */
export function formatElapsed(ms) {
  const min = Math.floor(ms / 60000);
  if (min < 1) return 'now';
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h${min % 60 ? `${min % 60}m` : ''}`;
  return `${Math.floor(h / 24)}d`;
}

// --- freshness (recently-finished tiles pop, then settle) ------------------
// `freshness` is 1 just after a tile turned done/error and decays to 0 over the
// window (see FRESH_WINDOW_MS in app.js). Two layered cues: the fill brightens
// across the whole window, and a bright rim adds a stronger "just happened"
// accent for roughly the first 40% of it. Old tiles look exactly as before
// (freshness 0), so a backlog of green keys is undisturbed.

function hexToRgb(h) {
  const s = h.replace('#', '');
  return [0, 2, 4].map((i) => parseInt(s.slice(i, i + 2), 16));
}

// Blend base→accent by t (0 = base, 1 = accent).
function mix(baseHex, accentHex, t) {
  const a = hexToRgb(baseHex);
  const b = hexToRgb(accentHex);
  return (
    '#' +
    a
      .map((v, i) => Math.round(v + (b[i] - v) * t).toString(16).padStart(2, '0'))
      .join('')
  );
}

// Bright inner ring; only present (and only rendered) for the first ~40% of the
// freshness window, its own opacity fading out across that span.
function freshRim(freshness, color) {
  const f = Math.max(0, (freshness - 0.6) / 0.4);
  if (f <= 0) return '';
  return `<rect x="${INSET + 3}" y="${INSET + 3}" width="${TILE - 6}" height="${TILE - 6}" rx="${RADIUS - 3}" ry="${RADIUS - 3}" fill="none" stroke="${color}" stroke-width="6" opacity="${(f * 0.9).toFixed(2)}"/>`;
}

// --- state tiles -----------------------------------------------------------

// Slot with no session assigned: nearly black, faint outline dot.
function renderEmpty() {
  const body =
    tile('#141416') +
    `<circle cx="${SIZE / 2}" cy="${SIZE / 2}" r="7" fill="#3A3A3E"/>`;
  return svgDoc(body);
}

// Session read but still live — a workspace you return to. Lighter card than an
// empty slot (so it reads as occupied), bright legible name (what you scan
// for), calm steel dot, and a muted "idle · <time>" line so you can see how
// long it's been quiet. Present, not loud.
function renderIdle({ projectName, elapsed, serverLabel }) {
  const remote = serverLabel && serverLabel !== 'local';
  const footer = remote
    ? footerBand(serverLabel, elapsed)
    : `<text x="${SIZE / 2}" y="${ELAPSED_Y}" font-family="${FONT}" font-size="20" font-weight="600" text-anchor="middle" fill="#7E7E88">${escapeXml(elapsed ? `idle · ${elapsed}` : 'idle')}</text>`;
  const body =
    tile('#2C2C33') +
    `<circle cx="${SIZE / 2}" cy="${GLYPH_CY}" r="7" fill="#6E7F94"/>` +
    nameBlock(projectName, TITLE_Y, '#DEDEE4') +
    footer;
  return svgDoc(body);
}

// Claude actively working: terracotta gradient, pulsing dots (2 frames).
function renderThinking({ projectName, elapsed, frame, serverLabel }) {
  const dotY = GLYPH_CY;
  const dots = [0, 1, 2]
    .map((i) => {
      const on = frame % 2 === i % 2;
      return `<circle cx="${SIZE / 2 + (i - 1) * 30}" cy="${dotY}" r="${on ? 11 : 8}" fill="#FFFFFF" opacity="${on ? 0.95 : 0.45}"/>`;
    })
    .join('');
  const body =
    `<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">` +
    `<stop offset="0" stop-color="#E08862"/><stop offset="1" stop-color="#C7603C"/>` +
    `</linearGradient></defs>` +
    tile('url(#g)') +
    dots +
    nameBlock(projectName, TITLE_Y, '#FFFFFF') +
    (serverLabel && serverLabel !== 'local'
      ? footerBand(serverLabel, elapsed)
      : elapsedText(elapsed, ELAPSED_Y, '#FFF3EC'));
  return svgDoc(body);
}

// Blocked on the human: loud amber tile, bold question mark. Must pop in
// peripheral vision, so maximum contrast and the biggest glyph of any state.
function renderWaiting({ projectName, elapsed, serverLabel, freshness = 0 }) {
  const body =
    tile(mix('#FFC53D', '#FFDA5E', freshness)) +
    freshRim(freshness, '#FFF4CC') +
    `<text x="${SIZE / 2}" y="${GLYPH_CY + 29}" font-family="${FONT}" font-size="82" font-weight="800" text-anchor="middle" fill="#1C1C1E">?</text>` +
    nameBlock(projectName, TITLE_Y, '#1C1C1E') +
    (serverLabel && serverLabel !== 'local'
      ? footerBand(serverLabel, elapsed)
      : elapsedText(elapsed, ELAPSED_Y, '#4A3A10', 0.9));
  return svgDoc(body);
}

// Finished, unacknowledged: green tile with checkmark; press to clear. A
// recently-finished tile is brighter with a fading rim (freshness), so what
// just landed stands out from an older backlog of green.
function renderDone({ projectName, elapsed, serverLabel, freshness = 0 }) {
  const remote = serverLabel && serverLabel !== 'local';
  // Green + check already mean "done, needs acknowledging" (acknowledging turns
  // the tile dark/idle), so no separate unread badge is needed.
  const body =
    tile(mix('#2E9E4F', '#43BE6A', freshness)) +
    freshRim(freshness, '#C7F7D8') +
    `<path d="M ${SIZE / 2 - 24} ${GLYPH_CY + 1} l 16 16 l 32 -34" stroke="#FFFFFF" stroke-width="12" stroke-linecap="round" stroke-linejoin="round" fill="none"/>` +
    nameBlock(projectName, TITLE_Y, '#FFFFFF') +
    (remote ? footerBand(serverLabel, elapsed) : elapsedText(elapsed, ELAPSED_Y, '#DDF5E4'));
  return svgDoc(body);
}

// Turn ended in an error (StopFailure: API error / rate limit / overloaded /
// auth). Loud red with a bold "!" — the counterpart to the amber "?": colour
// says which kind of attention it needs. Press to acknowledge + resume (retry).
function renderError({ projectName, elapsed, serverLabel, freshness = 0 }) {
  const body =
    tile(mix('#E5484D', '#F86D71', freshness)) +
    freshRim(freshness, '#FFCBCD') +
    `<text x="${SIZE / 2}" y="${GLYPH_CY + 29}" font-family="${FONT}" font-size="82" font-weight="800" text-anchor="middle" fill="#FFFFFF">!</text>` +
    nameBlock(projectName, TITLE_Y, '#FFFFFF') +
    (serverLabel && serverLabel !== 'local'
      ? footerBand(serverLabel, elapsed)
      : elapsedText(elapsed, ELAPSED_Y, '#FCE4E4', 0.9));
  return svgDoc(body);
}

/**
 * Render a tile for a slot.
 * @param {object} p
 * @param {string} p.state one of STATES
 * @param {string} [p.projectName]
 * @param {string} [p.elapsed] preformatted elapsed label ("4m")
 * @param {number} [p.frame] animation frame (thinking only)
 * @param {number} [p.freshness] 1→0 recency for done/error tiles (see app.js)
 * @returns {string} SVG data URL
 */
export function renderTile({ state, projectName = '', elapsed = '', frame = 0, serverLabel = '', freshness = 0 }) {
  let svg;
  switch (state) {
    case STATES.THINKING:
      svg = renderThinking({ projectName, elapsed, frame, serverLabel });
      break;
    case STATES.WAITING:
      svg = renderWaiting({ projectName, elapsed, serverLabel, freshness });
      break;
    case STATES.DONE_UNREAD:
      svg = renderDone({ projectName, elapsed, serverLabel, freshness });
      break;
    case STATES.ERROR:
      svg = renderError({ projectName, elapsed, serverLabel, freshness });
      break;
    case STATES.IDLE:
      svg = renderIdle({ projectName, elapsed, serverLabel });
      break;
    default:
      svg = renderEmpty();
  }
  return toDataUrl(svg);
}

/**
 * Cache key for a rendered tile; pushes to the deck happen only when this
 * changes for a context. minuteBucket keeps elapsed labels fresh without
 * re-pushing untouched keys every tick.
 */
export function tileCacheKey({ state, projectName = '', elapsed = '', frame = 0, serverLabel = '', freshness = 0 }) {
  return `${state}|${projectName}|${elapsed}|${state === STATES.THINKING ? frame : 0}|${serverLabel}|${freshness}`;
}
