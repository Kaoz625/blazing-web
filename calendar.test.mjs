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
  // these."
  assert.equal(rules.clockOf('2026-08-23T14:30:00Z'), '2:30 pm');
  assert.equal(rules.clockOf('2026-08-23T00:05:00Z'), '12:05 am');
  assert.equal(rules.clockOf('2026-08-23T12:00:00Z'), '12:00 pm');
  assert.equal(rules.clockOf('2026-08-23T09:15:00Z'), '9:15 am');
  assert.equal(rules.clockOf('2026-08-23'), '');
  assert.equal(rules.clockOf(''), '');
});

test('exactTime:false means no hour is printed, ever', () => {
  // Every TMDB film and TV date arrives this way. "00:00" would be a lie the
  // viewer cannot see through.
  const film = item({ exactTime: false, when: '2026-09-12T00:00:00Z', subtitle: 'In theaters' });
  assert.equal(rules.entryLine(film), 'In theaters');
  const airing = item({ kind: 'anime', exactTime: true, when: '2026-09-12T23:30:00Z', subtitle: 'Ep 12' });
  assert.equal(rules.entryLine(airing), 'Ep 12   ·   11:30 pm');
  assert.equal(rules.entryLine(item({ exactTime: false, subtitle: '' })), '');
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
