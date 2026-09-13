/* The roadmap rules in roadmaps.js, tested without a browser.
 *
 * B25 put a real Roadmaps screen on the web for the first time, and every
 * string on it is COMPUTED rather than sent: the fleet answers chapters and
 * items and nothing else, so the years range, the running position, the chapter
 * subline, the stats line and the three orders are all decisions this file
 * holds. A decision with no test behind it is how the three televisions got
 * three different numbering schemes in the first place.
 *
 * roadmaps.js is an IIFE that only publishes onto `window`; nothing in it
 * touches the DOM or the network until mount() is called, so a vm with a stub
 * document is enough to reach window.BlazingRoadmaps.rules.
 *
 *   node --test roadmaps.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./roadmaps.js', import.meta.url), 'utf8');

function load() {
  const window = {};
  const document = {
    createElement: () => ({
      append() {}, appendChild() {}, addEventListener() {},
      classList: { add() {}, remove() {} }, dataset: {}, style: {}, textContent: '',
      setAttribute() {},
    }),
    getElementById: () => null,
  };
  vm.runInNewContext(source, {
    window, document, console, URL, Date,
    fetch: async () => { throw new Error('no network in this test'); },
    AbortSignal: { timeout: () => null },
  });
  return window.BlazingRoadmaps.rules;
}

const rules = load();
/* The vm is a separate realm, so an object built in there has a different
   Object.prototype and deepStrictEqual refuses it on identity alone. The same
   round trip profile-parental.test.mjs uses, for the same reason. */
const plain = (value) => JSON.parse(JSON.stringify(value));

const entry = (over = {}) => rules.normaliseEntry({
  id: 'tt0000001', name: 'A Film', type: 'movie', year: '2008',
  date: '2008-05-02', runtime: 126, ...over,
});

const chapter = (name, items) => ({ name, note: '', items });

// ── the index card ──────────────────────────────────────────────────────────

test('a card caption drops the clauses whose numbers are zero', () => {
  assert.equal(
    rules.cardCaption({ titles: 54, chapters: 6, films: 34, series: 20 }),
    '54 titles  ·  6 chapters  ·  34 films, 20 series',
  );
  // 85 of the fleet's 170 roadmaps are films only, and "0 series" is noise.
  assert.equal(rules.cardCaption({ titles: 9, chapters: 2, films: 9, series: 0 }), '9 titles  ·  2 chapters');
  // One chapter is not a chaptering, so it is not announced as one.
  assert.equal(rules.cardCaption({ titles: 3, chapters: 1, films: 3, series: 0 }), '3 titles');
});

test('a franchise with no slug or no name is not a franchise', () => {
  assert.equal(rules.normaliseCard({ slug: '', name: 'Nameless' }), null);
  assert.equal(rules.normaliseCard({ slug: 'x', name: '' }), null);
  assert.equal(rules.normaliseCard(null), null);
});

test('card art prefers the backdrop, falls back to the poster, and refuses anything not https', () => {
  assert.equal(rules.normaliseCard({ slug: 'a', name: 'A', backdrop: 'https://i/b.jpg', poster: 'https://i/p.jpg' }).art, 'https://i/b.jpg');
  assert.equal(rules.normaliseCard({ slug: 'a', name: 'A', poster: 'https://i/p.jpg' }).art, 'https://i/p.jpg');
  assert.equal(rules.normaliseCard({ slug: 'a', name: 'A', backdrop: 'javascript:alert(1)' }).art, '');
  assert.equal(rules.normaliseCard({ slug: 'a', name: 'A', backdrop: 'http://i/b.jpg' }).art, '');
});

// ── one entry ───────────────────────────────────────────────────────────────

test('an entry with a blank id or a blank name is dropped, so it cannot take a position number', () => {
  assert.equal(rules.normaliseEntry({ id: '', name: 'X' }), null);
  assert.equal(rules.normaliseEntry({ id: 'tt1', name: '' }), null);
});

test('only a tt id is playable — a tmdb: id is shown, ordered, and not openable', () => {
  assert.equal(entry({ id: 'tt0848228' }).playable, true);
  assert.equal(entry({ id: 'tmdb:24428' }).playable, false);
});

test('an entry caption says a runtime for a film and a season count for a show', () => {
  assert.equal(rules.entryCaption(entry({ runtime: 143 })), '2008  ·  2h 23m');
  assert.equal(rules.entryCaption(entry({ runtime: 45 })), '2008  ·  45m');
  // The fleet sends no runtime and no episode count on a series at all.
  assert.equal(rules.entryCaption(entry({ type: 'series', seasons: 1, runtime: 0 })), '2008  ·  1 season');
  assert.equal(rules.entryCaption(entry({ type: 'series', seasons: 4, runtime: 0 })), '2008  ·  4 seasons');
  assert.equal(rules.entryCaption(entry({ type: 'series', seasons: 0, runtime: 0 })), '2008');
  assert.equal(rules.entryCaption(entry({ year: '', runtime: 0 })), '');
});

// ── what a card carries to app.js ───────────────────────────────────────────

test('a card carries the tier that admitted it, not an empty string', () => {
  /* app.js's visibleMetas() resolves a tier and keeps it in a local variable
     (app.js:5930), but app.js re-reads meta.contentRating twice more on the same
     card: at openDetail (app.js:3257) and 550ms into a hover or a tab-focus
     (app.js:2423 and :2430). ratingAllowed('') is false for exactly one cap,
     'general', which is every Kids profile — so a saga was drawn in full and then
     refused on a press and DELETED on a hover. */
  const tiers = new Map([['movie:tt0848228', 'teen']]);
  assert.equal(rules.entryMeta(entry({ id: 'tt0848228' }), tiers).contentRating, 'teen');
  // A tmdb: id is the one TMDB knew without an IMDb id. Nothing can classify it,
  // so it stays unknown — which is what the cap already knows what to do with.
  assert.equal(rules.entryMeta(entry({ id: 'tmdb:24428' }), tiers).contentRating, '');
});

test('an entry admitted on a tier the card cannot carry is not drawn under a kids cap', () => {
  /* THE RESIDUAL. A FAILED lookup is deliberately not remembered (caching it
     would pin a title to "unknown" for the session), so a `tt` entry whose
     request threw reaches the card with contentRating ''. app.js then asks the
     SAME question again out of its OWN cache (app.js:5943-5947) and, if that one
     succeeds, keeps the entry on a tier it never writes back — one card, drawn
     with its position number and dead, refusing a press (app.js:3257) and
     deleting itself on a hover (app.js:2423). Under a kids cap an entry is
     therefore drawn only if it can carry the tier that admitted it.

     THE DISCRIMINATING PROOF FOR THIS IS IN THE BROWSER, not here.
     roadmaps-calendar.smoke.mjs stages a /rating route that fails the first ask
     and answers the second, and asserts "Revenge of the Sith" is absent from a
     kids grid; measured 12 Sep 2026, that assertion fails with the guard
     reverted and the card count goes 3 -> 4. This test is the cheap regression
     guard beside it. */
  const metas = [
    { id: 'tt1', contentRating: 'general' },
    { id: 'tt2', contentRating: '' },      // ours failed, app.js's retry admitted it
  ];
  assert.deepEqual(plain(rules.admitted(metas, 'general').map((m) => m.id)), ['tt1']);
  // Above 'general' an unknown tier passes at all three of app.js's checks, so
  // there is nothing to disagree about and nothing is dropped.
  assert.deepEqual(plain(rules.admitted(metas, 'teen').map((m) => m.id)), ['tt1', 'tt2']);
  assert.deepEqual(plain(rules.admitted(metas, 'adult').map((m) => m.id)), ['tt1', 'tt2']);
  /* A MISSING CAP IS THE KIDS CAP. app.js:5846 reads `state.profileCap ||
     'general'`, so cap() answering null gates exactly like 'general' there —
     and null is the state a page load starts in. */
  assert.deepEqual(plain(rules.admitted(metas, null).map((m) => m.id)), ['tt1']);
  assert.deepEqual(plain(rules.admitted(metas, '').map((m) => m.id)), ['tt1']);
  assert.deepEqual(plain(rules.admitted(null, 'general')), []);
});

test('only an id a ratings source can classify is asked about, and only once', () => {
  // Asking about a tmdb: id costs a round trip to be told nothing, and asking
  // twice about one id is the same waste. Both are the Roku's rules, from
  // source/lib/RatingApi.brs:96-108.
  const rows = [
    entry({ id: 'tt0848228' }),
    entry({ id: 'tt0848228' }),
    entry({ id: 'tmdb:24428', type: 'series' }),
    entry({ id: 'tt0903747', type: 'series' }),
  ];
  assert.deepEqual(plain(rules.ratingWants(rows, new Map())), ['movie:tt0848228', 'series:tt0903747']);
  assert.equal(rules.ratingKey(entry({ id: 'tmdb:24428' })), '');
  // And a tier already answered is not asked for again.
  assert.deepEqual(
    plain(rules.ratingWants(rows, new Map([['movie:tt0848228', 'teen']]))),
    ['series:tt0903747'],
  );
});

// ── the numbering, which is the whole feature ───────────────────────────────

test('position numbers run continuously across chapters, not per chapter', () => {
  const chapters = [
    chapter('Phase One', [entry({ id: 'tt1' }), entry({ id: 'tt2' }), entry({ id: 'tt3' })]),
    chapter('Phase Two', [entry({ id: 'tt4' }), entry({ id: 'tt5' })]),
    chapter('Phase Three', [entry({ id: 'tt6' })]),
  ];
  const out = rules.sections(chapters).map((s) => [s.name, s.startAt]);
  assert.deepEqual(plain(out), [['Phase One', 1], ['Phase Two', 4], ['Phase Three', 6]]);
});

test('an empty chapter is dropped and costs no numbers', () => {
  const chapters = [
    chapter('One', [entry({ id: 'tt1' })]),
    chapter('Empty', []),
    chapter('Two', [entry({ id: 'tt2' })]),
  ];
  const out = rules.sections(chapters);
  assert.equal(out.length, 2);
  assert.deepEqual(plain(out.map((s) => s.startAt)), [1, 2]);
});

// ── the computed strings the fleet does not send ────────────────────────────

test('a years range is one year when the ends match, and an ASCII hyphen when they do not', () => {
  assert.equal(rules.years([entry({ year: '1976' })]), '1976');
  assert.equal(rules.years([entry({ year: '1976' }), entry({ year: '1990' })]), '1976 - 1990');
  // Not an en dash. The Roku's font helper cannot draw U+2013 and renders the
  // whole subline as nothing, so all four clients say it the same way.
  assert.ok(!rules.years([entry({ year: '1976' }), entry({ year: '1990' })]).includes('–'));
});

test('a blank or nonsense year cannot drag a range back to the start of the calendar', () => {
  assert.equal(rules.years([entry({ year: '', date: '' }), entry({ year: '1999' })]), '1999');
  assert.equal(rules.years([entry({ year: '0', date: '' }), entry({ year: '1999' })]), '1999');
  assert.equal(rules.years([entry({ year: '', date: '' })]), '');
});

test('the year falls back to the release date when the year field is missing', () => {
  assert.equal(rules.releaseYear(entry({ year: '', date: '2014-08-01' })), 2014);
  assert.equal(rules.releaseYear(entry({ year: '', date: '' })), 0);
});

test('a chapter subline is the years and the count, and NOT the chapter note', () => {
  // rocky-and-creed sends note:"1976-1990" for the chapter this computes
  // "1976 - 1990" for, so appending it would print the range twice.
  const section = { name: 'The Original Run', items: [entry({ year: '1976' }), entry({ year: '1990' })] };
  assert.equal(rules.subline(section), '1976 - 1990  ·  2 titles');
  assert.equal(rules.subline({ name: 'x', items: [entry({ year: '1976' })] }), '1976  ·  1 title');
  assert.equal(rules.subline({ name: 'x', items: [entry({ year: '', date: '' })] }), '1 title');
});

test('the stats line drops each clause whose number is zero', () => {
  const chapters = [chapter('a', [entry({ runtime: 120 }), entry({ runtime: 90 })])];
  assert.equal(
    rules.stats({ titles: 2, films: 2, series: 0, chapters }),
    '2 titles  ·  2 films  ·  3h 30m of film',
  );
  assert.equal(
    rules.stats({ titles: 3, films: 2, series: 1, chapters }),
    '3 titles  ·  2 films, 1 series  ·  3h 30m of film',
  );
  assert.equal(rules.stats({ titles: 1, films: 0, series: 1, chapters: [] }), '1 title  ·  1 series');
});

test('minutes of film count films only — a season count is not a minute total', () => {
  const chapters = [chapter('a', [
    entry({ runtime: 100 }),
    entry({ id: 'tt9', type: 'series', seasons: 5, runtime: 0 }),
  ])];
  assert.equal(rules.filmMinutes(chapters), 100);
  assert.equal(rules.runtimeLabel(100), '1h 40m');
  assert.equal(rules.runtimeLabel(0), '');
});

// ── the orders ──────────────────────────────────────────────────────────────

test('"Films first" is offered only on a roadmap that holds both kinds', () => {
  const filmsOnly = [chapter('a', [entry({ id: 'tt1' })])];
  const both = [chapter('a', [entry({ id: 'tt1' }), entry({ id: 'tt2', type: 'series' })])];
  assert.deepEqual(plain(rules.orders(filmsOnly)), ['saga', 'release']);
  assert.deepEqual(plain(rules.orders(both)), ['saga', 'release', 'films']);
});

test('the order labels are the ones the Roku prints', () => {
  assert.equal(rules.orderLabel('saga'), 'Saga order');
  assert.equal(rules.orderLabel('release'), 'Release order');
  assert.equal(rules.orderLabel('films'), 'Films first');
});

test('saga order is the fleet order, untouched — nothing here re-sorts it', () => {
  const chapters = [
    chapter('Second by date', [entry({ id: 'tt2', date: '2015-01-01' })]),
    chapter('First by date', [entry({ id: 'tt1', date: '2001-01-01' })]),
  ];
  const out = rules.orderedChapters(chapters, 'saga');
  assert.deepEqual(plain(out.map((c) => c.name)), ['Second by date', 'First by date']);
});

test('release order flattens every chapter into one section in date order', () => {
  const chapters = [
    chapter('B', [entry({ id: 'tt3', date: '2015-01-01' })]),
    chapter('A', [entry({ id: 'tt1', date: '2001-01-01' }), entry({ id: 'tt2', date: '2009-06-01' })]),
  ];
  const out = rules.orderedChapters(chapters, 'release');
  assert.equal(out.length, 1);
  assert.equal(out[0].name, 'Release order');
  assert.deepEqual(plain(out[0].items.map((e) => e.id)), ['tt1', 'tt2', 'tt3']);
  // And the numbering that follows still runs 1..3 over the one section.
  assert.deepEqual(plain(rules.sections(out).map((s) => s.startAt)), [1]);
});

test('films first is two sections, each in date order, not one relabelled heap', () => {
  const chapters = [chapter('All', [
    entry({ id: 'tt2', date: '2009-01-01' }),
    entry({ id: 'tt9', type: 'series', date: '2004-01-01' }),
    entry({ id: 'tt1', date: '2001-01-01' }),
  ])];
  const out = rules.orderedChapters(chapters, 'films');
  assert.deepEqual(plain(out.map((c) => c.name)), ['Films', 'Series']);
  assert.deepEqual(plain(out[0].items.map((e) => e.id)), ['tt1', 'tt2']);
  assert.deepEqual(plain(out[1].items.map((e) => e.id)), ['tt9']);
  // The numbering runs continuously across the two, so the series starts at 3.
  assert.deepEqual(plain(rules.sections(out).map((s) => s.startAt)), [1, 3]);
});

test('an entry with no date sorts after every dated one rather than to the front', () => {
  assert.equal(rules.dateKey(entry({ date: '2008-05-02' })), '2008-05-02');
  assert.equal(rules.dateKey(entry({ date: '', year: '2008' })), '2008-99-99');
  assert.equal(rules.dateKey(entry({ date: '', year: '' })), '9999-99-99');
  const out = rules.orderedChapters([chapter('a', [
    entry({ id: 'tt3', date: '', year: '' }),
    entry({ id: 'tt1', date: '1999-01-01' }),
  ])], 'release');
  assert.deepEqual(plain(out[0].items.map((e) => e.id)), ['tt1', 'tt3']);
});

test('a detail with no usable chapters comes back with none rather than with empty ones', () => {
  const detail = rules.normaliseDetail({
    slug: 'x', name: 'X', titles: 0, films: 0, series: 0,
    chapters: [{ name: 'Empty', items: [] }, { name: 'Junk', items: [{ id: '', name: '' }] }],
  }, 'x');
  assert.deepEqual(plain(detail.chapters), []);
});
