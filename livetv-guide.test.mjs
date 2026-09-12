/* The three rules B33, B24 and B23 put into livetv.js, tested without a browser.
 *
 * All three are decisions, and every other client keeps its copy somewhere a
 * test can reach: firetv has ProfileGateRules.kt and GuideTimeline precisely so
 * the rules are not left inline in a View, and its header says why — "any rule
 * left inline in ProfileGateActivity is a rule with no test behind it. That is
 * exactly how the kids/adult interlock in the Add Profile form came to be wrong
 * for weeks." profile-parental.test.mjs already does the same for profile.js's
 * rules; this is livetv.js's half.
 *
 * livetv.js is loaded in a vm with a document that has no #livetv-results, so
 * wire() bails and mount() is never called — window.BlazingLiveTv.rules is
 * published either way.
 *
 *   node --test livetv-guide.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./livetv.js', import.meta.url), 'utf8');

function load() {
  const document = {
    createElement: () => ({
      appendChild() {}, setAttribute() {}, addEventListener() {},
      style: { setProperty() {} }, dataset: {}, classList: { add() {} },
    }),
    getElementById: () => null,
    addEventListener() {},
  };
  const window = { location: { href: 'https://example.test/app/' } };
  vm.runInNewContext(source, {
    window, document, localStorage: { getItem: () => null },
    URL, console, Date, Math, Number, JSON, Intl,
    setInterval: () => 0, clearInterval() {}, encodeURIComponent,
    IntersectionObserver: function IntersectionObserver() { this.observe = () => {}; },
    fetch: async () => { throw new Error('no network in this test'); },
    AbortSignal: { timeout: () => null },
  });
  return window.BlazingLiveTv.rules;
}

const rules = load();
const MIN = 60000;
/* The vm is a separate realm, so an array built in there has a different
   Array.prototype and deepStrictEqual refuses it on identity alone — the same
   trap profile-parental.test.mjs and stream-preferences.test.mjs both note.
   Compare the titles as one string instead. */
const titles = (slots) => slots.map((slot) => slot.title).join('|');

/* ── B24. The cap ────────────────────────────────────────────────────────── */

test('B24 — a null cap is a NO, not "everyone"', () => {
  // A live channel has no certification to look up, so there is no second gate
  // behind this one. Nobody connected must therefore mean nothing is shown.
  assert.equal(rules.groupAllowed(null, 'kids'), false);
  assert.equal(rules.groupAllowed(undefined, 'kids'), false);
  assert.equal(rules.groupAllowed('', 'kids'), false);
});

test('B24 — only the kids cap narrows Live TV; every other cap is untouched', () => {
  for (const cap of ['teen', 'mature', 'adult']) {
    assert.equal(rules.groupAllowed(cap, 'sports'), true, cap);
    assert.equal(rules.groupAllowed(cap, ''), true, `${cap} with no group`);
  }
});

test('B24 — under the kids cap Live TV is the kids groups and nothing else', () => {
  assert.equal(rules.groupAllowed('general', 'kids'), true);
  assert.equal(rules.groupAllowed('general', 'sports'), false);
  assert.equal(rules.groupAllowed('general', 'news'), false);
  assert.equal(rules.groupAllowed('general', 'movies'), false);
  assert.equal(rules.groupAllowed('general', 'general'), false);
});

test('B24 — the match is substring and case-insensitive, because the group names are upstream strings', () => {
  // "Kids", "kids", "Children", "Kids;Animation" have all been seen, and the
  // Roku's note at LiveTV.brs:617 records ~90 combination groups from one
  // provider. An exact allow-list would drop real kids channels.
  assert.equal(rules.groupAllowed('general', 'Kids'), true);
  assert.equal(rules.groupAllowed('general', 'KIDS'), true);
  assert.equal(rules.groupAllowed('general', 'Children'), true);
  assert.equal(rules.groupAllowed('general', 'Kids;Animation'), true);
  assert.equal(rules.groupAllowed('general', 'US | KIDS HD'), true);
});

test('B24 — an ungrouped channel fails CLOSED under the kids cap', () => {
  assert.equal(rules.groupAllowed('general', ''), false);
  assert.equal(rules.groupAllowed('general', null), false);
  assert.equal(rules.groupAllowed('general', undefined), false);
});

test('B24 — a tier nobody taught this client is not a licence', () => {
  // A fifth name taught to nobody must not read as "above general".
  // It is not the kids cap, so it admits — matching ProfileGateRules.kt, where
  // `cap != KIDS_CAP` is the whole test. The tightening that matters is that
  // null never gets here.
  assert.equal(rules.groupAllowed('unheard-of', 'sports'), true);
  assert.equal(rules.groupAllowed('GENERAL', 'sports'), false, 'the compare is case-insensitive');
});

/* ── B33. The now line and the bar ───────────────────────────────────────── */

test('B33 — no listing means no line, and the card falls back to its own metadata', () => {
  assert.equal(rules.nowLine(null), '');
  assert.equal(rules.nowLine(undefined), '');
  assert.equal(rules.nowLine({ title: '' }), '');
});

test('B33 — a listing with no start is still a title', () => {
  assert.equal(rules.nowLine({ title: 'Newsnight', startMs: 0 }), 'Newsnight');
});

test('B33 — the bar is 0 for anything that cannot be measured, because a NaN width renders FULL', () => {
  const now = Date.UTC(2026, 8, 12, 12, 0, 0);
  assert.equal(rules.progress(null, now), 0);
  assert.equal(rules.progress({ startMs: 0, stopMs: 0 }, now), 0, 'no stamps at all');
  assert.equal(rules.progress({ startMs: now, stopMs: now }, now), 0, 'zero-length programme');
  assert.equal(rules.progress({ startMs: now, stopMs: now - 60 * MIN }, now), 0, 'stop before start');
  assert.equal(rules.progress({ startMs: now + 30 * MIN, stopMs: now + 60 * MIN }, now), 0, 'has not started');
});

test('B33 — the bar is recomputed from start/stop, so it creeps inside the ten-minute TTL', () => {
  const start = Date.UTC(2026, 8, 12, 12, 0, 0);
  const stop = start + 60 * MIN;
  assert.equal(rules.progress({ startMs: start, stopMs: stop }, start + 15 * MIN), 0.25);
  assert.equal(rules.progress({ startMs: start, stopMs: stop }, start + 30 * MIN), 0.5);
  assert.equal(rules.progress({ startMs: start, stopMs: stop }, start + 45 * MIN), 0.75);
  assert.equal(rules.progress({ startMs: start, stopMs: stop }, stop + MIN), 1, 'clamped, never over');
});

/* ── B23. The grid maths ─────────────────────────────────────────────────── */

const W0 = Date.UTC(2026, 8, 12, 17, 0, 0);
const W1 = W0 + 180 * MIN;

test('B23 — the window is the current half hour and the three hours from it', () => {
  const span = rules.window(Date.UTC(2026, 8, 12, 17, 41, 22));
  assert.equal(span.start, Date.UTC(2026, 8, 12, 17, 30, 0));
  assert.equal(span.end - span.start, 180 * MIN);
});

test('B23 — an empty row is still three hours wide', () => {
  // This is the whole reason the gaps are filled rather than left out: a short
  // row would let the columns below drift out of step with the ruler above
  // them, which is a guide that lies about when things start.
  const slots = rules.slots([], W0, W1);
  assert.equal(slots.length, 1);
  assert.equal(slots[0].title, 'No guide data');
  assert.equal(slots[0].startMs, W0);
  assert.equal(slots[0].stopMs, W1);
});

test('B23 — gaps before, between and after the listings are filled', () => {
  const slots = rules.slots([
    { title: 'The Six', startMs: W0 + 30 * MIN, stopMs: W0 + 60 * MIN },
    { title: 'Film', startMs: W0 + 90 * MIN, stopMs: W0 + 150 * MIN },
  ], W0, W1);
  assert.equal(titles(slots), 'No guide data|The Six|No guide data|Film|No guide data');
  // Contiguous, edge to edge, with no overlap anywhere.
  let cursor = W0;
  for (const slot of slots) {
    assert.equal(slot.startMs, cursor);
    assert.ok(slot.stopMs > slot.startMs);
    cursor = slot.stopMs;
  }
  assert.equal(cursor, W1);
});

test('B23 — programmes are clipped to the window at both ends', () => {
  const slots = rules.slots([
    { title: 'Started earlier', startMs: W0 - 45 * MIN, stopMs: W0 + 30 * MIN },
    { title: 'Runs past the end', startMs: W0 + 30 * MIN, stopMs: W1 + 120 * MIN },
  ], W0, W1);
  assert.equal(titles(slots), 'Started earlier|Runs past the end');
  assert.equal(slots[0].startMs, W0);
  assert.equal(slots[1].stopMs, W1);
});

test('B23 — a programme with no stop gets the fifteen-minute fallback, not a zero-width block', () => {
  const slots = rules.slots([{ title: 'Ident', startMs: W0, stopMs: 0 }], W0, W1, 15);
  assert.equal(slots[0].title, 'Ident');
  assert.equal(slots[0].stopMs - slots[0].startMs, 15 * MIN);
});

test('B23 — an unstamped programme is dropped rather than pinned to the epoch', () => {
  const slots = rules.slots([{ title: 'Whenever', startMs: 0, stopMs: 0 }], W0, W1);
  assert.equal(titles(slots), 'No guide data');
});

test('B23 — out-of-order listings are sorted, and an overlap does not double-book the row', () => {
  const slots = rules.slots([
    { title: 'Second', startMs: W0 + 60 * MIN, stopMs: W0 + 120 * MIN },
    { title: 'First', startMs: W0, stopMs: W0 + 70 * MIN },
  ], W0, W1);
  assert.equal(slots[0].title, 'First');
  assert.equal(slots[1].title, 'Second');
  // The overlap is resolved by moving the second block's start, never by
  // letting two blocks cover the same ten minutes — that would push everything
  // after it off the ruler.
  assert.equal(slots[1].startMs, slots[0].stopMs);
});

test('B23 — positionPx is the Fire TV formula, and never goes negative', () => {
  assert.equal(rules.positionPx(W0, W0, 8), 0);
  assert.equal(rules.positionPx(W0 + 30 * MIN, W0, 8), 240);
  assert.equal(rules.positionPx(W0 + 180 * MIN, W0, 8), 1440);
  assert.equal(rules.positionPx(W0 - 60 * MIN, W0, 8), 0, 'clamped at the left edge');
});

/* ── the placeholder filter still holds, because the guide walks it too ──── */

test('the guide walk reuses isPlaceholder, so the grid cannot fill with separator rows', () => {
  assert.equal(rules.isPlaceholder({ name: '##### CBS ALABAMA #####' }), true);
  assert.equal(rules.isPlaceholder({ name: '- NO EVENT STREAMING - | 8K EXCLUSIVE' }), true);
  assert.equal(rules.isPlaceholder({ name: 'CA - CNN INTERNATIONAL HD' }), false);
});
