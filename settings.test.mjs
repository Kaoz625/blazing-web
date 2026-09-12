/* The Settings screen's rules, tested without a DOM.
 *
 * Same shape as stream-preferences.test.mjs: the file is run in a vm with a
 * hand-built document, and only the PURE half (window.BlazingSettings.core) is
 * asserted against. The rules are what a source list and a parental gate are
 * decided by, and they are exactly what firetv keeps in ProfileGateRules /
 * SourceFilters so they can be reached by a plain JVM test — the Kids interlock
 * was wrong for weeks on that client because it lived in a click listener.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./settings.js', import.meta.url), 'utf8');

function load(saved = new Map()) {
  const document = new EventTarget();
  document.createElement = () => ({
    append() {}, replaceChildren() {}, setAttribute() {}, addEventListener() {},
    classList: { add() {}, toggle() {} }, dataset: {}, style: {},
  });
  document.getElementById = () => null;
  const window = {};
  const localStorage = {
    getItem: (key) => (saved.has(key) ? saved.get(key) : null),
    setItem: (key, value) => saved.set(key, value),
  };
  vm.runInNewContext(source, { window, document, localStorage, CustomEvent, console, CSS: { escape: (v) => v } });
  return { api: window.BlazingSettings, core: window.BlazingSettings.core, saved, document };
}

test('every filter defaults to off, and a stored blob missing keys falls back field by field', () => {
  const { core } = load();
  assert.deepEqual(core.normalize(null), core.DEFAULTS);
  // A value that is not on the ladder is not a value. 999 is not a rung, so it
  // becomes Off rather than a silent "minimum 999p" nothing can satisfy.
  assert.equal(core.normalize({ minHeight: 999 }).minHeight, 0);
  assert.equal(core.normalize({ minSeeders: 10 }).minSeeders, 10);
  assert.equal(core.normalize({ noHevc: 'yes' }).noHevc, false, 'only true is true');
  assert.equal(core.normalize({ maxSizeGb: 5, noAv1: true }).noForeign, false, 'a missing key keeps its default');
});

test('the ladders are Fire TV\'s, and each one wraps back to Off', () => {
  const { core } = load();
  assert.deepEqual([...core.HEIGHT_LADDER], [0, 720, 1080, 2160]);
  assert.deepEqual([...core.SEEDER_LADDER], [0, 5, 10, 20, 50]);
  assert.deepEqual([...core.SIZE_LADDER], [0, 2, 5, 10, 20]);
  assert.equal(core.nextRung(0, core.HEIGHT_LADDER), 720);
  assert.equal(core.nextRung(2160, core.HEIGHT_LADDER), 0, 'the top rung wraps to Off');
  assert.equal(core.nextRung(7, core.SEEDER_LADDER), 0, 'a value off the ladder restarts it');
  assert.equal(core.minHeightLabel(2160), '4K');
  assert.equal(core.minHeightLabel(1080), '1080p');
  assert.equal(core.minHeightLabel(0), 'Off');
  assert.equal(core.offOr(0, ' GB'), 'Off');
  assert.equal(core.offOr(5, ' GB'), '5 GB');
});

test('UNKNOWN IS NOT REJECTED — a filter can only remove what it can see', () => {
  const { core } = load();
  const strict = { minSeeders: 20, maxSizeGb: 2, minHeight: 1080 };
  // No seeder count, no size, no resolution in the name: every one of these is
  // unknown, and rejecting on unknown would empty the list silently.
  assert.equal(core.reject(core.describe({ name: 'Some Release', title: 'no numbers here', url: 'https://a/b.mkv' }), strict), '');
  assert.equal(core.reject(core.describe({ name: '720p', title: '👤 5 · 8 GB', url: 'https://a/b.mkv' }), strict), 'seeders');
  assert.equal(core.reject(core.describe({ name: '720p', title: '👤 50 · 8 GB', url: 'https://a/b.mkv' }), strict), 'size');
  assert.equal(core.reject(core.describe({ name: '720p', title: '👤 50 · 1 GB', url: 'https://a/b.mkv' }), strict), 'res');
  assert.equal(core.reject(core.describe({ name: '1080p', title: '👤 50 · 1 GB', url: 'https://a/b.mkv' }), strict), '');
});

test('codec, 3D, language and instant-only use the vocabulary the other clients use', () => {
  const { core } = load();
  const at = (raw, filter) => core.reject(core.describe(raw), filter);
  assert.equal(at({ name: 'x265 1080p', url: 'https://a/b.mkv' }, { noHevc: true }), 'codec');
  assert.equal(at({ name: 'H.265 1080p', url: 'https://a/b.mkv' }, { noHevc: true }), 'codec');
  assert.equal(at({ name: 'AV1 1080p', url: 'https://a/b.mkv' }, { noAv1: true }), 'codec');
  assert.equal(at({ name: 'AV1 1080p', url: 'https://a/b.mkv' }, { noHevc: true }), '', 'AV1 is not HEVC');
  assert.equal(at({ name: '1080p', title: 'Half-SBS 3D', url: 'https://a/b.mkv' }, { no3d: true }), '3d');
  assert.equal(at({ name: '1080p', title: 'Dual Audio Hindi', url: 'https://a/b.mkv' }, { noForeign: true }), 'lang');
  // Instant-only: a debrid row that HOLDS the file is cached and stays; one
  // that would have to fetch it is uncached and goes; a row with only a hash
  // has to go through debrid and is uncached too.
  assert.equal(at({ name: '[RD+] 1080p', url: 'https://a/b.mkv' }, { noUncached: true }), '');
  assert.equal(at({ name: '[RD download] 1080p', url: 'https://a/b.mkv' }, { noUncached: true }), 'uncached');
  assert.equal(at({ name: '1080p', infoHash: 'abc' }, { noUncached: true }), 'uncached');
});

test('an all-off filter set short-circuits and never touches a row', () => {
  const { api, core } = load();
  assert.equal(core.active(core.DEFAULTS), false);
  const rows = [{ name: '480p', title: '👤 1 · 40 GB', url: 'https://a/b.mkv' }];
  const result = api.filterStreams(rows, core.DEFAULTS);
  assert.deepEqual(result.streams, rows, 'off means the list is handed back untouched');
  assert.equal(result.dropped.total, 0);
});

test('filtering counts what it removed, per reason, so the list can say so', () => {
  const { api } = load();
  const rows = [
    { name: '1080p', title: '👤 50 · 1 GB', url: 'https://a/keep.mkv' },
    { name: '480p', title: '👤 50 · 1 GB', url: 'https://a/low.mkv' },
    { name: '1080p x265', title: '👤 50 · 1 GB', url: 'https://a/hevc.mkv' },
  ];
  const { streams, dropped } = api.filterStreams(rows, { minHeight: 1080, noHevc: true });
  assert.equal(streams.length, 1);
  assert.equal(streams[0].url, 'https://a/keep.mkv');
  assert.equal(dropped.total, 2);
  assert.equal(dropped.res, 1);
  assert.equal(dropped.codec, 1);
  assert.match(api.droppedNote(dropped), /2 sources hidden by your settings/);
  assert.equal(api.droppedNote({ total: 0 }), '', 'nothing removed says nothing');
});

test('summary reads like the Roku row it was copied from', () => {
  const { core } = load();
  assert.equal(core.summary(core.DEFAULTS), 'Off');
  assert.equal(
    core.summary({ minHeight: 1080, minSeeders: 10, maxSizeGb: 5, noUncached: true, noHevc: true, noAv1: true, no3d: true, noForeign: true }),
    '1080p+,  10+ seeders,  under 5 GB,  instant only,  no HEVC,  no AV1,  no 3D,  English audio',
  );
});

test('auto-next defaults ON and hide-SDH defaults OFF, and both persist', () => {
  const saved = new Map();
  const first = load(saved);
  assert.equal(first.api.autoNext(), true, 'Markus asked for auto-next by name; a default-off toggle is a feature nobody has');
  assert.equal(first.api.hideSdh(), false, 'for a viewer who needs SDH, hiding it is the bug');
  first.api.setAutoNext(false);
  first.api.setHideSdh(true);
  const second = load(saved);
  assert.equal(second.api.autoNext(), false);
  assert.equal(second.api.hideSdh(), true);
});

test('SDH labels are recognised without swallowing an ordinary English track', () => {
  const { core } = load();
  assert.equal(core.isSdhLabel('English SDH'), true);
  assert.equal(core.isSdhLabel('English [CC]'), true);
  assert.equal(core.isSdhLabel('English (hearing impaired)'), true);
  assert.equal(core.isSdhLabel('English'), false);
  assert.equal(core.isSdhLabel('English Forced'), false);
});

test('B13 — only a grown-up profile may change where content comes from, and null is a no', () => {
  const { core } = load();
  assert.equal(core.grownUp(null), false, 'no profile means least is known, so show least');
  assert.equal(core.grownUp({ isKids: true, maxRating: 'adult' }), false, 'a kids profile is never grown up');
  assert.equal(core.grownUp({ isKids: false, maxRating: 'general' }), false);
  assert.equal(core.grownUp({ isKids: false, maxRating: 'teen' }), false);
  assert.equal(core.grownUp({ isKids: false, maxRating: 'mature' }), true);
  assert.equal(core.grownUp({ isKids: false, maxRating: 'adult' }), true);
  assert.equal(core.grownUp({ isKids: false, maxRating: 'nonsense' }), false, 'an unknown cap is not a licence');
  assert.equal(core.ratingAllows('teen', 'general'), true);
  assert.equal(core.ratingAllows('teen', 'mature'), false);
});
