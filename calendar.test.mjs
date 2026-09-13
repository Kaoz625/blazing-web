/* The calendar rules in calendar.js, tested without a browser.
 *
 * B12 put the Roku's Calendar on the web. Everything that makes it readable is
 * a decision this file holds rather than something the fleet sends: the day
 * ORDER Markus asked for (today, tomorrow, yesterday, then forward, then back),
 * the relative day labels, the twelve-hour clock, and the two contract rules —
 * an hour is never printed for a date that has none, and a manga chapter is not
 * a title you can open. Every one of those was got wrong at least once on the
 * Roku before it was got right, which is why they are pinned here.
 *
 * calendar.js is an IIFE that only publishes onto `window`; nothing in it
 * touches the DOM or the network until mount() is called.
 *
 *   node --test calendar.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./calendar.js', import.meta.url), 'utf8');

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
  return window.BlazingCalendar.rules;
}

const rules = load();
const plain = (value) => JSON.parse(JSON.stringify(value));

/* Run a block in a named timezone.
 *
 * The clock and the day buckets are the viewer's, so a test that asserts either
 * has to say WHOSE viewer or it only passes on the machine that wrote it. Node
 * re-reads process.env.TZ on the next Date call, so this is a real zone change
 * and not a stub — and the vm in load() was handed this realm's Date, so it
 * changes zone with us. */
const inZone = (tz, run) => {
  const before = process.env.TZ;
  process.env.TZ = tz;
  try {
    run();
  } finally {
    if (before === undefined) delete process.env.TZ;
    else process.env.TZ = before;
  }
};

const day = (date, items = []) => ({ date, weekday: '', items });
const item = (over = {}) => rules.normaliseEntry({
  id: 'tt1', name: 'A Film', kind: 'movie', when: '2026-09-12T00:00:00Z',
  date: '2026-09-12', exactTime: false, subtitle: 'In theaters', openable: true, ...over,
});

// ── the five filters, in the Roku's order ───────────────────────────────────

test('the five filters are the Roku\'s five, in its order', () => {
  assert.deepEqual(plain(rules.KINDS), [
    ['All', ''], ['Movies', 'movie'], ['TV Shows', 'series'],
    ['Anime', 'anime'], ['Manga', 'manga'],
  ]);
});

test('the All filter keeps everything and a kind filter keeps only its own', () => {
  const items = [item({ kind: 'movie' }), item({ kind: 'anime' }), item({ kind: 'manga' })];
  assert.equal(rules.filterItems(items, '').length, 3);
  assert.equal(rules.filterItems(items, 'anime').length, 1);
  assert.equal(rules.filterItems(items, 'anime')[0].kind, 'anime');
  assert.equal(rules.filterItems(items, 'series').length, 0);
});

// ── the day order Markus asked for ──────────────────────────────────────────

test('today comes first, then tomorrow, then yesterday, then forward, then back', () => {
  // The fleet answers in plain ascending date order, which opens the screen on
  // a week of history — this is the re-order that fixes that.
  const days = [
    day('2026-09-09'), day('2026-09-10'), day('2026-09-11'),
    day('2026-09-12'), day('2026-09-13'), day('2026-09-14'), day('2026-09-15'),
  ];
  const out = rules.orderedDays(days, '2026-09-12').map((d) => d.date);
  assert.deepEqual(plain(out), [
    '2026-09-12', // today
    '2026-09-13', // tomorrow
    '2026-09-11', // yesterday
    '2026-09-14', '2026-09-15',  // the rest of the future, ascending
    '2026-09-10', '2026-09-09',  // the rest of the past, nearest first
  ]);
});

test('the re-order loses nothing and invents nothing', () => {
  const days = [day('2026-09-01'), day('2026-09-30'), day('2026-09-12')];
  const out = rules.orderedDays(days, '2026-09-12');
  assert.equal(out.length, days.length);
  assert.deepEqual(plain(out.map((d) => d.date).sort()), ['2026-09-01', '2026-09-12', '2026-09-30']);
});

test('a window that holds no today still orders correctly', () => {
  const out = rules.orderedDays([day('2026-09-20'), day('2026-09-05')], '2026-09-12');
  assert.deepEqual(plain(out.map((d) => d.date)), ['2026-09-20', '2026-09-05']);
});

// ── day labels and date arithmetic ──────────────────────────────────────────

test('the first three days are named relative to today and the rest are dated', () => {
  assert.equal(rules.dayLabel('2026-09-12', '2026-09-12'), 'Today');
  assert.equal(rules.dayLabel('2026-09-13', '2026-09-12'), 'Tomorrow');
  assert.equal(rules.dayLabel('2026-09-11', '2026-09-12'), 'Yesterday');
  // Day then month, the same order the Roku's details page says dates in.
  assert.equal(rules.dayLabel('2026-08-23', '2026-09-12'), '23 Aug');
  assert.equal(rules.dayLabel('', '2026-09-12'), 'Scheduled');
});

test('day arithmetic survives month ends and leap years', () => {
  assert.equal(rules.shiftIso('2026-01-31', 1), '2026-02-01');
  assert.equal(rules.shiftIso('2026-03-01', -1), '2026-02-28');
  assert.equal(rules.shiftIso('2024-02-28', 1), '2024-02-29');
  assert.equal(rules.shiftIso('2026-12-31', 1), '2027-01-01');
  assert.equal(rules.shiftIso('not a date', 1), '');
});

test('an ISO day is taken off a full timestamp and refused from anything else', () => {
  assert.equal(rules.isoDayOf('2026-08-23T14:35:00Z'), '2026-08-23');
  assert.equal(rules.isoDayOf('2026-08-23'), '2026-08-23');
  assert.equal(rules.isoDayOf('yesterday'), '');
});

test('today is read in LOCAL time, not UTC', () => {
  // The fleet buckets its days in UTC and says so in its own notes; the label
  // "Today" has to mean the viewer's today or the top row is wrong for anybody
  // west of Greenwich in the evening.
  const at = new Date(2026, 8, 12, 22, 30, 0);
  assert.equal(rules.todayIso(at), '2026-09-12');
});

// ── the clock, and the rule that there may not be one ───────────────────────

test('the clock is twelve-hour with the am/pm said out loud', () => {
  // A bare 24-hour number reads as a duration: "445, 447. I don't understand
  // these." Read in UTC, where the wire hour and the viewer's hour are the same
  // number, so these pin the FORMAT and the test below pins the zone.
  inZone('UTC', () => {
    assert.equal(rules.clockOf('2026-08-23T14:30:00Z'), '2:30 pm');
    assert.equal(rules.clockOf('2026-08-23T00:05:00Z'), '12:05 am');
    assert.equal(rules.clockOf('2026-08-23T12:00:00Z'), '12:00 pm');
    assert.equal(rules.clockOf('2026-08-23T09:15:00Z'), '9:15 am');
    assert.equal(rules.clockOf('2026-08-23'), '');
    assert.equal(rules.clockOf(''), '');
  });
});

test('the clock is the VIEWER\'S, not the UTC hour the fleet sent', () => {
  /* `when` is always toISOString() upstream (blazing-fleet/calendar.js:495 and
     :631) and the window says `tz: 'UTC'`. Printing characters 11-16 of that
     string showed "2:30 pm" to everybody on earth for an airing that a New York
     viewer catches at 10:30 in the morning. */
  inZone('America/New_York', () => {
    assert.equal(rules.clockOf('2026-08-23T14:30:00Z'), '10:30 am');
  });
  inZone('Asia/Tokyo', () => {
    assert.equal(rules.clockOf('2026-08-23T14:30:00Z'), '11:30 pm');
  });
  // And a date with no hour in it still prints no hour, in any zone.
  inZone('Asia/Tokyo', () => {
    assert.equal(rules.clockOf('2026-08-23'), '');
  });
});

test('a timed row is bucketed in the viewer\'s day, and a dated one never moves', () => {
  /* The fleet buckets in UTC and says so: "Days are bucketed in UTC. Re-bucket
     from each item's `when` if you need local days." An airing at 01:00Z on the
     24th happens on the EVENING of the 23rd in New York, and used to be drawn
     under the 24th's label with "1:00 am" beneath it — both halves wrong, in
     different directions. The film beside it has a release DATE, not an instant,
     so it must stay on the 24th rather than slide back with it. */
  inZone('America/New_York', () => {
    const days = [
      day('2026-08-23', []),
      day('2026-08-24', [
        item({ id: 'tt-film', kind: 'movie', exactTime: false, when: '2026-08-24T00:00:00Z' }),
        item({ id: 'anilist:7', kind: 'anime', exactTime: true, when: '2026-08-24T01:00:00Z', subtitle: 'Ep 12' }),
      ]),
    ];
    const out = rules.localDays(days);
    assert.deepEqual(plain(out.map((d) => d.date)), ['2026-08-23', '2026-08-24']);
    assert.deepEqual(plain(out[0].items.map((e) => e.id)), ['anilist:7']);
    assert.deepEqual(plain(out[1].items.map((e) => e.id)), ['tt-film']);
    assert.equal(rules.localDayOf('2026-08-24T01:00:00Z'), '2026-08-23');
    assert.equal(rules.localDayOf('2026-08-24'), '');
  });
  // In Tokyo the same airing is on the 24th already, so nothing moves at all.
  inZone('Asia/Tokyo', () => {
    const days = [day('2026-08-23', []), day('2026-08-24', [
      item({ id: 'anilist:7', kind: 'anime', exactTime: true, when: '2026-08-24T01:00:00Z' }),
    ])];
    const out = rules.localDays(days);
    assert.deepEqual(plain(out[1].items.map((e) => e.id)), ['anilist:7']);
    assert.deepEqual(plain(out[0].items), []);
  });
});

test('a day the re-bucket creates is still in the fleet\'s ascending order', () => {
  // orderedDays() splits future from past and leans on ascending order for the
  // forward half, so a day invented at the edge of the window cannot be left
  // wherever the Map put it.
  inZone('America/New_York', () => {
    const out = rules.localDays([
      day('2026-08-24', [item({ id: 'anilist:7', kind: 'anime', exactTime: true, when: '2026-08-24T01:00:00Z' })]),
    ]);
    assert.deepEqual(plain(out.map((d) => d.date)), ['2026-08-23', '2026-08-24']);
  });
});

test('exactTime:false means no hour is printed, ever', () => {
  // Every TMDB film and TV date arrives this way. "00:00" would be a lie the
  // viewer cannot see through. In UTC, so the hour below is the FORMAT rather
  // than the zone — the zone has its own test above.
  inZone('UTC', () => {
    const film = item({ exactTime: false, when: '2026-09-12T00:00:00Z', subtitle: 'In theaters' });
    assert.equal(rules.entryLine(film), 'In theaters');
    const airing = item({ kind: 'anime', exactTime: true, when: '2026-09-12T23:30:00Z', subtitle: 'Ep 12' });
    assert.equal(rules.entryLine(airing), 'Ep 12   ·   11:30 pm');
    assert.equal(rules.entryLine(item({ exactTime: false, subtitle: '' })), '');
  });
});

// ── who gets asked what they are rated, and what the card carries ───────────

test('only an id a ratings source can classify is asked about, and only once', () => {
  /* ratingTierFor() in app.js returns '' on its first line for a non-`tt` id
     (app.js:5907) — but it charges the budget first (app.js:5944), and the fleet
     puts the timed anime and manga rows at the FRONT of every day
     (blazing-fleet/calendar.js:709). So the rows that issue no request drank the
     budget and the `tt` films at the back of the walk were never looked up. */
  const rows = [
    { id: 'tt1375666', type: 'movie' },
    { id: 'tt1375666', type: 'movie' },   // the same film again, a second airing day
    { id: 'kitsu:42', type: 'series' },
    { id: 'anilist:7', type: 'series' },
    { id: 'mangadex:9c3f', type: 'series' },
    { id: 'tmdb:114461', type: 'series' },
    { id: 'tt0903747:5:14', type: 'series' },
  ];
  assert.deepEqual(plain(rules.ratingWants(rows, new Map())), ['movie:tt1375666', 'series:tt0903747']);
  assert.equal(rules.ratingKey({ id: 'kitsu:42', type: 'series' }), '');
  assert.equal(rules.ratingKey({ id: 'mangadex:9c3f', type: 'series' }), '');
  assert.equal(rules.ratingKey({ id: 'tt1375666', type: 'movie' }), 'movie:tt1375666');
});

test('the budget is spent on lookups, not on rows that would never make one', () => {
  // An ordinary 61-day window is around 430 rows — ANIME_CAP 150 + MANGA_CAP 200
  // + two pages each of film and TV (blazing-fleet/calendar.js:126-131) — against
  // a budget of 150. The anime and the manga are the ones that cost nothing.
  const rows = [];
  for (let i = 0; i < 350; i += 1) rows.push({ id: `kitsu:${i}`, type: 'series' });
  for (let i = 0; i < 80; i += 1) rows.push({ id: `tt90${String(i).padStart(4, '0')}`, type: 'movie' });
  const wants = rules.ratingWants(rows, new Map(), 150);
  assert.equal(wants.length, 80);
  assert.ok(wants.every((key) => key.startsWith('movie:tt')));
});

test('a tier already answered is not asked for a second time', () => {
  const known = new Map([['movie:tt1', 'general']]);
  const rows = [{ id: 'tt1', type: 'movie' }, { id: 'tt2', type: 'movie' }];
  assert.deepEqual(plain(rules.ratingWants(rows, known)), ['movie:tt2']);
});

test('a card carries the tier that admitted it, not an empty string', () => {
  /* app.js re-reads meta.contentRating at openDetail (app.js:3257) and 550ms
     into a hover (app.js:2423 and :2430). With '' on the meta, ratingAllowed('')
     is false under a 'general' cap — every Kids profile — so the card was drawn,
     refused on a press, and DELETED on a hover. */
  const tiers = new Map([['movie:tt1375666', 'general']]);
  assert.equal(rules.entryMeta(item({ id: 'tt1375666', kind: 'movie' }), tiers).contentRating, 'general');
  // An id nobody can classify stays unknown, which is what the cap already knows
  // what to do with — unknown fails closed under 'general' and passes above it.
  assert.equal(rules.entryMeta(item({ id: 'kitsu:42', kind: 'anime' }), tiers).contentRating, '');
});

test('a row admitted on a tier the card cannot carry is not drawn under a kids cap', () => {
  /* THE RESIDUAL. A FAILED lookup is deliberately not remembered (caching it
     would pin a title to "unknown" for the session), so a `tt` row whose request
     threw reaches the card with contentRating ''. app.js then asks the SAME
     question again out of its OWN cache (app.js:5943-5947) and, if that one
     succeeds, keeps the row on a tier it never writes back — one card, drawn and
     dead, refusing a press (app.js:3257) and deleting itself on a hover
     (app.js:2423). Under a kids cap a row is therefore drawn only if it can
     carry the tier that admitted it.

     THE DISCRIMINATING PROOF FOR THIS IS IN THE BROWSER, not here.
     roadmaps-calendar.smoke.mjs stages a /rating route that fails the first ask
     and answers the second, and asserts the row is absent; measured 12 Sep 2026,
     that assertion fails with the guard reverted and the card count goes 3 -> 4.
     This test is the cheap regression guard beside it. */
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

// ── the wire shape ──────────────────────────────────────────────────────────

test('a row with no id or no name is not an entry', () => {
  assert.equal(rules.normaliseEntry({ id: '', name: 'X', kind: 'movie' }), null);
  assert.equal(rules.normaliseEntry({ id: 'tt1', name: '', kind: 'movie' }), null);
  assert.equal(rules.normaliseEntry(null), null);
});

test('a kind maps onto the only two types the detail sheet knows', () => {
  assert.equal(item({ kind: 'movie' }).type, 'movie');
  assert.equal(item({ kind: 'series' }).type, 'series');
  assert.equal(item({ kind: 'anime' }).type, 'series');
  assert.equal(item({ kind: 'manga' }).type, 'series');
});

test('openable is only true when the fleet says so — it is never inferred', () => {
  assert.equal(item({ openable: true }).openable, true);
  assert.equal(item({ openable: false }).openable, false);
  // A manga chapter is a release note; the fleet never marks one openable.
  assert.equal(item({ kind: 'manga', openable: undefined }).openable, false);
});

test('a poster that is not https never reaches an img src', () => {
  assert.equal(item({ poster: 'https://i/p.jpg' }).poster, 'https://i/p.jpg');
  assert.equal(item({ poster: 'javascript:alert(1)' }).poster, '');
  assert.equal(item({ poster: 'http://i/p.jpg' }).poster, '');
});

test('days without a date are dropped and their items are normalised', () => {
  const days = rules.normaliseDays([
    { date: '2026-09-12', items: [{ id: 'tt1', name: 'A', kind: 'movie', openable: true }, { id: '', name: 'junk' }] },
    { date: '', items: [] },
    null,
  ]);
  assert.equal(days.length, 1);
  assert.equal(days[0].items.length, 1);
  assert.equal(days[0].items[0].id, 'tt1');
  assert.deepEqual(plain(rules.normaliseDays(null)), []);
});
