/* The binged-layout rules (DESIGN-V2 §2.14) that livetv.js carries, tested
 * without a browser — the web half of blazing-tvos Tests/LiveBoardTests.swift.
 *
 * Every rule here is a decision the screen makes about the fleet's answer:
 * which rows are drawn and in what order, what a kids profile is allowed to
 * see, what a team follow is keyed by, what the two caption lines say, and how
 * the guide pages. A rule left inline in a renderer has no test behind it,
 * which is how the old board said "41" to a kids profile that could see 3.
 *
 * livetv.js is loaded in a vm exactly as livetv-guide.test.mjs loads it.
 *
 *   node --test livetv-board.test.mjs
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
const TZ = 'America/New_York';
/* The vm is another realm: compare plain strings, never arrays by identity. */
const ids = (list) => list.map((x) => x.id).join(',');
const keys = (list) => list.map((x) => x.key).join(',');

const ch = (id, group = 'news', extra = {}) => ({ id, name: `Channel ${id}`, group, ...extra });
const row = (key, items, extra = {}) => ({ key, title: key, kind: 'channels', color: '', count: items.length, items, ...extra });

/* ── §2.14.8 The wire ────────────────────────────────────────────────────── */

test('parseRows: no rows array is NULL (keep the last good board), not an empty board', () => {
  assert.equal(rules.parseRows(null), null);
  assert.equal(rules.parseRows({}), null);
  assert.equal(rules.parseRows({ rows: 'nope' }), null);
  const empty = rules.parseRows({ rows: [] });
  assert.equal(empty.rows.length, 0);
});

test('parseRows: one odd item never costs the row', () => {
  const parsed = rules.parseRows({
    liveNow: 30,
    rows: [
      { key: 'games', title: 'Games Today', kind: 'games', count: 623, items: [
        { id: 'binged.ev-1', name: 'Leeds at Arsenal · Live', group: 'games', number: 1,
          game: { league: 'EPL', leagueLabel: 'Premier League', state: 'in', start: '2026-10-10T11:30Z', clock: "79'",
            home: { id: null, name: 'Arsenal', short: 'Arsenal', abbr: 'ARS', score: '2' },
            away: { id: null, name: 'Leeds United', short: 'Leeds', abbr: 'LEE', score: '1' } } },
        null,
        'a string where an item should be',
        { name: 'no id' },
      ] },
      { title: 'a row with no key' },
      { key: 'tv-news', title: 'News', items: [{ id: 'n1', name: 'CNN' }] },
    ],
  });
  assert.equal(parsed.liveNow, 30);
  assert.equal(keys(parsed.rows), 'games,tv-news');
  assert.equal(parsed.rows[0].count, 623, 'the server count is the row total, not the page');
  assert.equal(parsed.rows[0].items.length, 1);
  const game = parsed.rows[0].items[0].game;
  assert.equal(game.startMs, Date.parse('2026-10-10T11:30Z'), "ESPN's no-seconds stamp still reads");
  assert.equal(game.home.abbr, 'ARS');
  assert.equal(parsed.rows[1].count, 1, 'a row with no count counts its items');
  assert.equal(parsed.rows[1].kind, 'channels');
});

test('parseSports: leagues, live and byLeague; junk dropped', () => {
  const s = rules.parseSports({
    leagues: [{ key: 'EPL', name: 'Premier League', count: 8 }, { name: 'no key' }, null],
    live: [{ id: 'g1', league: 'EPL', state: 'in' }, null],
    byLeague: { EPL: [{ id: 'g1', league: 'EPL' }, 7], NFL: 'nope' },
  });
  assert.equal(keys(s.leagues), 'EPL');
  assert.equal(s.live.length, 1);
  assert.equal(s.byLeague.EPL.length, 1);
  assert.equal(s.byLeague.NFL.length, 0);
  assert.equal(rules.parseSports(null), null);
});

/* ── §2.14.2 The rows ────────────────────────────────────────────────────── */

test('shelves: Favorites first, then the fleet order, never re-sorted', () => {
  const list = rules.shelves(
    [row('games', [ch('g1', 'games')], { kind: 'games' }), row('tv-news', [ch('n1')])],
    [ch('fav1')], 'adult');
  assert.equal(keys(list), '__favorites__,games,tv-news');
  assert.equal(list[0].title, 'Favorites');
  assert.equal(list[0].kind, 'favorites');
});

test('shelves: no favourites, no Favorites row', () => {
  assert.equal(keys(rules.shelves([row('tv-news', [ch('n1')])], [], 'adult')), 'tv-news');
});

test('shelves: the kids gate runs on every card, by its own group', () => {
  const rows = [
    row('tv-kids', [ch('k1', 'kids'), ch('k2', 'Children')], { count: 41 }),
    row('tv-mixed', [ch('k3', 'kids'), ch('n1', 'news'), ch('n2', 'news')], { count: 41 }),
    row('tv-news', [ch('n3', 'news')], { count: 41 }),
  ];
  const list = rules.shelves(rows, [ch('fav-news', 'news'), ch('fav-kids', 'kids')], 'general');
  assert.equal(keys(list), '__favorites__,tv-kids,tv-mixed', 'a row the gate empties is not drawn');
  assert.equal(ids(list[0].items), 'fav-kids', 'the gate runs on Favorites too');
  const mixed = list.find((s) => s.key === 'tv-mixed');
  assert.equal(ids(mixed.items), 'k3');
  assert.equal(mixed.count, 1, 'a kids profile is never told the unfiltered total');
  assert.equal(mixed.hasMore, false, 'no View All into cards the gate would hide');
  const kids = list.find((s) => s.key === 'tv-kids');
  assert.equal(kids.count, 41, 'an untouched row keeps the server total');
  assert.equal(kids.hasMore, true);
});

test('shelves: a null cap shows nothing at all', () => {
  assert.equal(rules.shelves([row('tv-kids', [ch('k1', 'kids')])], [ch('f', 'kids')], null).length, 0);
});

test('shelves: duplicate cards and duplicate rows are drawn once', () => {
  const list = rules.shelves([
    row('tv-news', [ch('n1'), ch('n1'), ch('n2')], { count: 3 }),
    row('tv-news', [ch('n9')]),
  ], [], 'adult');
  assert.equal(keys(list), 'tv-news');
  assert.equal(ids(list[0].items), 'n1,n2');
  assert.equal(list[0].hasMore, true, '3 on the server, 2 distinct here');
});

test('hexColour and dotFor: the header dot', () => {
  assert.equal(rules.hexColour('#98C379'), '#98c379');
  assert.equal(rules.hexColour('98c379'), '#98c379');
  assert.equal(rules.hexColour('red'), '');
  assert.equal(rules.hexColour('#98c37'), '');
  assert.equal(rules.hexColour(null), '');
  assert.equal(rules.dotFor({ kind: 'games', key: 'games' }), 'accent');
  assert.equal(rules.dotFor({ kind: 'favorites', key: '__favorites__' }), 'accent');
  assert.equal(rules.dotFor({ kind: 'sports', key: 'tv-sports', color: '#98c379' }), '#98c379');
  assert.equal(rules.dotFor({ kind: 'sports', key: 'tv-regional' }), 'good');
  assert.equal(rules.dotFor({ kind: 'channels', key: 'tv-news' }), 'dim');
  assert.equal(rules.dotFor(null), 'dim');
});

test('cleanName: playlist sort punctuation comes off the front', () => {
  assert.equal(rules.cleanName('_:| ESPN'), 'ESPN');
  assert.equal(rules.cleanName('--  Fox   Sports 1'), 'Fox Sports 1');
  assert.equal(rules.cleanName('CNN'), 'CNN');
  assert.equal(rules.cleanName(null), '');
});

/* ── Caption lines ───────────────────────────────────────────────────────── */

const leedsArsenal = {
  id: 'binged.ev-1', name: 'Leeds at Arsenal · Live', group: 'games',
  game: { league: 'EPL', leagueLabel: 'Premier League', state: 'in', clock: "79'",
    home: { name: 'Arsenal', short: 'Arsenal', abbr: 'ARS' }, away: { name: 'Leeds United', short: 'Leeds', abbr: 'LEE' } },
};

test('firstLine: "Away at Home" for a game, the clean name otherwise', () => {
  assert.equal(rules.firstLine(leedsArsenal), 'Leeds at Arsenal');
  assert.equal(rules.firstLine({ id: 'x', name: '2023 Viii Sports Invitational · 2:30 PM', group: 'games' }), '2023 Viii Sports Invitational');
  assert.equal(rules.firstLine({ id: 'x', name: '| ESPN', group: 'networks' }), 'ESPN');
  assert.equal(rules.firstLine({ id: 'x', name: 'News · Live', group: 'news' }), 'News · Live', 'only a game name loses its suffix');
});

test('secondLine: the game state, the programme on now, or NOTHING', () => {
  assert.equal(rules.secondLine(leedsArsenal), "LIVE 79' · Premier League");
  const final = { ...leedsArsenal, game: { ...leedsArsenal.game, state: 'post' } };
  assert.equal(rules.secondLine(final), 'Final · Premier League');
  const now = Date.parse('2026-10-10T14:00:00Z');
  const later = { ...leedsArsenal, game: { ...leedsArsenal.game, state: 'pre', startMs: Date.parse('2026-10-10T17:00:00Z') } };
  assert.equal(rules.secondLine(later, now, TZ), '1:00 PM · Premier League');
  const sunday = { ...leedsArsenal, game: { ...leedsArsenal.game, state: 'pre', startMs: Date.parse('2026-10-11T13:00:00Z') } };
  assert.equal(rules.secondLine(sunday, now, TZ), 'Sun 9:00 AM · Premier League');
  assert.equal(rules.secondLine({ id: 'e', name: 'ESPN', now: { title: 'SportsCenter' } }), 'SportsCenter');
  assert.equal(rules.secondLine({ id: 'e', name: 'ESPN', now: null }), '', 'never "No information"');
});

/* ── Time ────────────────────────────────────────────────────────────────── */

test('timeSpan and duration: one meridiem when both ends share it', () => {
  const at = (iso) => Date.parse(iso);
  assert.equal(rules.timeSpan(at('2026-10-10T11:00:00Z'), at('2026-10-10T13:00:00Z'), TZ), '7:00 — 9:00 AM · 2 h');
  assert.equal(rules.timeSpan(at('2026-10-10T15:30:00Z'), at('2026-10-10T17:00:00Z'), TZ), '11:30 AM — 1:00 PM · 1 h 30 min');
  assert.equal(rules.duration(45 * MIN), '45 min');
  assert.equal(rules.duration(20 * 1000), '');
  assert.equal(rules.duration(NaN), '');
  assert.equal(rules.clockLabel(at('2026-10-10T17:00:00Z'), TZ), '1:00 PM');
});

test('kickoff: a time today, a weekday and a time otherwise', () => {
  const now = Date.parse('2026-10-10T14:00:00Z');
  assert.equal(rules.kickoff(Date.parse('2026-10-10T23:00:00Z'), now, TZ), '7:00 PM');
  assert.equal(rules.kickoff(Date.parse('2026-10-11T23:00:00Z'), now, TZ), 'Sun 7:00 PM');
});

/* ── §2.14.5 Follows ─────────────────────────────────────────────────────── */

test("followKey: the fleet's own team id, LEAGUE:ABBR upper-cased", () => {
  assert.equal(rules.followKey('nfl', { id: 'nfl:ari', abbr: 'ARI', name: 'Arizona Cardinals' }), 'NFL:ARI');
  assert.equal(rules.followKey('EPL', { id: null, abbr: 'ars', name: 'Arsenal' }), 'EPL:ARS');
  assert.equal(rules.followKey('EPL', { id: '', abbr: '', name: 'Arsenal' }), 'EPL:ARSENAL');
  assert.equal(rules.followKey('EPL', { id: '', abbr: '', name: '' }), null, 'nothing to follow is not ""');
  assert.equal(rules.followKey('', { abbr: 'ARS' }), null);
  assert.equal(rules.followKey('EPL', null), null);
});

test('followKey: a crest and a game with a null-id team land on ONE key', () => {
  const crest = { id: 'epl:ars', abbr: 'ARS', name: 'Arsenal' };
  const inAGame = { id: null, abbr: 'ARS', name: 'Arsenal', short: 'Arsenal' };
  assert.equal(rules.followKey('EPL', crest), rules.followKey('EPL', inAGame));
});

test('involvesFollowed and followedFirst: followed games first, otherwise stable', () => {
  const g = (id, home, away) => ({ id, league: 'EPL', home: { abbr: home }, away: { abbr: away } });
  const games = [g('1', 'CHE', 'BOU'), g('2', 'ARS', 'LEE'), g('3', 'LIV', 'MCI'), g('4', 'FUL', 'ARS')];
  const follows = new Set(['EPL:ARS']);
  assert.equal(rules.involvesFollowed(games[1], follows), true);
  assert.equal(rules.involvesFollowed(games[0], follows), false);
  assert.equal(rules.involvesFollowed(games[1], new Set()), false);
  assert.equal(ids(rules.followedFirst(games, follows)), '2,4,1,3');
  assert.equal(ids(rules.followedFirst(games, [])), '1,2,3,4');
});

test("leagueChips: followed teams' leagues first; teamChips: the US majors lead", () => {
  const leagues = [{ key: 'EPL' }, { key: 'SERIEA' }, { key: 'NHL' }, { key: 'NFL' }, { key: 'XFL' }, { key: 'NBA' }];
  assert.equal(keys(rules.leagueChips(leagues, new Set())), 'EPL,SERIEA,NHL,NFL,XFL,NBA');
  assert.equal(keys(rules.leagueChips(leagues, new Set(['NHL:BOS']))), 'NHL,EPL,SERIEA,NFL,XFL,NBA');
  assert.equal(keys(rules.teamChips(leagues, new Set())), 'NFL,NBA,NHL,EPL,SERIEA,XFL');
  assert.equal(keys(rules.teamChips(leagues, new Set(['EPL:ARS']))), 'EPL,NFL,NBA,NHL,SERIEA,XFL');
});

/* ── §2.14.6 Search ──────────────────────────────────────────────────────── */

test('searchBoard: name AND programme, accents folded, each card once, board order', () => {
  const board = [
    { key: 'a', kind: 'sports', items: [
      { id: 'd', name: 'ESPN Deportes', now: { title: 'En Español-Alavés vs. Atlético de Madrid' } },
      { id: 'e', name: 'ESPN', now: { title: 'SportsCenter' } },
    ] },
    { key: 'b', kind: 'channels', items: [
      { id: 'e', name: 'ESPN', now: { title: 'SportsCenter' } },
      { id: 'c', name: 'CNN', now: { title: 'Atletico highlights' } },
    ] },
  ];
  assert.equal(ids(rules.searchBoard('atletico', board)), 'd,c');
  assert.equal(ids(rules.searchBoard('ESPN', board)), 'd,e');
  assert.equal(ids(rules.searchBoard('sportscenter', board)), 'e');
  assert.equal(rules.searchBoard('   ', board).length, 0);
});

test('everyChannel: the guide list, each channel once, Games Today left out', () => {
  const board = [
    { key: 'games', kind: 'games', items: [{ id: 'g1' }] },
    { key: 'a', kind: 'sports', items: [{ id: 'e' }, { id: 'f' }] },
    { key: 'b', kind: 'channels', items: [{ id: 'e' }, { id: 'c' }] },
  ];
  assert.equal(ids(rules.everyChannel(board)), 'e,f,c');
  assert.equal(ids(rules.everyChannel(board, true)), 'g1,e,f,c');
});

/* ── Fallbacks for an older fleet (a 404 only) ───────────────────────────── */

test('fallbackRows: one row per group in fleet order, with /live/now on the cards', () => {
  const groups = [{ id: 'games', name: 'Games Today', count: 9 }, { id: 'sports-us', name: 'US Sports', count: 2 }, { id: 'news', name: 'News', count: 1 }, { id: 'empty', name: 'Empty', count: 0 }];
  const pages = { games: [{ id: 'g1' }], 'sports-us': [{ id: 's1' }, { id: 's2' }], news: [{ id: 'n1' }] };
  const now = { n1: { title: 'Headlines', startMs: 1, stopMs: 2 } };
  const list = rules.fallbackRows(groups, pages, now);
  assert.equal(keys(list), 'games,sports-us,news', 'an empty group is not a row');
  assert.equal(list.map((r) => r.kind).join(','), 'games,sports,channels');
  assert.equal(list[0].count, 9);
  assert.equal(list[2].items[0].now.title, 'Headlines');
  const flat = rules.fallbackRows([], { '': [{ id: 'a' }, { id: 'b' }] }, {});
  assert.equal(keys(flat), 'all');
  assert.equal(flat[0].title, 'Channels');
  assert.equal(rules.fallbackRows([], {}, {}).length, 0);
});

test('sportsFromGames: a Sports board out of Games Today, for a fleet with no /live/sports', () => {
  const rowsIn = [
    { key: 'tv-news', kind: 'channels', items: [{ id: 'n1' }] },
    { key: 'games', kind: 'games', items: [
      { id: 'c1', game: { league: 'EPL', leagueLabel: 'Premier League', state: 'in', playable: null } },
      { id: 'c2', game: { league: 'NFL', leagueLabel: 'NFL', state: 'pre', playable: null } },
      { id: 'c3', game: { league: 'EPL', leagueLabel: 'Premier League', state: 'post', playable: false } },
      { id: 'c4' },
    ] },
  ];
  const s = rules.sportsFromGames(rowsIn);
  assert.equal(keys(s.leagues), 'EPL,NFL');
  assert.equal(s.leagues[0].count, 2);
  assert.equal(s.live.length, 1);
  assert.equal(s.byLeague.EPL[0].playId, 'c1', 'a game plays its own card');
  assert.equal(s.byLeague.EPL[0].playable, true);
  assert.equal(s.byLeague.EPL[1].playable, false, 'a known "no" stays a no');
  assert.equal(rules.sportsFromGames([]).leagues.length, 0);
});

test('liveNowCount: the LIVE games a profile may see, the server count only when the row is whole', () => {
  const games = { kind: 'games', hasMore: true, items: [{ game: { state: 'in' } }, { game: { state: 'pre' } }, { game: { state: 'in' } }] };
  assert.equal(rules.liveNowCount(30, [games]), 30);
  assert.equal(rules.liveNowCount(30, [{ ...games, hasMore: false }]), 2, 'a filtered row is never told the server total');
  assert.equal(rules.liveNowCount(30, [{ kind: 'channels', items: [] }]), 0, 'no Games Today, no count');
});

/* ── §2.14.7 The player ──────────────────────────────────────────────────── */

test('wrap: channel up/down wraps inside the row', () => {
  assert.equal(rules.wrap(0, -1, 5), 4);
  assert.equal(rules.wrap(4, 1, 5), 0);
  assert.equal(rules.wrap(2, 1, 5), 3);
  assert.equal(rules.wrap(0, 1, 0), null);
});

test('nextPicture: Fit -> Fill -> Stretch -> Fit', () => {
  assert.equal(rules.nextPicture('fit'), 'fill');
  assert.equal(rules.nextPicture('fill'), 'stretch');
  assert.equal(rules.nextPicture('stretch'), 'fit');
  assert.equal(rules.nextPicture('junk'), 'fit');
});

/* ── §2.14.3 The guide's pages ───────────────────────────────────────────── */

/* A page shows [30p, 30p + 153) minutes. It turns while the focused start
   still has under 30 minutes of room to its right, so the programme being
   read is never a sliver at the edge — LiveGuideGrid.swift's same formula. */
test('guidePage: 153 visible minutes, 30-minute pages, inside the 6 h fetched', () => {
  const base = Date.parse('2026-10-10T14:00:00Z');
  assert.equal(rules.GUIDE_MAX_PAGES, 7);
  assert.equal(rules.guidePage(base, base), 0);
  assert.equal(rules.guidePage(base + 123 * MIN, base), 0, '30 minutes of room left');
  assert.equal(rules.guidePage(base + 124 * MIN, base), 1, 'under 30: the page turns');
  assert.equal(rules.guidePage(base + 160 * MIN, base), 2);
  assert.equal(rules.guidePage(base + 200 * MIN, base), 3);
  assert.equal(rules.guidePage(base + 359 * MIN, base), 6);
  assert.equal(rules.guidePage(base + 900 * MIN, base), 6, 'never past the data');
  assert.equal(rules.guidePage(base - 60 * MIN, base), 0);
});

test('visibleSlots: clipped to the page, nothing zero-width', () => {
  const t = (m) => m * MIN;
  const slots = [
    { title: 'A', startMs: t(0), stopMs: t(60) },
    { title: 'B', startMs: t(60), stopMs: t(120) },
    { title: 'C', startMs: t(120), stopMs: t(200) },
  ];
  const vis = rules.visibleSlots(slots, t(30), t(120));
  assert.equal(vis.map((s) => `${s.title}:${s.startMs / MIN}-${s.stopMs / MIN}`).join(' '), 'A:30-60 B:60-120');
});

/* ── §2.14.7 Feeds (LEFT/RIGHT, /live/ticket/:id?feed=N) ─────────────────── */

test('nextFeed: (feed ± 1 + feeds) % feeds, nothing to switch on one feed', () => {
  assert.equal(rules.nextFeed(0, 1, 5), 1);
  assert.equal(rules.nextFeed(4, 1, 5), 0, 'RIGHT on the last feed wraps to the first');
  assert.equal(rules.nextFeed(0, -1, 5), 4, 'LEFT on the first feed wraps to the last');
  assert.equal(rules.nextFeed(2, -1, 3), 1);
  assert.equal(rules.nextFeed(0, 1, 1), null, 'one feed: nothing to switch to');
  assert.equal(rules.nextFeed(0, 1, 0), null, 'a count not known yet: nothing to switch to');
  assert.equal(rules.nextFeed(9, 1, 3), 1, 'a feed outside the count is read as feed 0');
});

test('feedLabel: "Feed 2/5 · Yankees", a bare number without a name, nothing for one feed', () => {
  assert.equal(rules.feedLabel(1, 5, 'Yankees'), 'Feed 2/5 · Yankees');
  assert.equal(rules.feedLabel(2, 3, null), 'Feed 3/3');
  assert.equal(rules.feedLabel(0, 3, '  '), 'Feed 1/3');
  assert.equal(rules.feedLabel(0, 1, 'Main'), '');
  assert.equal(rules.feedLabel(0, 0, ''), '');
});
