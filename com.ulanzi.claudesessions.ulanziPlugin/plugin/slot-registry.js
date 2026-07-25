// Tracks which physical keys host a Session Slot action, across however many
// profiles/pages have it placed. Keys are ordered visually (row-major by the
// "x_y" grid coordinate inside the context) within a profile, so slot 0 is
// always the top-left Session Slot key on the deck — but the SDK's "add"
// message carries no profile/page identifier (verified against live traffic:
// only uuid/actionid/key/device/controller, no page field), and every
// profile reuses the same x_y coordinate space. Sorting by raw (x,y) alone
// would interleave keys from different profiles that happen to share a
// coordinate. Instead, Studio sends a profile's keys as one contiguous batch
// on connect (empirically verified: 3 profiles -> 3 repeats of the same
// per-profile key order) — a repeated x_y is the only available signal that
// a new batch (profile) has started, so it's used to group slots by profile
// first, then by visual position within each profile.
export default class SlotRegistry {
  constructor() {
    /** @type {Map<string, {context: string, x: number, y: number, batch: number}>} */
    this.entries = new Map();
    this.ordered = [];
    this.currentBatch = 0;
    /** @type {Set<string>} x_y coordinates seen in the still-open batch */
    this.seenInBatch = new Set();
  }

  add(context) {
    if (this.entries.has(context)) return;
    const key = context.split('___')[1] || '0_0';
    const [x, y] = key.split('_').map((n) => parseInt(n, 10) || 0);
    if (this.seenInBatch.has(key)) {
      this.currentBatch++;
      this.seenInBatch.clear();
    }
    this.seenInBatch.add(key);
    this.entries.set(context, { context, x, y, batch: this.currentBatch });
    this.reorder();
  }

  removeByContext(context) {
    if (this.entries.delete(context)) this.reorder();
  }

  reorder() {
    this.ordered = [...this.entries.values()].sort(
      (a, b) => a.batch - b.batch || a.y - b.y || a.x - b.x
    );
  }

  /** Contexts in visual order; index in this array = slot index. */
  contexts() {
    return this.ordered.map((e) => e.context);
  }

  slotIndexOf(context) {
    return this.ordered.findIndex((e) => e.context === context);
  }
}
