/* Blazing web Live TV — DESIGN-V2 §2.14, the binged layout.
 *
 * Markus, 10 Oct 2026, after using the binged app on his Fire TV Stick: "our
 * live tv section should resemble this across the board". So this screen is a
 * LEFT RAIL (Channels · Guide · Sports · Teams · Favorites · Search) beside a
 * content track, exactly as the Apple TV (blazing-tvos Sources/LiveView.swift)
 * and the Roku draw it. The same file runs in a desktop browser and inside the
 * LG webOS and Samsung Tizen packages built from this repo (build-tvs.sh), so
 * every screen works with a mouse AND with a remote's arrows, OK and Back.
 *
 * WIRE CONTRACT (fleet.lyreosai.com, blazing-fleet 02f036e, DESIGN-V2 §2.14.8).
 * Every /live/* read is device-authenticated: the id goes in the query, the
 * token in a HEADER, never in a URL.
 *
 *   GET /live/rows?limit=40          the curated board: Games Today, binged's
 *       nine coloured groups, then ours. The client draws it in the fleet's
 *       order, puts its OWN Favorites row first, and applies the kids gate to
 *       every card by its own `group`.
 *   GET /live/rows/:key?skip&limit   View All, paged.
 *   GET /live/sports                 Sports: leagues, live games, schedules.
 *   GET /live/teams/:league          Teams: the crest grid. Each team's id is
 *       "<league>:<abbr>" (blazing-fleet 6a47eda), and a follow is kept under
 *       that key, upper-cased (see followKey).
 *   GET /live/guide, /live/now       the grid guide and the overlay's line.
 *   GET /live/ticket/:id             a short-lived, credential-free /live/play
 *       URL a <video> can be given. A browser cannot send X-Device-Token on a
 *       media request and an http provider URL is mixed content, so this pair
 *       is the only way a browser plays live TV at all.
 *
 * AN OLDER FLEET answers /live/rows with a 404. Then the board is built from
 * the routes this screen used before §2.14: /live/groups + /live/channels +
 * /live/now, and Sports is built from the Games Today row.
 *
 * THE PARENTAL CAP (B24). A live channel carries NO certification, so Live TV
 * is gated by GROUP NAME — groupAllowed() below is the clause-for-clause port
 * of Roku LiveTV.brs:666 and Fire TV ProfileGateRules.kt:203. A null cap is a
 * NO everywhere: the board, the press, channel up/down in the player.
 *
 * The pure rules are published on window.BlazingLiveTv.rules and tested in
 * livetv-guide.test.mjs (the B23/B24/B33 rules) and livetv-board.test.mjs
 * (§2.14), without a browser.
 */
'use strict';

(() => {
  const FLEET_BASE = window.BLAZING_FLEET_BASE || 'https://fleet.lyreosai.com';
  const DEVICE_STORAGE_KEY = 'blazing-web-profile-device-v1';
  // 12s: this screen is interactive the whole time, so a stuck read gives up
  // quickly rather than holding a board the viewer is already reading.
  const FETCH_TIMEOUT_MS = 12000;

  // The kids cap. One name, shared by server/profiles.js, ProfileClient.kt,
  // Profiles.brs and app.js's own RATINGS ladder.
  const KIDS_CAP = 'general';

  /* §2.14.2 / §2.14.9 */
  const ROW_LIMIT = 40;
  const FAVORITES_KEY = '__favorites__';
  const FAVORITES_STORE = 'blazing-live-favorites-v1';
  const FOLLOWS_STORE = 'blazing-live-follows-v1';
  const PICTURE_STORE = 'blazing-live-picture-v1';
  const FRESH_MS = 60000;     // re-read /live/rows on entering when older than this
  const BOARD_MS = 60000;     // and every 60 s while Live TV is on screen
  const GAMES_MS = 30000;     // 30 s while a Games Today row is up (the scores)
  const RETRY_MS = 15000;     // 15 s while the whole screen is unreachable
  const SPORTS_MS = 30000;    // the Sports board, while Sports/Teams/Favorites is up
  const HOLD_MS = 600;        // hold OK = favourite (§2.14.2)
  const OVERLAY_MS = 5000;    // the player overlay hides after 5 s (§2.14.7)
  const TOAST_MS = 2600;
  const GUIDE_MAX_CHANNELS = 100;  // the server's cap per /live/guide and /live/now
  const OLD_GROUPS_MAX = 14;       // fallback board: at most this many group reads

  /* The B23 grid maths, kept exactly: livetv-guide.test.mjs pins it, and the
     binged guide below is built on the same slot filling. */
  const PX_PER_MIN = 8;
  const HALF_HOUR_MIN = 30;
  const WINDOW_MINUTES = 180;
  const MIN_BLOCK_MINUTES = 15;

  /* §2.14.3, on the 1920 canvas: the grid runs x 600 … 1830, 8 px a minute. */
  const GUIDE_VISIBLE_MIN = 153;
  const GUIDE_FETCH_MIN = 360;
  const GUIDE_PAGE_MIN = 30;
  const GUIDE_MAX_PAGES = Math.floor((GUIDE_FETCH_MIN - GUIDE_VISIBLE_MIN) / GUIDE_PAGE_MIN) + 1;

  const PICTURE_MODES = ['fit', 'fill', 'stretch'];
  const PICTURE_FIT = { fit: 'contain', fill: 'cover', stretch: 'fill' };
  const PICTURE_LABEL = { fit: 'Fit', fill: 'Fill', stretch: 'Stretch' };

  const NO_PROFILE_COPY = 'Live TV needs a connected profile — live channels are private to this household.';
  const KIDS_CAPPED_COPY = 'No kids channels. This profile’s rating limit hides Live TV.';
  const UNREACHABLE_COPY = 'Live TV is not reachable — retrying';

  const SECTIONS = [
    { id: 'channels', title: 'Channels', icon: '<rect x="3" y="5" width="18" height="12" rx="2"/><path d="M8 21h8M12 17v4"/>' },
    { id: 'guide', title: 'Guide', icon: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16M15 4v16"/>' },
    { id: 'sports', title: 'Sports', icon: '<path d="M8 4h8v5a4 4 0 0 1-8 0V4z"/><path d="M8 6H5a2 2 0 0 0 2 4h1M16 6h3a2 2 0 0 1-2 4h-1M12 13v4M9 20h6M10 17h4"/>' },
    { id: 'teams', title: 'Teams', icon: '<path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z"/>' },
    { id: 'favorites', title: 'Favorites', icon: '<path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z"/>' },
    { id: 'search', title: 'Search', icon: '<circle cx="11" cy="11" r="6"/><path d="M20 20l-4.5-4.5"/>' },
  ];
  const SECTION_IDS = SECTIONS.map((s) => s.id);

  /* ══════════════════════════════════════════════════════════════════════════
     SMALL HELPERS
     ══════════════════════════════════════════════════════════════════════════ */

  function element(tag, className, content) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (content !== undefined && content !== null) node.textContent = content;
    return node;
  }

  function plainText(value, fallback = '') {
    if (typeof value !== 'string') return fallback;
    const trimmed = value.trim();
    return trimmed || fallback;
  }

  /** A string field an upstream sometimes sends as a number. */
  function text(value) {
    if (typeof value === 'string') return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    return '';
  }

  function intOf(value) {
    const n = typeof value === 'number' ? value : parseInt(text(value), 10);
    return Number.isFinite(n) ? Math.trunc(n) : null;
  }

  /* The page is https, so a http:// logo is blocked outright as mixed content
   * and the card would show a broken image instead of its name. */
  function safeHttpsUrl(value) {
    const raw = plainText(value);
    if (!raw) return '';
    try {
      const url = new URL(raw, window.location.href);
      return url.protocol === 'https:' ? url.href : '';
    } catch {
      return '';
    }
  }

  function readStore(key, fallback) {
    try {
      const value = JSON.parse(localStorage.getItem(key) || 'null');
      return value === null || value === undefined ? fallback : value;
    } catch {
      return fallback;
    }
  }

  function writeStore(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private window: the session keeps it */ }
  }

  function svgIcon(paths, className) {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('class', className || 'lt-icon');
    svg.innerHTML = paths;
    return svg;
  }

  /* ══════════════════════════════════════════════════════════════════════════
     B24. THE PARENTAL CAP
     A live channel has NO certification to look up, so Live TV is gated by
     GROUP NAME and by nothing else. NULL IS A NO. The match is substring and
     case-insensitive on purpose: the group names are upstream strings nobody
     here controls ("Kids", "Children", "Kids;Animation").
     ══════════════════════════════════════════════════════════════════════════ */

  function groupAllowed(cap, group) {
    if (cap === null || cap === undefined) return false;
    const tier = String(cap).toLowerCase();
    if (!tier) return false;
    if (tier !== KIDS_CAP) return true;
    const g = String(group || '').toLowerCase();
    return g.includes('kids') || g.includes('child');
  }

  /**
   * True for a row that is a playlist separator or a dead PPV placeholder
   * rather than something anybody can watch ("##### CBS ALABAMA #####",
   * "- NO EVENT STREAMING - | 8K EXCLUSIVE"). The curated board never sends
   * these; the old-fleet fallback and the server-side search can.
   */
  function isPlaceholder(channel) {
    const name = plainText(channel && channel.name);
    if (!name) return true;
    if (/no event streaming/i.test(name)) return true;
    const letters = name.replace(/[^A-Za-z0-9]/g, '');
    if (!letters) return true;
    if (/^[#\-=*\s]{3,}.*[#\-=*\s]{3,}$/.test(name)) return true;
    return false;
  }

  /* ══════════════════════════════════════════════════════════════════════════
     THE WIRE, read leniently (§2.14.8). One odd item never costs a row.
     ══════════════════════════════════════════════════════════════════════════ */

  /** "2026-10-10T11:30Z" (no seconds — ESPN's shape) and full ISO stamps -> ms. */
  function stampMs(value) {
    const raw = plainText(value);
    if (!raw) return 0;
    const ms = Date.parse(raw);
    return Number.isFinite(ms) ? ms : 0;
  }

  /** One /live/now or /live/guide programme, stamps in epoch ms. Null without a title. */
  function normaliseProgramme(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const title = plainText(raw.title);
    if (!title) return null;
    return {
      title,
      category: plainText(raw.category),
      desc: plainText(raw.desc),
      startMs: stampMs(raw.start),
      stopMs: stampMs(raw.stop),
    };
  }

  function normaliseTeam(raw) {
    if (!raw || typeof raw !== 'object') return null;
    return {
      id: text(raw.id), name: text(raw.name), short: text(raw.short), abbr: text(raw.abbr),
      logo: text(raw.logo), score: text(raw.score), color: text(raw.color),
    };
  }

  /** "Leeds" — the short name a score line reads; never empty when anything is known. */
  function teamLabel(team) {
    if (!team) return '';
    return team.short || team.name || team.abbr || '';
  }

  function normaliseGame(raw) {
    if (!raw || typeof raw !== 'object') return null;
    return {
      id: text(raw.id),
      league: text(raw.league),
      leagueLabel: text(raw.leagueLabel),
      sport: text(raw.sport),
      state: text(raw.state),
      startMs: stampMs(text(raw.start)),
      clock: text(raw.clock),
      detail: text(raw.detail),
      home: normaliseTeam(raw.home),
      away: normaliseTeam(raw.away),
      networks: Array.isArray(raw.networks) ? raw.networks.map(text).filter(Boolean) : [],
      venue: text(raw.venue),
      playable: typeof raw.playable === 'boolean' ? raw.playable : null,
      playId: text(raw.playId),
    };
  }

  /** Identity that survives a null id — two games on one row must never share a key. */
  function gameKey(game) {
    if (!game) return '';
    if (game.id) return game.id;
    if (game.playId) return game.playId;
    return [game.league, teamLabel(game.home), teamLabel(game.away), game.startMs || ''].join('|');
  }

  function normaliseLine(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const title = text(raw.title);
    if (!title) return null;
    return { title, startMs: stampMs(text(raw.start)), stopMs: stampMs(text(raw.stop)) };
  }

  function normaliseChannel(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const id = text(raw.id);
    if (!id) return null;
    return {
      id,
      name: text(raw.name) || id,
      logo: text(raw.logo),
      light: raw.light === true,
      number: intOf(raw.number),
      group: text(raw.group),
      streamCount: intOf(raw.streamCount),
      now: normaliseLine(raw.now),
      next: normaliseLine(raw.next),
      game: normaliseGame(raw.game),
    };
  }

  function normaliseRow(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const key = text(raw.key);
    if (!key) return null;
    const items = Array.isArray(raw.items) ? raw.items.map(normaliseChannel).filter(Boolean) : [];
    const count = intOf(raw.count);
    return {
      key,
      title: text(raw.title) || key,
      kind: text(raw.kind) || 'channels',
      color: text(raw.color),
      count: count === null ? items.length : count,
      items,
    };
  }

  /**
   * GET /live/rows. NULL when there is no `rows` array at all: that is not "an
   * empty board", it is an answer this client cannot read, and the caller must
   * keep its last good copy.
   */
  function parseRows(data) {
    if (!data || typeof data !== 'object' || !Array.isArray(data.rows)) return null;
    return { liveNow: intOf(data.liveNow) || 0, rows: data.rows.map(normaliseRow).filter(Boolean) };
  }

  function parseSports(data) {
    if (!data || typeof data !== 'object') return null;
    const leagues = (Array.isArray(data.leagues) ? data.leagues : [])
      .map((l) => (l && text(l.key) ? { key: text(l.key), name: text(l.name) || text(l.key), count: intOf(l.count) || 0 } : null))
      .filter(Boolean);
    const live = (Array.isArray(data.live) ? data.live : []).map(normaliseGame).filter(Boolean);
    const byLeague = {};
    const raw = data.byLeague && typeof data.byLeague === 'object' ? data.byLeague : {};
    for (const key of Object.keys(raw)) {
      byLeague[key] = (Array.isArray(raw[key]) ? raw[key] : []).map(normaliseGame).filter(Boolean);
    }
    return { leagues, live, byLeague };
  }

  function sportsEmpty(sports) {
    return !sports || (!sports.leagues.length && !sports.live.length && !Object.keys(sports.byLeague).length);
  }

  function parseTeams(data) {
    if (!data || typeof data !== 'object') return null;
    const league = text(data.league);
    return {
      league,
      name: text(data.name) || league,
      teams: (Array.isArray(data.teams) ? data.teams : []).map(normaliseTeam).filter(Boolean),
    };
  }

  /* ══════════════════════════════════════════════════════════════════════════
     THE RULES (§2.14). Pure, and the same rules blazing-tvos LiveBoard.swift
     carries, so every client answers the same question the same way.
     ══════════════════════════════════════════════════════════════════════════ */

  /**
   * THE ROWS AS THE CLIENT DRAWS THEM, in the fleet's order. The client never
   * re-sorts (§2.14.2): it only puts its own Favorites row first and applies
   * the kids gate to every card by its own group. A row the gate empties is
   * not drawn at all, and a kids profile is never told "41" about a row it
   * sees 3 of.
   */
  function shelves(rows, favourites, cap) {
    const out = [];
    const stars = (favourites || []).filter((c) => c && groupAllowed(cap, c.group));
    if (stars.length) {
      out.push({ key: FAVORITES_KEY, title: 'Favorites', kind: 'favorites', color: '', count: stars.length, items: stars, hasMore: false });
    }
    const seenKeys = new Set();
    for (const row of rows || []) {
      if (!row || seenKeys.has(row.key)) continue;
      seenKeys.add(row.key);
      const seen = new Set();
      const deduped = row.items.filter((c) => {
        if (seen.has(c.id)) return false;
        seen.add(c.id);
        return true;
      });
      const items = deduped.filter((c) => groupAllowed(cap, c.group));
      if (!items.length) continue;
      const filtered = items.length < deduped.length;
      out.push({
        key: row.key,
        title: row.title,
        kind: row.kind,
        color: row.color,
        count: filtered ? items.length : Math.max(row.count, items.length),
        items,
        hasMore: !filtered && row.count > items.length,
      });
    }
    return out;
  }

  /** "#98c379" -> "#98c379"; anything that is not six hex digits -> ''. */
  function hexColour(raw) {
    let s = text(raw);
    if (s.charAt(0) === '#') s = s.slice(1);
    return /^[0-9a-f]{6}$/i.test(s) ? `#${s.toLowerCase()}` : '';
  }

  /**
   * The row header's dot (§2.14.2): `accent` for Games Today and Favorites, the
   * fleet's own colour when it sends one (binged's groups), `good` for every
   * other sports row, `dim` for the rest.
   */
  function dotFor(shelf) {
    if (!shelf) return 'dim';
    if (shelf.kind === 'games' || shelf.key === FAVORITES_KEY) return 'accent';
    const hex = hexColour(shelf.color);
    if (hex) return hex;
    return shelf.kind === 'sports' ? 'good' : 'dim';
  }

  /** §2.14.7: UP/DOWN is the previous/next channel IN THE ROW, and it wraps. */
  function wrap(index, step, count) {
    if (!(count > 0)) return null;
    return (((index + step) % count) + count) % count;
  }

  /**
   * `LEAGUE:teamId` (§2.14.5), upper-cased: "NFL:ARI".
   *
   * /live/teams sends each id already in that shape, lower case — "nfl:ari"
   * (blazing-fleet 6a47eda). The part after the colon is kept, under the
   * league on screen, so a follow made from a crest and a game read from
   * /live/rows or /live/sports (whose teams can still carry a null id) land on
   * ONE key. With no id the abbreviation stands in, then the name. Null when
   * the team carries none of the three — such a crest cannot be followed
   * rather than following "".
   */
  function followKey(league, team) {
    const l = text(league);
    if (!l || !team) return null;
    for (const candidate of [team.id, team.abbr, team.name]) {
      let v = text(candidate);
      const colon = v.indexOf(':');
      if (colon >= 0) v = v.slice(colon + 1).trim();
      if (v) return `${l.toUpperCase()}:${v.toUpperCase()}`;
    }
    return null;
  }

  function involvesFollowed(game, follows) {
    const set = follows instanceof Set ? follows : new Set(follows || []);
    if (!set.size || !game || !game.league) return false;
    return [game.home, game.away].some((team) => {
      const key = team ? followKey(game.league, team) : null;
      return Boolean(key && set.has(key));
    });
  }

  /** §2.14.4: followed teams' games sort first in every list. Stable. */
  function followedFirst(games, follows) {
    const set = follows instanceof Set ? follows : new Set(follows || []);
    const list = games || [];
    if (!set.size) return list.slice();
    return list.filter((g) => involvesFollowed(g, set)).concat(list.filter((g) => !involvesFollowed(g, set)));
  }

  /** §2.14.4 chips: followed teams' leagues first, otherwise the fleet's order. */
  function leagueChips(leagues, follows) {
    const followed = new Set([...(follows || [])].map((k) => String(k).split(':')[0]));
    const list = leagues || [];
    const mine = list.filter((l) => followed.has(String(l.key).toUpperCase()));
    const rest = list.filter((l) => !followed.has(String(l.key).toUpperCase()));
    return mine.concat(rest);
  }

  /** binged's Teams chips lead with the US majors (docs/ref/binged/10-teams.jpg). */
  const TEAMS_LEAGUE_ORDER = ['NFL', 'NCAA', 'NBA', 'MLB', 'NHL', 'MLS', 'EPL', 'UCL', 'LALIGA',
    'SERIEA', 'BUNDES', 'LIGUE1', 'LIGAMX', 'UFC'];

  function teamChips(leagues, follows) {
    const rank = (l) => {
      const i = TEAMS_LEAGUE_ORDER.indexOf(String(l.key).toUpperCase());
      return i < 0 ? Number.MAX_SAFE_INTEGER : i;
    };
    const ranked = (leagues || []).map((l, i) => ({ l, i }))
      .sort((a, b) => (rank(a.l) - rank(b.l)) || (a.i - b.i))
      .map((x) => x.l);
    return leagueChips(ranked, follows);
  }

  /** A name with the playlist's sort-order punctuation taken off the front. */
  function cleanName(raw) {
    let s = text(raw);
    while (s && '_:|-'.includes(s.charAt(0))) s = s.slice(1);
    return s.replace(/\s{2,}/g, ' ').trim();
  }

  /* ── Time lines, in the viewer's clock (or the one a test hands in) ── */

  function clockParts(ms, timeZone) {
    let s = '';
    try {
      const opts = { hour: 'numeric', minute: '2-digit' };
      if (timeZone) opts.timeZone = timeZone;
      s = new Date(ms).toLocaleTimeString('en-US', opts);
    } catch {
      s = '';
    }
    const m = /(\d{1,2}:\d{2})\s*([AP]M)/i.exec(String(s).replace(/\u202f/g, ' '));
    return m ? { hm: m[1], ap: m[2].toUpperCase() } : { hm: String(s), ap: '' };
  }

  /** "1:00 PM". */
  function clockLabel(ms, timeZone) {
    const p = clockParts(ms, timeZone);
    return p.ap ? `${p.hm} ${p.ap}` : p.hm;
  }

  /** "2 h", "45 min", "1 h 30 min", to the nearest minute. Empty under half a minute. */
  function duration(ms) {
    const minutes = Math.round((Number(ms) || 0) / 60000);
    if (minutes <= 0) return '';
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    if (!h) return `${m} min`;
    return m ? `${h} h ${m} min` : `${h} h`;
  }

  /**
   * "7:00 — 9:00 AM · 2 h" (§2.14.3). The meridiem is printed once when both
   * ends share it, twice when they do not ("11:30 AM — 1:00 PM · 1 h 30 min").
   */
  function timeSpan(startMs, stopMs, timeZone) {
    const a = clockParts(startMs, timeZone);
    const b = clockParts(stopMs, timeZone);
    const left = a.hm + (a.ap === b.ap ? '' : ` ${a.ap}`);
    const right = b.ap ? `${b.hm} ${b.ap}` : b.hm;
    const span = duration(stopMs - startMs);
    return span ? `${left} — ${right} · ${span}` : `${left} — ${right}`;
  }

  function dayKey(ms, timeZone) {
    try {
      const opts = { year: 'numeric', month: 'numeric', day: 'numeric' };
      if (timeZone) opts.timeZone = timeZone;
      return new Date(ms).toLocaleDateString('en-US', opts);
    } catch {
      return '';
    }
  }

  function weekday(ms, timeZone) {
    try {
      const opts = { weekday: 'short' };
      if (timeZone) opts.timeZone = timeZone;
      return new Date(ms).toLocaleDateString('en-US', opts);
    } catch {
      return '';
    }
  }

  /** "Sat 1:00 PM" for a game not today, "1:00 PM" for one today. */
  function kickoff(ms, nowMs = Date.now(), timeZone) {
    if (dayKey(ms, timeZone) === dayKey(nowMs, timeZone)) return clockLabel(ms, timeZone);
    return `${weekday(ms, timeZone)} ${clockLabel(ms, timeZone)}`;
  }

  /** "Sat, Oct 10, 8:15 AM" — the guide's clock line. */
  function clockLine(ms, timeZone) {
    let day = '';
    try {
      const opts = { weekday: 'short', month: 'short', day: 'numeric' };
      if (timeZone) opts.timeZone = timeZone;
      day = new Date(ms).toLocaleDateString('en-US', opts);
    } catch { day = ''; }
    return day ? `${day}, ${clockLabel(ms, timeZone)}` : clockLabel(ms, timeZone);
  }

  /**
   * How far through a programme we are, 0..1. Recomputed on every repaint,
   * never stored; 0 — which draws no bar — for anything that cannot be
   * measured, because a NaN width renders FULL.
   */
  function progressOf(programme, moment = Date.now()) {
    if (!programme || !programme.startMs || !programme.stopMs) return 0;
    const span = programme.stopMs - programme.startMs;
    if (span <= 0) return 0;
    const done = moment - programme.startMs;
    if (done <= 0) return 0;
    if (done >= span) return 1;
    return done / span;
  }

  /** "5:30 PM  Premier League Darts" (B33), kept for the old card line and its test. */
  function nowLine(programme) {
    if (!programme || !programme.title) return '';
    if (!programme.startMs) return programme.title;
    return `${clockLabel(programme.startMs)}  ${programme.title}`;
  }

  /** Caption line 1: "Leeds at Arsenal" for a game, the clean channel name otherwise. */
  function firstLine(channel) {
    if (!channel) return '';
    const g = channel.game;
    if (g && teamLabel(g.away) && teamLabel(g.home)) return `${teamLabel(g.away)} at ${teamLabel(g.home)}`;
    let name = cleanName(channel.name);
    // Games Today names carry their own status suffix (" · Live", " · 2:30 PM");
    // the second line already says it.
    if (g || channel.group === 'games') {
      const cut = name.lastIndexOf(' · ');
      if (cut > 0) name = name.slice(0, cut);
    }
    return name;
  }

  /**
   * Caption line 2 (§2.14.2): the programme on now, or for a game its state.
   * EMPTY when nothing is known — never "No information".
   */
  function secondLine(channel, nowMs = Date.now(), timeZone) {
    if (!channel) return '';
    const g = channel.game;
    if (g) {
      const league = g.leagueLabel || g.league;
      if (g.state === 'in') return [g.clock ? `LIVE ${g.clock}` : 'LIVE', league].filter(Boolean).join(' · ');
      if (g.state === 'post') return ['Final', league].filter(Boolean).join(' · ');
      const when = g.startMs ? kickoff(g.startMs, nowMs, timeZone) : '';
      return [when, league].filter(Boolean).join(' · ');
    }
    return channel.now && channel.now.title ? channel.now.title : '';
  }

  function fold(value) {
    return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  }

  /**
   * §2.14.6: the channel name AND the programme on now, across every card on
   * the board. Case- and accent-insensitive, de-duplicated, in board order.
   */
  function searchBoard(query, list) {
    const q = fold(text(query));
    if (!q) return [];
    const seen = new Set();
    const out = [];
    for (const shelf of list || []) {
      for (const ch of shelf.items) {
        if (seen.has(ch.id)) continue;
        const hay = [ch.name, ch.now && ch.now.title, firstLine(ch)].map(fold);
        if (hay.some((h) => h.includes(q))) {
          seen.add(ch.id);
          out.push(ch);
        }
      }
    }
    return out;
  }

  /** Every card on the board once, in board order — the guide's channel list. */
  function everyChannel(list, includeGames = false) {
    const seen = new Set();
    const out = [];
    for (const shelf of list || []) {
      if (!includeGames && shelf.kind === 'games') continue;
      for (const ch of shelf.items) {
        if (seen.has(ch.id)) continue;
        seen.add(ch.id);
        out.push(ch);
      }
    }
    return out;
  }

  /**
   * THE FALLBACK BOARD for a fleet that answers /live/rows with a 404: one row
   * per /live/groups group, in the fleet's order, each the first page of
   * /live/channels?group=. With no groups at all it is one "Channels" row.
   */
  function fallbackRows(groups, pages, now) {
    const card = (c) => {
      const ch = Object.assign({}, c);
      const p = now && now[c.id];
      if (p) ch.now = { title: p.title, startMs: p.startMs, stopMs: p.stopMs };
      return ch;
    };
    const book = pages || {};
    if (!groups || !groups.length) {
      const all = (book[''] || []).slice(0, ROW_LIMIT).map(card);
      return all.length ? [{ key: 'all', title: 'Channels', kind: 'channels', color: '', count: all.length, items: all }] : [];
    }
    return groups.map((g) => {
      const items = (book[g.id] || []).slice(0, ROW_LIMIT).map(card);
      if (!items.length) return null;
      const kind = g.id === 'games' ? 'games' : (g.id.includes('sport') || g.id === 'networks' ? 'sports' : 'channels');
      return { key: g.id, title: g.name, kind, color: '', count: Math.max(Number(g.count) || 0, items.length), items };
    }).filter(Boolean);
  }

  /** "N live now" (§2.14.1): Games Today that are LIVE, when the profile may see them. */
  function liveNowCount(serverCount, list) {
    const games = (list || []).find((s) => s.kind === 'games');
    if (!games) return 0;
    const counted = games.items.filter((c) => c.game && c.game.state === 'in').length;
    return Math.max(counted, games.hasMore ? (Number(serverCount) || 0) : counted);
  }

  /** A sports board made of the Games Today row, for a fleet with no /live/sports. */
  function sportsFromGames(rows) {
    const row = (rows || []).find((r) => r.kind === 'games');
    const games = [];
    for (const ch of row ? row.items : []) {
      if (!ch.game) continue;
      const g = Object.assign({}, ch.game);
      if (!g.playId) g.playId = ch.id;
      if (g.playable === null || g.playable === undefined) g.playable = true;
      games.push(g);
    }
    const byLeague = {};
    const order = [];
    const names = {};
    for (const g of games) {
      const k = g.league || 'OTHER';
      if (!byLeague[k]) { byLeague[k] = []; order.push(k); }
      byLeague[k].push(g);
      names[k] = g.leagueLabel || k;
    }
    return {
      leagues: order.map((k) => ({ key: k, name: names[k], count: byLeague[k].length })),
      live: games.filter((g) => g.state === 'in'),
      byLeague,
    };
  }

  /** The guide page (30-minute steps) that shows `showingMs`, clamped to the pages that exist. */
  function guidePage(showingMs, baseMs) {
    const minutes = (showingMs - baseMs) / 60000;
    if (minutes < GUIDE_VISIBLE_MIN - GUIDE_PAGE_MIN) return 0;
    const p = Math.ceil((minutes - GUIDE_VISIBLE_MIN + GUIDE_PAGE_MIN) / GUIDE_PAGE_MIN);
    return Math.min(Math.max(p, 0), GUIDE_MAX_PAGES - 1);
  }

  /** The slots of a row that are on screen for a view window, each clipped to it. */
  function visibleSlots(slots, fromMs, toMs) {
    const out = [];
    for (const s of slots || []) {
      const start = Math.max(s.startMs, fromMs);
      const stop = Math.min(s.stopMs, toMs);
      if (stop > start) out.push({ title: s.title, startMs: start, stopMs: stop });
    }
    return out;
  }

  function nextPicture(mode) {
    const i = PICTURE_MODES.indexOf(mode);
    return PICTURE_MODES[(i + 1) % PICTURE_MODES.length];
  }

  /* ── B23. The grid maths (GuideTimeline.slots, clause for clause) ── */

  /** The window: the current half hour, and `minutes` from it. */
  function guideWindow(now = Date.now(), minutes = WINDOW_MINUTES) {
    const slotMs = HALF_HOUR_MIN * 60000;
    const start = Math.floor(now / slotMs) * slotMs;
    return { start, end: start + minutes * 60000 };
  }

  /**
   * One guide row, normalised into contiguous, gap-filled segments clipped to
   * the window. A row with one programme in it must still span the window, or
   * the grid's columns stop lining up with the ruler above them.
   */
  function guideSlots(programmes, windowStart, windowEnd, fallbackMinutes = MIN_BLOCK_MINUTES) {
    if (!(windowEnd > windowStart)) return [];
    const normalised = [];
    for (const programme of programmes || []) {
      const rawStart = Number(programme && programme.startMs) || 0;
      if (rawStart <= 0) continue;
      const rawStopRaw = Number(programme && programme.stopMs) || 0;
      const rawStop = rawStopRaw > rawStart ? rawStopRaw : rawStart + fallbackMinutes * 60000;
      const start = Math.max(windowStart, rawStart);
      const stop = Math.min(windowEnd, rawStop);
      if (stop <= start) continue;
      normalised.push({
        title: plainText(programme.title, '—'),
        startMs: start,
        stopMs: stop,
        realStartMs: rawStart,
        realStopMs: rawStop,
        desc: plainText(programme.desc),
        category: plainText(programme.category),
      });
    }
    normalised.sort((a, b) => a.startMs - b.startMs);

    const out = [];
    let cursor = windowStart;
    for (const slot of normalised) {
      if (slot.startMs > cursor) out.push({ title: 'No guide data', startMs: cursor, stopMs: slot.startMs });
      const visibleStart = Math.max(cursor, slot.startMs);
      if (slot.stopMs > visibleStart) {
        out.push(Object.assign({}, slot, { startMs: visibleStart }));
        cursor = slot.stopMs;
      }
      if (cursor >= windowEnd) break;
    }
    if (cursor < windowEnd) out.push({ title: 'No guide data', startMs: cursor, stopMs: windowEnd });
    return out;
  }

  function guidePositionPx(timeMs, windowStart, pixelsPerMinute = PX_PER_MIN) {
    return Math.trunc((Math.max(0, timeMs - windowStart) * pixelsPerMinute) / 60000);
  }

  /* ══════════════════════════════════════════════════════════════════════════
     THE NETWORK
     ══════════════════════════════════════════════════════════════════════════ */

  function storedCredentials() {
    try {
      const value = JSON.parse(localStorage.getItem(DEVICE_STORAGE_KEY) || 'null');
      if (!value || typeof value !== 'object') return null;
      const id = plainText(value.id);
      const token = plainText(value.token);
      return id && token ? { id, token } : null;
    } catch {
      return null;
    }
  }

  /**
   * Every /live/* read, with the device credential attached the way the
   * Roku's FleetAuthQuery() + FleetHeaders() pair does it. The STATUS comes
   * back too: a 404 means "an older fleet" and picks the fallback routes,
   * which a bare null could not tell from a dropped connection.
   */
  async function liveRequest(path, params = {}) {
    const credentials = storedCredentials();
    let url;
    try {
      url = new URL(`${FLEET_BASE}${path}`);
    } catch {
      return { status: 0, data: null };
    }
    for (const [key, value] of Object.entries(params)) {
      if (value !== '' && value !== null && value !== undefined) url.searchParams.set(key, String(value));
    }
    if (credentials) url.searchParams.set('deviceId', credentials.id);
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        mode: 'cors',
        credentials: 'omit',
        headers: {
          Accept: 'application/json',
          ...(credentials ? { 'X-Device-Token': credentials.token } : {}),
        },
      });
      let data = null;
      try { data = await res.json(); } catch { data = null; }
      return { status: res.status, data: res.ok ? data : null };
    } catch {
      return { status: 0, data: null };
    }
  }

  async function liveFetch(path, params = {}) {
    return (await liveRequest(path, params)).data;
  }

  /** GET /live/now -> { id: programme } for the ids that HAVE one. Null on a failed read. */
  async function fetchNow(ids) {
    const out = {};
    let any = false;
    for (let i = 0; i < ids.length; i += GUIDE_MAX_CHANNELS) {
      const data = await liveFetch('/live/now', { channels: ids.slice(i, i + GUIDE_MAX_CHANNELS).join(',') });
      if (!data || typeof data !== 'object') continue;
      any = true;
      const map = (data.now && typeof data.now === 'object') ? data.now : data;
      for (const [id, raw] of Object.entries(map)) {
        const programme = normaliseProgramme(raw);
        if (programme) out[id] = programme;
      }
    }
    return any ? out : null;
  }

  /** GET /live/guide -> Map(id -> [programme]), in 100-id chunks. */
  async function fetchGuide(ids, fromMs, toMs) {
    const out = new Map();
    for (let i = 0; i < ids.length; i += GUIDE_MAX_CHANNELS) {
      const chunk = ids.slice(i, i + GUIDE_MAX_CHANNELS);
      const data = await liveFetch('/live/guide', {
        channels: chunk.join(','),
        from: new Date(fromMs).toISOString(),
        to: new Date(toMs).toISOString(),
      });
      const map = data && data.guide && typeof data.guide === 'object' ? data.guide : null;
      if (!map) continue;
      for (const [id, rows] of Object.entries(map)) {
        if (!Array.isArray(rows)) continue;
        out.set(id, rows.map(normaliseProgramme).filter(Boolean));
      }
    }
    return out;
  }

  /* ══════════════════════════════════════════════════════════════════════════
     STATE
     ══════════════════════════════════════════════════════════════════════════ */

  const state = {
    mounted: false,
    wired: false,
    /**
     * The connected profile's rating cap, or null when nobody has connected
     * one. NULL IS A NO. Carried from the blazing-profile-selected broadcast
     * alone, never from localStorage, so a remembered session the fleet has
     * since disabled cannot put a cap back that the owner took away.
     */
    cap: null,
    section: 'channels',
    rows: [],
    serverLive: 0,
    shelves: [],
    loaded: false,
    loading: false,
    unreachable: false,
    usingFallback: false,
    fetchedAt: 0,
    boardGen: 0,
    renderedSig: '',
    sports: null,
    sportsFallback: false,
    sportsAt: 0,
    sportsGen: 0,
    sportsLoading: false,
    sportsLeague: '',
    teams: {},
    teamsLeague: '',
    landPending: '',     // a section picked before its data came (landInContent)
    viewAll: null,
    search: { query: '', results: [], status: '', gen: 0 },
    lastContent: null,
  };

  const guide = {
    base: 0,
    page: 0,
    programmes: new Map(),
    loadedKey: '',
    loading: false,
    gen: 0,
    channels: [],
    focusTime: 0,
    previewId: '',
    previewHls: null,
  };

  const timers = { board: 0, sports: 0, clock: 0, toast: 0, search: 0 };
  const hold = { target: null, timer: 0, held: false };
  /** list key -> the cards drawn under it, so a press can find its row. */
  const lists = new Map();
  /** game key -> { game, list } for Sports, Teams and Favorites. */
  const gameIndex = new Map();

  function byId(id) {
    return document.getElementById(id);
  }

  function refs() {
    return {
      view: byId('livetv-view'),
      rail: byId('livetv-rail'),
      railItems: byId('livetv-rail-items'),
      liveCount: byId('livetv-live-count'),
      status: byId('livetv-status'),
      pane: byId('livetv-pane'),
      toast: byId('livetv-toast'),
    };
  }

  function noProfile() {
    return state.cap === null || state.cap === undefined || String(state.cap) === '';
  }

  function kidsCapped() {
    return String(state.cap || '').toLowerCase() === KIDS_CAP;
  }

  function onScreen() {
    const { view } = refs();
    return Boolean(view && !view.hidden && !document.hidden);
  }

  /* ── Favourites and follows: on the device, never in a URL (§2.14.9) ── */

  function storedFavourites() {
    const list = readStore(FAVORITES_STORE, []);
    return Array.isArray(list) ? list.map(normaliseChannel).filter(Boolean) : [];
  }

  function isStarred(id) {
    return storedFavourites().some((c) => c.id === id);
  }

  /** The NEW state, so the toast can say which of the two it just did. */
  function toggleFavourite(channel) {
    const list = storedFavourites();
    const at = list.findIndex((c) => c.id === channel.id);
    if (at >= 0) {
      list.splice(at, 1);
      writeStore(FAVORITES_STORE, list.map(storeShape));
      return false;
    }
    list.push(channel);
    writeStore(FAVORITES_STORE, list.map(storeShape));
    return true;
  }

  function storeShape(c) {
    return { id: c.id, name: c.name, logo: c.logo, light: c.light, number: c.number, group: c.group, streamCount: c.streamCount };
  }

  function follows() {
    const list = readStore(FOLLOWS_STORE, []);
    return new Set(Array.isArray(list) ? list.map(String) : []);
  }

  function toggleFollow(key) {
    const set = follows();
    let on;
    if (set.has(key)) { set.delete(key); on = false; } else { set.add(key); on = true; }
    writeStore(FOLLOWS_STORE, [...set].sort());
    return on;
  }

  /** A favourite drawn from the board's fresh copy when it has one (its `now` line). */
  function favouriteCards() {
    const fresh = new Map();
    for (const row of state.rows) for (const ch of row.items) if (!fresh.has(ch.id)) fresh.set(ch.id, ch);
    return storedFavourites().map((c) => fresh.get(c.id) || c);
  }

  function rebuild() {
    state.shelves = shelves(state.rows, favouriteCards(), state.cap);
    paintLiveCount();
  }

  /* ══════════════════════════════════════════════════════════════════════════
     LOADING (§2.14.8 / §2.14.9)
     ══════════════════════════════════════════════════════════════════════════ */

  async function refreshBoard(force) {
    if (noProfile()) { render({ keepFocus: true }); return; }
    if (!force && state.loaded && Date.now() - state.fetchedAt < FRESH_MS) return;
    const gen = ++state.boardGen;
    state.loading = true;
    if (!state.loaded) renderStatus();
    const { status, data } = await liveRequest('/live/rows', { limit: ROW_LIMIT });
    if (gen !== state.boardGen) return;
    const parsed = status >= 200 && status < 300 ? parseRows(data) : null;
    if (parsed) {
      state.rows = parsed.rows;
      state.serverLive = parsed.liveNow;
      state.usingFallback = false;
      accept();
    } else if (status === 404) {
      await refreshFromOldRoutes(gen);
    } else {
      state.loading = false;
      // A row that fails keeps its last copy and says nothing (§2.14.9).
      if (!state.loaded) state.unreachable = true;
      renderStatus();
    }
  }

  function accept() {
    state.fetchedAt = Date.now();
    state.loading = false;
    state.unreachable = false;
    state.loaded = true;
    rebuild();
    if (state.section === 'channels' && !state.viewAll && state.renderedSig === boardSignature()) {
      patchChannels();
      renderStatus();
    } else if (state.section !== 'sports' && state.section !== 'teams') {
      render({ keepFocus: true });
    } else {
      renderStatus();
    }
  }

  /** §2.14.8's fallback: /live/groups + /live/channels + /live/now. */
  async function refreshFromOldRoutes(gen) {
    const data = await liveFetch('/live/groups');
    if (gen !== state.boardGen) return;
    const groups = (Array.isArray(data && data.groups) ? data.groups : [])
      .map((g) => ({ id: plainText(g && g.id), name: plainText(g && g.name, plainText(g && g.id, 'Group')), count: Number(g && g.count) || 0 }))
      .filter((g) => g.id)
      // Blocked groups are never even asked for: one string test per group,
      // before any per-group request.
      .filter((g) => groupAllowed(state.cap, g.name) || groupAllowed(state.cap, g.id))
      .slice(0, OLD_GROUPS_MAX);
    const pages = {};
    const page = async (group) => {
      const answer = await liveFetch('/live/channels', { healthy: 1, limit: ROW_LIMIT, skip: 0, group });
      const rows = Array.isArray(answer && answer.channels) ? answer.channels : [];
      return rows.filter((c) => !isPlaceholder(c)).map(normaliseChannel).filter(Boolean);
    };
    if (!groups.length) pages[''] = await page('');
    else for (const g of groups) pages[g.id] = await page(g.id);
    if (gen !== state.boardGen) return;
    const ids = Object.values(pages).flatMap((list) => list.map((c) => c.id)).slice(0, 500);
    const now = ids.length ? (await fetchNow(ids)) || {} : {};
    if (gen !== state.boardGen) return;
    const rows = fallbackRows(groups, pages, now);
    if (!rows.length) {
      state.loading = false;
      if (!state.loaded) state.unreachable = true;
      renderStatus();
      return;
    }
    state.rows = rows;
    state.serverLive = 0;
    state.usingFallback = true;
    accept();
  }

  async function refreshSports(force) {
    if (noProfile()) return;
    if (!force && state.sports && Date.now() - state.sportsAt < SPORTS_MS) return;
    const gen = ++state.sportsGen;
    state.sportsLoading = true;
    const { status, data } = await liveRequest('/live/sports');
    if (gen !== state.sportsGen) return;
    state.sportsLoading = false;
    const parsed = status >= 200 && status < 300 ? parseSports(data) : null;
    if (parsed) {
      state.sports = parsed;
      state.sportsFallback = false;
      state.sportsAt = Date.now();
    } else if (status === 404) {
      // An older fleet: build the board from Games Today instead.
      state.sports = sportsFromGames(state.rows);
      state.sportsFallback = true;
      state.sportsAt = Date.now();
    } else if (!state.sports && state.loaded) {
      state.sports = sportsFromGames(state.rows);
      state.sportsFallback = true;
    }
    if (['sports', 'teams', 'favorites'].includes(state.section)) render({ keepFocus: true });
  }

  async function loadTeams(league) {
    if (!league || state.teams[league]) return;
    state.teams[league] = { league, name: league, teams: [], loading: true };
    const parsed = parseTeams(await liveFetch(`/live/teams/${encodeURIComponent(league)}`));
    state.teams[league] = parsed || { league, name: league, teams: [], failed: true };
    if (state.section === 'teams' && state.teamsLeague === league) render({ keepFocus: true });
  }

  function scheduleBoard() {
    clearTimeout(timers.board);
    const hasGames = state.shelves.some((s) => s.kind === 'games');
    const wait = state.unreachable ? RETRY_MS : (hasGames ? GAMES_MS : BOARD_MS);
    timers.board = setTimeout(async () => {
      if (onScreen()) await refreshBoard(true);
      scheduleBoard();
    }, wait);
  }

  function scheduleSports() {
    clearTimeout(timers.sports);
    timers.sports = setTimeout(async () => {
      if (onScreen() && ['sports', 'teams', 'favorites'].includes(state.section)) await refreshSports(true);
      scheduleSports();
    }, SPORTS_MS);
  }

  /** The guide's now line and the cards' bars creep forward between reads. */
  function scheduleClock() {
    clearInterval(timers.clock);
    timers.clock = setInterval(() => {
      if (!onScreen()) return;
      if (state.section === 'guide') paintGuideClock();
      else if (state.section === 'channels' && !state.viewAll) patchChannels();
    }, 30000);
  }

  /* ══════════════════════════════════════════════════════════════════════════
     DRAWING — shared pieces
     ══════════════════════════════════════════════════════════════════════════ */

  function renderStatus() {
    const { status } = refs();
    if (!status) return;
    let copy = '';
    if (noProfile()) copy = NO_PROFILE_COPY;
    else if (state.unreachable && !state.loaded) copy = UNREACHABLE_COPY;
    else if (!state.loaded && state.loading) copy = 'Finding channels…';
    else if (state.loaded && !state.shelves.length && state.section === 'channels') {
      copy = kidsCapped() ? KIDS_CAPPED_COPY : 'No channels came back. Try Search.';
    }
    status.textContent = copy;
    status.hidden = !copy;
  }

  function paintLiveCount() {
    const { liveCount } = refs();
    if (!liveCount) return;
    const n = liveNowCount(state.serverLive, state.shelves);
    liveCount.textContent = n ? `${n} live now` : 'Live now';
    liveCount.parentElement.hidden = !n;
  }

  function dotNode(dot) {
    const node = element('span', 'lt-dot');
    if (dot && dot.charAt(0) === '#') node.style.background = dot;
    else node.dataset.dot = dot || 'dim';
    return node;
  }

  function rowHeader(title, count, dot) {
    const head = element('div', 'lt-row-head');
    head.appendChild(dotNode(dot));
    head.appendChild(element('h2', 'lt-row-title', title));
    if (count !== '' && count !== null && count !== undefined) head.appendChild(element('span', 'lt-row-count', String(count)));
    return head;
  }

  function heartNode() {
    return svgIcon('<path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z"/>', 'lt-heart');
  }

  function logoImage(url, fallbackText, onFail) {
    const safe = safeHttpsUrl(url);
    if (!safe) return null;
    const img = element('img', 'lt-logo');
    img.src = safe;
    img.alt = '';
    img.loading = 'lazy';
    img.decoding = 'async';
    // A dead logo host must not leave a broken-image glyph on the plate.
    img.addEventListener('error', () => { if (onFail) onFail(img); else img.remove(); }, { once: true });
    return img;
  }

  function crestNode(team, className) {
    const box = element('span', className || 'lt-crest');
    const img = team ? logoImage(team.logo, '', (dead) => { dead.replaceWith(element('span', 'lt-crest-abbr', team.abbr || teamLabel(team).slice(0, 3))); }) : null;
    if (img) box.appendChild(img);
    else box.appendChild(element('span', 'lt-crest-abbr', team ? (team.abbr || teamLabel(team).slice(0, 3)) : ''));
    return box;
  }

  function nameText(name) {
    return element('span', 'lt-plate-name', name);
  }

  /** Away crest — score (or kickoff) — home crest, the way binged draws Games Today. */
  function gameFace(game, nowMs) {
    const face = element('span', 'lt-face');
    face.appendChild(crestNode(game.away, 'lt-crest lt-crest-big'));
    const mid = element('span', 'lt-face-mid');
    if (game.state === 'in' || game.state === 'post') {
      mid.appendChild(element('span', 'lt-face-score', `${game.away && game.away.score ? game.away.score : '0'} – ${game.home && game.home.score ? game.home.score : '0'}`));
      const pill = element('span', 'lt-pill', game.state === 'in' ? 'LIVE' : 'FINAL');
      if (game.state !== 'in') pill.dataset.tone = 'dim';
      mid.appendChild(pill);
    } else {
      mid.appendChild(element('span', 'lt-face-when', game.startMs ? kickoff(game.startMs, nowMs) : ''));
    }
    face.appendChild(mid);
    face.appendChild(crestNode(game.home, 'lt-crest lt-crest-big'));
    return face;
  }

  function fillPlate(plate, channel, nowMs) {
    const g = channel.game;
    if (g && teamLabel(g.home) && teamLabel(g.away)) {
      plate.appendChild(gameFace(g, nowMs));
      return;
    }
    const label = firstLine(channel);
    const img = channel.game ? null : logoImage(channel.logo, label, (dead) => dead.replaceWith(nameText(label)));
    plate.appendChild(img || nameText(label));
  }

  function progressNode(channel, nowMs) {
    if (channel.game) return null;
    const done = progressOf(channel.now, nowMs);
    if (!(done > 0)) return null;
    const bar = element('span', 'lt-progress');
    const fill = element('span', 'lt-progress-fill');
    fill.style.width = `${Math.round(done * 1000) / 10}%`;
    bar.appendChild(fill);
    return bar;
  }

  /** §2.14.2 — the LOGO card. */
  function logoCard(channel, listKey, index, nowMs = Date.now()) {
    const card = element('button', 'lt-card');
    card.type = 'button';
    card.dataset.nav = 'card';
    card.dataset.hold = 'channel';
    card.dataset.row = listKey;
    card.dataset.id = channel.id;
    card.dataset.index = String(index);
    const slot = element('span', 'lt-slot');
    const plate = element('span', 'lt-plate');
    if (channel.light) plate.classList.add('is-light');
    fillPlate(plate, channel, nowMs);
    const bar = progressNode(channel, nowMs);
    if (bar) plate.appendChild(bar);
    slot.appendChild(plate);
    card.appendChild(slot);
    card.appendChild(element('span', 'lt-bar'));
    paintCaptions(card, channel, nowMs);
    return card;
  }

  function paintCaptions(card, channel, nowMs) {
    let cap1 = card.querySelector('.lt-cap1');
    let cap2 = card.querySelector('.lt-cap2');
    if (!cap1) { cap1 = element('span', 'lt-cap1'); card.appendChild(cap1); }
    if (!cap2) { cap2 = element('span', 'lt-cap2'); card.appendChild(cap2); }
    cap1.replaceChildren();
    const starred = isStarred(channel.id);
    if (starred) cap1.appendChild(heartNode());
    const name = firstLine(channel);
    cap1.appendChild(element('span', 'lt-cap1-text', name));
    const line2 = secondLine(channel, nowMs);
    cap2.textContent = line2;
    cap2.dataset.live = channel.game && channel.game.state === 'in' ? 'true' : 'false';
    card.setAttribute('aria-label', [name, line2, starred ? 'Favorite' : ''].filter(Boolean).join(', '));
    card.title = line2 ? `${name} — ${line2}` : name;
  }

  function viewAllCard(shelf) {
    const card = element('button', 'lt-card lt-viewall');
    card.type = 'button';
    card.dataset.nav = 'card';
    card.dataset.row = shelf.key;
    card.dataset.id = '__viewall__';
    const slot = element('span', 'lt-slot');
    const plate = element('span', 'lt-plate');
    plate.appendChild(element('span', 'lt-viewall-label', 'View All'));
    plate.appendChild(element('span', 'lt-viewall-count', `${shelf.count.toLocaleString()} channels`));
    slot.appendChild(plate);
    card.appendChild(slot);
    card.appendChild(element('span', 'lt-bar'));
    card.appendChild(element('span', 'lt-cap1', shelf.title));
    card.setAttribute('aria-label', `View all ${shelf.count} in ${shelf.title}`);
    return card;
  }

  function messageBlock(title, body) {
    const box = element('div', 'lt-message');
    box.appendChild(element('h2', 'lt-message-title', title));
    if (body) box.appendChild(element('p', 'lt-message-body', body));
    return box;
  }

  function sectionTitle(title, count, dot) {
    return rowHeader(title, count, dot);
  }

  /* ══════════════════════════════════════════════════════════════════════════
     RENDER
     ══════════════════════════════════════════════════════════════════════════ */

  function focusKey() {
    const { pane } = refs();
    const active = document.activeElement;
    if (!pane || !active || !pane.contains(active)) return null;
    return { row: active.dataset.row || '', id: active.dataset.id || '', game: active.dataset.game || '', chip: active.dataset.chip || '', crest: active.dataset.crest || '', input: active.tagName === 'INPUT' };
  }

  function trackScrolls() {
    const { pane } = refs();
    const out = {};
    if (!pane) return out;
    for (const track of pane.querySelectorAll('.lt-track[data-row]')) out[track.dataset.row] = track.scrollLeft;
    return out;
  }

  function escapeAttr(value) {
    return String(value).replace(/["\\]/g, '\\$&');
  }

  function restoreFocus(key) {
    const { pane } = refs();
    if (!pane || !key) return false;
    let target = null;
    if (key.input) target = pane.querySelector('input');
    else if (key.game) target = pane.querySelector(`[data-game="${escapeAttr(key.game)}"]`);
    else if (key.chip) target = pane.querySelector(`[data-chip="${escapeAttr(key.chip)}"]`);
    else if (key.crest) target = pane.querySelector(`[data-crest="${escapeAttr(key.crest)}"]`);
    else if (key.id) target = pane.querySelector(`[data-row="${escapeAttr(key.row)}"][data-id="${escapeAttr(key.id)}"]`)
      || pane.querySelector(`[data-row="${escapeAttr(key.row)}"][data-nav]`);
    if (!target) target = pane.querySelector('[data-nav]');
    if (!target) return false;
    target.focus({ preventScroll: true });
    return true;
  }

  /**
   * Focus the first thing in the pane. A section picked from the rail while its
   * data is still on the way has nothing to land on yet; it remembers that,
   * and the render that brings the data lands then — unless the viewer has
   * since moved somewhere else (the nav bar, another section).
   */
  function landInContent() {
    const { pane } = refs();
    const first = pane && pane.querySelector('[data-nav]');
    state.landPending = first ? '' : state.section;
    if (first) focusItem(first);
  }

  function stillWaitingToLand() {
    if (!state.landPending || state.landPending !== state.section) return false;
    const { rail } = refs();
    const active = document.activeElement;
    return !active || active === document.body || Boolean(rail && rail.contains(active));
  }

  /**
   * One screen. `keepFocus` re-finds the focused thing by its row and id after
   * the redraw — the §2.14.9 rule "keep focus where it is" — and puts every
   * row's sideways scroll back.
   */
  function render(options = {}) {
    const { pane } = refs();
    if (!pane) return;
    const keep = options.keepFocus ? focusKey() : null;
    const scrolls = options.keepFocus ? trackScrolls() : null;
    if (state.section !== 'guide') stopPreview();
    lists.clear();
    gameIndex.clear();
    pane.replaceChildren();
    pane.dataset.section = state.section;
    renderStatus();
    markRail();
    if (!noProfile()) {
      if (state.section === 'channels') {
        if (state.viewAll) renderViewAll(pane); else renderChannels(pane);
      } else if (state.section === 'guide') renderGuide(pane);
      else if (state.section === 'sports') renderSports(pane);
      else if (state.section === 'teams') renderTeams(pane);
      else if (state.section === 'favorites') renderFavorites(pane);
      else if (state.section === 'search') renderSearch(pane);
    }
    if (scrolls) {
      for (const track of pane.querySelectorAll('.lt-track[data-row]')) {
        const left = scrolls[track.dataset.row];
        if (left) track.scrollLeft = left;
      }
    }
    if (keep) restoreFocus(keep);
    else if (options.land || stillWaitingToLand()) landInContent();
  }

  /* ── Channels (§2.14.2) ── */

  function boardSignature() {
    return state.shelves.map((s) => `${s.key}:${s.items.map((c) => c.id).join(',')}:${s.hasMore ? 1 : 0}`).join('|');
  }

  function renderChannels(pane) {
    const nowMs = Date.now();
    const frag = document.createDocumentFragment();
    for (const shelf of state.shelves) {
      lists.set(shelf.key, shelf.items);
      const row = element('section', 'lt-row');
      row.dataset.rowKey = shelf.key;
      row.appendChild(rowHeader(shelf.title, shelf.count.toLocaleString(), dotFor(shelf)));
      const track = element('div', 'lt-track');
      track.dataset.row = shelf.key;
      shelf.items.forEach((ch, i) => track.appendChild(logoCard(ch, shelf.key, i, nowMs)));
      if (shelf.hasMore) track.appendChild(viewAllCard(shelf));
      row.appendChild(track);
      frag.appendChild(row);
    }
    pane.appendChild(frag);
    state.renderedSig = boardSignature();
  }

  /**
   * The 60 s re-read changes only the `now` lines and the scores; the rows are
   * the same rows. So the cards are patched IN PLACE and focus never moves.
   */
  function patchChannels() {
    const { pane } = refs();
    if (!pane || state.section !== 'channels' || state.viewAll) return;
    const nowMs = Date.now();
    const byRow = new Map(state.shelves.map((s) => [s.key, new Map(s.items.map((c) => [c.id, c]))]));
    for (const card of pane.querySelectorAll('.lt-card[data-hold]')) {
      const ch = byRow.get(card.dataset.row) && byRow.get(card.dataset.row).get(card.dataset.id);
      if (!ch) continue;
      paintCaptions(card, ch, nowMs);
      const plate = card.querySelector('.lt-plate');
      if (!plate) continue;
      if (ch.game) {
        plate.replaceChildren();
        fillPlate(plate, ch, nowMs);
      } else {
        const old = plate.querySelector('.lt-progress');
        if (old) old.remove();
        const bar = progressNode(ch, nowMs);
        if (bar) plate.appendChild(bar);
      }
    }
    for (const row of pane.querySelectorAll('.lt-row[data-row-key]')) {
      const shelf = state.shelves.find((s) => s.key === row.dataset.rowKey);
      const count = row.querySelector('.lt-row-count');
      if (shelf && count) count.textContent = shelf.count.toLocaleString();
    }
  }

  /* ── View All (§2.11): the row as a grid of the same cards, 4 across ── */

  async function openViewAll(rowKey) {
    const shelf = state.shelves.find((s) => s.key === rowKey);
    if (!shelf) return;
    state.viewAll = { key: rowKey, title: shelf.title, count: shelf.count, items: shelf.items.slice(), skip: shelf.items.length, done: false, loading: true, via: 'row' };
    render({ land: true });
    await loadMoreViewAll(true);
  }

  async function loadMoreViewAll(first) {
    const va = state.viewAll;
    if (!va || va.done) return;
    va.loading = true;
    const key = va.key;
    let added = [];
    // /live/rows/:key, and the old /live/channels?group= paging only for a
    // fleet that does not have that route (a 404, §2.14.8). Any other failure
    // keeps the cards already drawn and stops paging for this visit.
    if (va.via === 'row') {
      const { status, data } = await liveRequest(`/live/rows/${encodeURIComponent(key)}`, { skip: va.skip, limit: ROW_LIMIT });
      if (state.viewAll !== va) return;
      const row = status >= 200 && status < 300 ? normaliseRow(data) : null;
      if (row) {
        added = row.items;
        if (row.count) va.count = Math.max(va.count, row.count);
      } else if (status === 404) {
        // The group's own paging, from its top: the ids already drawn dedupe.
        va.via = 'group';
        va.skip = 0;
      } else {
        va.via = 'none';
      }
    }
    if (va.via === 'group') {
      const answer = await liveFetch('/live/channels', { healthy: 1, limit: ROW_LIMIT, skip: va.skip, group: key });
      if (state.viewAll !== va) return;
      const rows = Array.isArray(answer && answer.channels) ? answer.channels : [];
      added = rows.filter((c) => !isPlaceholder(c)).map(normaliseChannel).filter(Boolean);
      if (!rows.length) va.via = 'none';
      if (rows.length < ROW_LIMIT) va.done = true;
    }
    if (va.via === 'none') va.done = true;
    const seen = new Set(va.items.map((c) => c.id));
    const fresh = added.filter((c) => !seen.has(c.id) && groupAllowed(state.cap, c.group));
    va.items = va.items.concat(fresh);
    va.skip += added.length;
    if (!added.length || va.items.length >= va.count) va.done = true;
    va.loading = false;
    if (state.section === 'channels' && state.viewAll === va) render({ keepFocus: !first, land: first });
  }

  function closeViewAll() {
    const key = state.viewAll && state.viewAll.key;
    state.viewAll = null;
    render();
    const { pane } = refs();
    const target = pane && (pane.querySelector(`[data-row="${escapeAttr(key)}"][data-id="__viewall__"]`)
      || pane.querySelector(`[data-row="${escapeAttr(key)}"][data-nav]`));
    if (target) focusItem(target); else landInContent();
  }

  function renderViewAll(pane) {
    const va = state.viewAll;
    const listKey = `viewall:${va.key}`;
    lists.set(listKey, va.items);
    const head = sectionTitle(va.title, va.count.toLocaleString(), 'dim');
    const back = element('button', 'lt-chip lt-back', '‹ Channels');
    back.type = 'button';
    back.dataset.nav = 'chip';
    back.dataset.chip = 'back';
    head.appendChild(back);
    pane.appendChild(head);
    const grid = element('div', 'lt-grid');
    const nowMs = Date.now();
    va.items.forEach((ch, i) => grid.appendChild(logoCard(ch, listKey, i, nowMs)));
    pane.appendChild(grid);
    if (!va.done) {
      const more = element('button', 'lt-chip lt-more', va.loading ? 'Loading…' : 'Load more');
      more.type = 'button';
      more.dataset.nav = 'chip';
      more.dataset.chip = 'more';
      pane.appendChild(more);
    }
  }

  /* ── Sports (§2.14.4) ── */

  function sportsAllowed() {
    // Games Today and the sports board are the "games" group: a kids profile
    // that may not see that group sees no scores either.
    return groupAllowed(state.cap, 'games');
  }

  function channelForGame(game) {
    if (!game || game.playable === false || !game.playId) return null;
    for (const row of state.rows) {
      const known = row.items.find((c) => c.id === game.playId);
      if (known) return known;
    }
    const title = [teamLabel(game.away), teamLabel(game.home)].filter(Boolean).join(' at ');
    return {
      id: game.playId, name: title || game.leagueLabel || 'Game', logo: game.home ? game.home.logo : '',
      light: false, number: null, group: 'games', streamCount: 1, now: null, next: null, game,
    };
  }

  function registerGames(games, listKey) {
    const list = games.map(channelForGame);
    games.forEach((g, i) => gameIndex.set(`${listKey}|${gameKey(g)}`, { game: g, list, index: i }));
  }

  function chipRow(chips, selected, kind) {
    const row = element('div', 'lt-chips');
    row.setAttribute('role', 'tablist');
    for (const chip of chips) {
      const b = element('button', 'lt-chip', chip.name);
      b.type = 'button';
      b.dataset.nav = 'chip';
      b.dataset.chip = `${kind}:${chip.key}`;
      b.setAttribute('aria-selected', String(chip.key === selected));
      if (chip.key === selected) b.classList.add('is-selected');
      row.appendChild(b);
    }
    return row;
  }

  /** SCORE card, 520 × 232 (§2.14.4). `bare` drops the score for Teams' next games. */
  function scoreCard(game, listKey, followSet, bare) {
    const live = game.state === 'in';
    const playable = Boolean(channelForGame(game));
    const card = element('button', 'lt-score');
    card.type = 'button';
    card.dataset.nav = 'game';
    card.dataset.hold = 'game';
    card.dataset.game = `${listKey}|${gameKey(game)}`;
    if (!playable && !live) card.classList.add('is-off');
    const top = element('span', 'lt-score-top');
    if (live) top.appendChild(element('span', 'lt-pill', 'LIVE'));
    else if (game.state === 'post') { const p = element('span', 'lt-pill', 'FINAL'); p.dataset.tone = 'dim'; top.appendChild(p); }
    else top.appendChild(element('span', 'lt-score-when', game.startMs ? kickoff(game.startMs) : ''));
    top.appendChild(element('span', 'lt-score-league', game.leagueLabel || game.league));
    if (involvesFollowed(game, followSet)) top.appendChild(dotNode('accent'));
    top.appendChild(element('span', 'lt-score-clock', live ? (game.clock || '') : ''));
    card.appendChild(top);
    for (const team of [game.away, game.home]) {
      const line = element('span', 'lt-score-team');
      line.appendChild(crestNode(team, 'lt-crest lt-crest-40'));
      line.appendChild(element('span', 'lt-score-name', teamLabel(team)));
      if (!bare && (live || game.state === 'post')) line.appendChild(element('span', 'lt-score-pts', team && team.score ? team.score : '0'));
      card.appendChild(line);
    }
    const foot = [];
    if (!playable && !live && game.state !== 'post') foot.push('Not on yet');
    if (game.networks.length) foot.push(game.networks.join(' · '));
    card.appendChild(element('span', 'lt-score-foot', foot.join(' · ')));
    card.setAttribute('aria-label', `${teamLabel(game.away)} at ${teamLabel(game.home)}, ${secondLine({ game })}`);
    return card;
  }

  function scheduleEntry(game, listKey, followSet) {
    const b = element('button', 'lt-sched');
    b.type = 'button';
    b.dataset.nav = 'game';
    b.dataset.hold = 'game';
    b.dataset.game = `${listKey}|${gameKey(game)}`;
    if (!channelForGame(game)) b.classList.add('is-off');
    const when = element('span', 'lt-sched-when');
    const today = game.startMs && dayKey(game.startMs) === dayKey(Date.now());
    when.appendChild(element('span', 'lt-sched-day', game.state === 'in' ? 'LIVE' : (today ? 'TODAY' : (game.startMs ? weekday(game.startMs).toUpperCase() : ''))));
    when.appendChild(element('span', 'lt-sched-time', game.state === 'in' ? (game.clock || '') : (game.startMs ? clockLabel(game.startMs) : '')));
    b.appendChild(when);
    const teams = element('span', 'lt-sched-teams');
    for (const team of [game.home, game.away]) {
      const line = element('span', 'lt-sched-team');
      line.appendChild(crestNode(team, 'lt-crest lt-crest-32'));
      line.appendChild(element('span', null, teamLabel(team)));
      teams.appendChild(line);
    }
    b.appendChild(teams);
    const right = element('span', 'lt-sched-net', game.networks.join(', '));
    if (involvesFollowed(game, followSet)) right.prepend(dotNode('accent'));
    b.appendChild(right);
    b.setAttribute('aria-label', `${teamLabel(game.away)} at ${teamLabel(game.home)}, ${secondLine({ game })}`);
    return b;
  }

  function renderSports(pane) {
    if (!sportsAllowed()) {
      pane.appendChild(messageBlock('Sports are off for this profile', 'This profile’s rating limit hides Games Today and the scores.'));
      return;
    }
    const sports = state.sports;
    if (!sports) {
      pane.appendChild(messageBlock(state.sportsLoading ? 'Finding games…' : 'No games right now', ''));
      return;
    }
    if (sportsEmpty(sports)) {
      pane.appendChild(messageBlock('No games in the next 7 days', 'The scores come back here as soon as the fleet has them.'));
      return;
    }
    const followSet = follows();
    const chips = [{ key: '', name: 'All' }].concat(leagueChips(sports.leagues, followSet));
    if (state.sportsLeague && !chips.some((c) => c.key === state.sportsLeague)) state.sportsLeague = '';
    pane.appendChild(chipRow(chips, state.sportsLeague, 'sports'));

    const league = state.sportsLeague;
    const live = followedFirst(sports.live.filter((g) => !league || g.league === league), followSet);
    if (live.length) {
      const section = element('section', 'lt-row');
      section.appendChild(rowHeader('Live now', live.length, 'accent'));
      const grid = element('div', 'lt-scores');
      registerGames(live, 'live');
      for (const g of live) grid.appendChild(scoreCard(g, 'live', followSet));
      section.appendChild(grid);
      pane.appendChild(section);
    }
    const leagues = league ? sports.leagues.filter((l) => l.key === league) : leagueChips(sports.leagues, followSet);
    for (const l of leagues) {
      const games = followedFirst((sports.byLeague[l.key] || []).filter((g) => g.state !== 'in'), followSet);
      if (!games.length) continue;
      const shown = league ? games : games.slice(0, 12);
      const section = element('section', 'lt-row');
      const hasFollowed = games.some((g) => involvesFollowed(g, followSet));
      section.appendChild(rowHeader(l.name, games.length, hasFollowed ? 'accent' : 'good'));
      const plate = element('div', 'lt-sched-plate');
      registerGames(shown, `lg-${l.key}`);
      for (const g of shown) plate.appendChild(scheduleEntry(g, `lg-${l.key}`, followSet));
      section.appendChild(plate);
      pane.appendChild(section);
    }
  }

  /* ── Teams (§2.14.5) ── */

  function renderTeams(pane) {
    if (!sportsAllowed()) {
      pane.appendChild(messageBlock('Sports are off for this profile', 'This profile’s rating limit hides Games Today and the scores.'));
      return;
    }
    const sports = state.sports;
    const followSet = follows();
    const leagues = sports ? teamChips(sports.leagues, followSet) : [];
    if (!leagues.length) {
      pane.appendChild(messageBlock(state.sportsLoading || !sports ? 'Finding teams…' : 'No leagues right now', ''));
      return;
    }
    if (!state.teamsLeague || !leagues.some((l) => l.key === state.teamsLeague)) state.teamsLeague = leagues[0].key;
    const league = state.teamsLeague;
    pane.appendChild(chipRow(leagues, league, 'teams'));
    const name = (leagues.find((l) => l.key === league) || {}).name || league;

    const games = followedFirst(sports.byLeague[league] || [], followSet);
    if (games.length) {
      const section = element('section', 'lt-row');
      section.appendChild(rowHeader(`${name} games`, games.length, 'good'));
      const track = element('div', 'lt-track lt-track-scores');
      track.dataset.row = `teams-games-${league}`;
      registerGames(games, `tg-${league}`);
      for (const g of games) track.appendChild(scoreCard(g, `tg-${league}`, followSet, g.state === 'pre' || !g.state));
      section.appendChild(track);
      pane.appendChild(section);
    }

    const answer = state.teams[league];
    if (!answer) { loadTeams(league); }
    const section = element('section', 'lt-row');
    const teams = answer ? answer.teams : [];
    section.appendChild(rowHeader('Teams', teams.length ? `${teams.length} · OK to follow` : (answer && answer.failed ? 'not available' : 'loading…'), 'dim'));
    const grid = element('div', 'lt-crests');
    for (const team of teams) {
      const key = followKey(league, team);
      const tile = element('button', 'lt-crest-tile');
      tile.type = 'button';
      tile.dataset.nav = 'crest';
      tile.dataset.crest = key || `${league}:${teamLabel(team)}`;
      if (!key) tile.disabled = true;
      const on = Boolean(key && followSet.has(key));
      if (on) tile.classList.add('is-followed');
      const plate = element('span', 'lt-crest-plate');
      plate.appendChild(crestNode(team, 'lt-crest lt-crest-80'));
      if (on) plate.appendChild(element('span', 'lt-check', '✓'));
      tile.appendChild(plate);
      tile.appendChild(element('span', 'lt-crest-name', teamLabel(team)));
      tile.appendChild(element('span', 'lt-crest-abbr-line', team.abbr));
      tile.setAttribute('aria-pressed', String(on));
      tile.setAttribute('aria-label', `${team.name || teamLabel(team)}${on ? ', following' : ''}`);
      grid.appendChild(tile);
    }
    section.appendChild(grid);
    pane.appendChild(section);
  }

  /* ── Favorites (§2.14.6) ── */

  function renderFavorites(pane) {
    const followSet = follows();
    const stars = favouriteCards().filter((c) => groupAllowed(state.cap, c.group));
    const games = sportsAllowed() && state.sports
      ? followedFirst(Object.values(state.sports.byLeague).flat().concat(state.sports.live)
        .filter((g, i, all) => all.findIndex((x) => gameKey(x) === gameKey(g)) === i)
        .filter((g) => involvesFollowed(g, followSet)), followSet)
      : [];
    if (!stars.length && !games.length) {
      pane.appendChild(messageBlock('Nothing here yet',
        'Hold OK on a channel or a game to add it here. PLAY/PAUSE does the same, and so does a right-click. Teams you follow show their games here and first in Sports.'));
      return;
    }
    if (stars.length) {
      lists.set(FAVORITES_KEY, stars);
      const row = element('section', 'lt-row');
      row.appendChild(rowHeader('Favorites', stars.length, 'accent'));
      const track = element('div', 'lt-track');
      track.dataset.row = FAVORITES_KEY;
      const nowMs = Date.now();
      stars.forEach((ch, i) => track.appendChild(logoCard(ch, FAVORITES_KEY, i, nowMs)));
      row.appendChild(track);
      pane.appendChild(row);
    }
    if (games.length) {
      const row = element('section', 'lt-row');
      row.appendChild(rowHeader('Your teams', games.length, 'accent'));
      const track = element('div', 'lt-track lt-track-scores');
      track.dataset.row = 'followed-games';
      registerGames(games, 'fav');
      for (const g of games) track.appendChild(scoreCard(g, 'fav', followSet, g.state === 'pre'));
      row.appendChild(track);
      pane.appendChild(row);
    }
  }

  /* ── Search (§2.14.6) ── */

  function renderSearch(pane) {
    const form = element('form', 'lt-search');
    form.setAttribute('role', 'search');
    const input = element('input', 'lt-search-input');
    input.type = 'search';
    input.autocomplete = 'off';
    input.placeholder = 'Search channels and what is on now';
    input.setAttribute('aria-label', 'Search Live TV');
    input.dataset.nav = 'input';
    input.value = state.search.query;
    form.appendChild(input);
    const status = element('span', 'lt-search-status', state.search.status);
    form.appendChild(status);
    pane.appendChild(form);
    const grid = element('div', 'lt-grid');
    lists.set('search', state.search.results);
    const nowMs = Date.now();
    state.search.results.forEach((ch, i) => grid.appendChild(logoCard(ch, 'search', i, nowMs)));
    pane.appendChild(grid);

    input.addEventListener('input', () => {
      clearTimeout(timers.search);
      timers.search = setTimeout(() => runSearch(input.value, false), 250);
    });
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      clearTimeout(timers.search);
      runSearch(input.value, true);
    });
  }

  /** The board first (instant, and it knows what is on now), then the fleet's whole index by name. */
  async function runSearch(raw, remote) {
    const q = text(raw);
    const gen = ++state.search.gen;
    state.search.query = q;
    if (!q) {
      state.search.results = [];
      state.search.status = '';
      paintSearch();
      return;
    }
    const local = searchBoard(q, state.shelves);
    state.search.results = local;
    state.search.status = remote ? 'Searching…' : (local.length ? `${local.length} found · Enter to search every channel` : 'Enter to search every channel');
    paintSearch();
    if (!remote) return;
    const answer = await liveFetch('/live/channels', { q, limit: ROW_LIMIT });
    if (gen !== state.search.gen) return;
    const seen = new Set(local.map((c) => c.id));
    const merged = local.slice();
    for (const raw2 of Array.isArray(answer && answer.channels) ? answer.channels : []) {
      if (isPlaceholder(raw2)) continue;
      const ch = normaliseChannel(raw2);
      if (!ch || seen.has(ch.id) || !groupAllowed(state.cap, ch.group)) continue;
      seen.add(ch.id);
      merged.push(ch);
    }
    state.search.results = merged;
    state.search.status = merged.length ? `${merged.length} found` : `Nothing matched “${q}”.`;
    paintSearch();
  }

  /** Redraw the results without touching the box the viewer is typing in. */
  function paintSearch() {
    const { pane } = refs();
    if (!pane || state.section !== 'search') return;
    const status = pane.querySelector('.lt-search-status');
    if (status) status.textContent = state.search.status;
    const grid = pane.querySelector('.lt-grid');
    if (!grid) return;
    grid.replaceChildren();
    lists.set('search', state.search.results);
    const nowMs = Date.now();
    state.search.results.forEach((ch, i) => grid.appendChild(logoCard(ch, 'search', i, nowMs)));
  }

  /* ── Guide (§2.14.3): preview on top, grid below ── */

  function guideViewStart() {
    return guide.base + guide.page * GUIDE_PAGE_MIN * 60000;
  }

  async function loadGuideData() {
    const ids = guide.channels.map((c) => c.id);
    const key = `${ids.join(',')}|${guide.base}`;
    if (!ids.length || (guide.loadedKey === key && !guide.loading)) return;
    const gen = ++guide.gen;
    guide.loading = true;
    const map = await fetchGuide(ids, guide.base, guide.base + GUIDE_FETCH_MIN * 60000);
    if (gen !== guide.gen) return;
    guide.loading = false;
    guide.loadedKey = key;
    guide.programmes = map;
    if (state.section === 'guide') render({ keepFocus: true });
  }

  function renderGuide(pane) {
    const span = guideWindow(Date.now(), GUIDE_FETCH_MIN);
    if (span.start !== guide.base) {
      guide.base = span.start;
      guide.page = 0;
    }
    guide.channels = everyChannel(state.shelves);
    if (!guide.focusTime) guide.focusTime = Date.now();

    const wrapNode = element('div', 'lt-guide');
    const top = element('div', 'lt-guide-top');
    const preview = element('div', 'lt-preview');
    preview.id = 'livetv-preview';
    top.appendChild(preview);
    const details = element('div', 'lt-details');
    details.id = 'livetv-details';
    top.appendChild(details);
    wrapNode.appendChild(top);

    const clockRow = element('div', 'lt-guide-clock');
    clockRow.appendChild(element('span', 'lt-guide-now-label', clockLine(Date.now())));
    const viewStart = guideViewStart();
    const viewEnd = viewStart + GUIDE_VISIBLE_MIN * 60000;
    for (let t = viewStart; t < viewEnd - 10 * 60000; t += HALF_HOUR_MIN * 60000) {
      const mark = element('span', 'lt-guide-mark', clockLabel(t));
      mark.style.left = `calc(var(--lt-glead) + ${((t - viewStart) / 60000) * PX_PER_MIN} * var(--lt))`;
      clockRow.appendChild(mark);
    }
    const dot = element('span', 'lt-guide-now-dot');
    clockRow.appendChild(dot);
    wrapNode.appendChild(clockRow);

    const body = element('div', 'lt-guide-body');
    const rowsNode = element('div', 'lt-guide-rows');
    if (!guide.channels.length) {
      rowsNode.appendChild(messageBlock(state.loaded ? 'No channels to list' : 'Finding channels…', ''));
    }
    const nowMs = Date.now();
    guide.channels.forEach((ch, rowIndex) => {
      const row = element('div', 'lt-grow');
      const left = element('div', 'lt-gch');
      left.appendChild(element('span', 'lt-gch-num', String(ch.number || rowIndex + 1)));
      const logoBox = element('span', 'lt-gch-logo');
      const img = logoImage(ch.logo, '', (dead) => dead.remove());
      if (img) logoBox.appendChild(img);
      left.appendChild(logoBox);
      left.appendChild(element('span', 'lt-gch-name', firstLine(ch)));
      row.appendChild(left);
      const cells = element('div', 'lt-gcells');
      const slots = guideSlots(guide.programmes.get(ch.id) || [], viewStart, viewEnd);
      for (const slot of slots) {
        const cell = element('button', 'lt-gcell');
        cell.type = 'button';
        cell.dataset.nav = 'cell';
        cell.dataset.row = String(rowIndex);
        cell.dataset.id = ch.id;
        cell.dataset.start = String(slot.startMs);
        cell.dataset.stop = String(slot.stopMs);
        const empty = slot.title === 'No guide data';
        if (empty) cell.dataset.empty = 'true';
        const on = !empty && slot.startMs <= nowMs && nowMs < slot.stopMs;
        if (on) cell.classList.add('is-now');
        const x = ((slot.startMs - viewStart) / 60000) * PX_PER_MIN;
        const w = ((slot.stopMs - slot.startMs) / 60000) * PX_PER_MIN;
        cell.style.left = `calc(${x} * var(--lt))`;
        cell.style.width = `calc(${Math.max(w - 8, 4)} * var(--lt))`;
        cell.appendChild(element('span', 'lt-gcell-title', empty ? firstLine(ch) : slot.title));
        cell.setAttribute('aria-label', `${firstLine(ch)}, ${clockLabel(slot.startMs)}, ${empty ? 'no listing' : slot.title}`);
        cells.appendChild(cell);
      }
      row.appendChild(cells);
      rowsNode.appendChild(row);
    });
    body.appendChild(rowsNode);
    const line = element('span', 'lt-guide-now-line');
    body.appendChild(line);
    wrapNode.appendChild(body);
    pane.appendChild(wrapNode);
    lists.set('guide', guide.channels);

    paintGuideClock();
    paintGuideDetails(null);
    loadGuideData();
    if (!pane.querySelector('.lt-gcell:focus')) {
      // Details describe the cell that will take focus first.
      const first = pane.querySelector('.lt-gcell.is-now') || pane.querySelector('.lt-gcell');
      if (first) paintGuideDetails(first);
    }
  }

  function paintGuideClock() {
    const { pane } = refs();
    if (!pane || state.section !== 'guide') return;
    const label = pane.querySelector('.lt-guide-now-label');
    if (label) label.textContent = clockLine(Date.now());
    const viewStart = guideViewStart();
    const minutes = (Date.now() - viewStart) / 60000;
    const visible = minutes >= 0 && minutes <= GUIDE_VISIBLE_MIN;
    const x = `calc(var(--lt-glead) + ${minutes * PX_PER_MIN} * var(--lt))`;
    for (const node of pane.querySelectorAll('.lt-guide-now-line, .lt-guide-now-dot')) {
      node.hidden = !visible;
      node.style.left = x;
    }
  }

  function guideProgramme(channelId, atMs) {
    const list = guide.programmes.get(channelId) || [];
    return list.find((p) => p.startMs <= atMs && atMs < (p.stopMs || p.startMs + MIN_BLOCK_MINUTES * 60000)) || null;
  }

  function paintGuideDetails(cell) {
    const preview = byId('livetv-preview');
    const details = byId('livetv-details');
    if (!preview || !details) return;
    const ch = cell ? guide.channels.find((c) => c.id === cell.dataset.id) : guide.channels[0];
    if (!ch) { preview.replaceChildren(); details.replaceChildren(); return; }
    const at = cell ? Number(cell.dataset.start) : Date.now();
    const p = guideProgramme(ch.id, at) || (at <= Date.now() ? ch.now : null);

    if (guide.previewId !== ch.id || !preview.querySelector('video')) {
      if (guide.previewId && guide.previewId !== ch.id) stopPreview();
      preview.replaceChildren();
      const art = element('div', 'lt-preview-art');
      const img = logoImage(ch.logo, '', (dead) => dead.replaceWith(element('span', 'lt-plate-name', firstLine(ch))));
      art.appendChild(img || element('span', 'lt-plate-name', firstLine(ch)));
      preview.appendChild(art);
      preview.appendChild(element('p', 'lt-preview-hint', 'OK to preview · OK again to watch'));
    }

    details.replaceChildren();
    details.appendChild(element('h2', 'lt-details-title', p ? p.title : firstLine(ch)));
    const meta = element('p', 'lt-details-meta');
    const nowMs = Date.now();
    if (p && p.startMs && p.startMs <= nowMs && nowMs < (p.stopMs || Infinity)) meta.appendChild(element('span', 'lt-live-word', 'LIVE'));
    if (p && p.startMs && p.stopMs) meta.appendChild(element('span', null, timeSpan(p.startMs, p.stopMs)));
    if (p && p.category) meta.appendChild(element('span', null, p.category));
    details.appendChild(meta);
    if (p && p.desc) details.appendChild(element('p', 'lt-details-desc', p.desc));
    const foot = element('p', 'lt-details-foot');
    foot.appendChild(element('span', null, String(ch.number || guide.channels.indexOf(ch) + 1)));
    foot.appendChild(element('span', 'lt-details-name', firstLine(ch)));
    if (ch.group) foot.appendChild(element('span', null, groupTitle(ch.group)));
    details.appendChild(foot);
  }

  function groupTitle(group) {
    const shelf = state.shelves.find((s) => s.key === group);
    if (shelf) return shelf.title;
    const g = String(group).replace(/^tv-/, '').replace(/-/g, ' ');
    return g.charAt(0).toUpperCase() + g.slice(1);
  }

  /** The guide's own arrows (§2.14.3): UP/DOWN keep the time, LEFT/RIGHT move by programme, the window pages 30 min. */
  function guideKey(event, key, cell) {
    const row = Number(cell.dataset.row);
    const start = Number(cell.dataset.start);
    const stop = Number(cell.dataset.stop);
    if (key === 'ok') {
      consume(event);
      if (!event.repeat) previewOrWatch(cell);
      return;
    }
    if (key === 'back') { consume(event); openRail(); return; }
    if (key === 'play') { consume(event); holdChannel(guide.channels[row]); return; }
    if (key === 'up' || key === 'down') {
      const next = row + (key === 'up' ? -1 : 1);
      if (next < 0) return; // the nav bar, through dpad.js
      consume(event);
      if (next >= guide.channels.length) return;
      focusGuideCell(next, guide.focusTime);
      return;
    }
    if (key === 'right') {
      consume(event);
      const sibling = cell.nextElementSibling;
      if (sibling && sibling.classList.contains('lt-gcell')) {
        guide.focusTime = Number(sibling.dataset.start);
        focusItem(sibling);
        return;
      }
      if (guide.page < GUIDE_MAX_PAGES - 1) {
        guide.page += 1;
        guide.focusTime = stop;
        render();
        focusGuideCell(row, stop);
      }
      return;
    }
    if (key === 'left') {
      consume(event);
      const sibling = cell.previousElementSibling;
      if (sibling && sibling.classList.contains('lt-gcell')) {
        guide.focusTime = Number(sibling.dataset.start);
        focusItem(sibling);
        return;
      }
      if (guide.page > 0) {
        guide.page -= 1;
        guide.focusTime = start - 60000;
        render();
        focusGuideCell(row, start - 60000);
        return;
      }
      openRail();
    }
  }

  function focusGuideCell(row, atMs) {
    const { pane } = refs();
    if (!pane) return;
    const cells = [...pane.querySelectorAll(`.lt-gcell[data-row="${row}"]`)];
    if (!cells.length) return;
    const hit = cells.find((c) => Number(c.dataset.start) <= atMs && atMs < Number(c.dataset.stop))
      || (atMs < Number(cells[0].dataset.start) ? cells[0] : cells[cells.length - 1]);
    focusItem(hit);
  }

  async function previewOrWatch(cell) {
    const id = cell.dataset.id;
    const index = guide.channels.findIndex((c) => c.id === id);
    const ch = guide.channels[index];
    if (!ch) return;
    if (guide.previewId === id) {
      stopPreview();
      playFrom(guide.channels, index, 'Guide', cell);
      return;
    }
    startPreview(ch);
  }

  async function startPreview(ch) {
    stopPreview();
    const preview = byId('livetv-preview');
    if (!preview) return;
    if (!groupAllowed(state.cap, ch.group)) { toast(`This profile’s rating limit hides ${firstLine(ch)}.`); return; }
    guide.previewId = ch.id;
    const hint = preview.querySelector('.lt-preview-hint');
    if (hint) hint.textContent = 'Connecting…';
    const ticket = await liveFetch(`/live/ticket/${encodeURIComponent(ch.id)}`);
    if (guide.previewId !== ch.id || state.section !== 'guide') return;
    if (!ticket || !plainText(ticket.url)) {
      if (hint) hint.textContent = `${firstLine(ch)} isn't working right now. OK again to try full screen.`;
      return;
    }
    const url = `${FLEET_BASE}${ticket.url}`;
    const video = element('video', 'lt-preview-video');
    video.playsInline = true;
    video.setAttribute('playsinline', '');
    video.autoplay = true;
    // §2.14.3: the preview plays with sound ("muted off").
    video.muted = false;
    preview.appendChild(video);
    const format = plainText(ticket.format).toLowerCase();
    const hls = format === 'hls' || /\.m3u8(\?|$)/i.test(url);
    if (hls && window.Hls && window.Hls.isSupported() && !video.canPlayType('application/vnd.apple.mpegurl')) {
      const player = new window.Hls({ enableWorker: true });
      guide.previewHls = player;
      player.loadSource(url);
      player.attachMedia(video);
    } else {
      video.src = url;
    }
    if (hint) hint.textContent = 'OK again to watch';
    const started = video.play();
    if (started && typeof started.catch === 'function') started.catch(() => { video.muted = true; video.play().catch(() => {}); });
  }

  function stopPreview() {
    if (guide.previewHls) {
      try { guide.previewHls.destroy(); } catch { /* already gone */ }
      guide.previewHls = null;
    }
    const preview = byId('livetv-preview');
    const video = preview && preview.querySelector('video');
    if (video) {
      try { video.pause(); video.removeAttribute('src'); video.load(); } catch { /* torn down */ }
      video.remove();
    }
    guide.previewId = '';
  }

  /* ══════════════════════════════════════════════════════════════════════════
     THE RAIL (§2.14.1)
     ══════════════════════════════════════════════════════════════════════════ */

  function buildRail() {
    const { railItems } = refs();
    if (!railItems || railItems.childElementCount) return;
    for (const s of SECTIONS) {
      const b = element('button', 'lt-rail-item');
      b.type = 'button';
      b.dataset.section = s.id;
      b.setAttribute('aria-label', s.title);
      b.appendChild(svgIcon(s.icon, 'lt-icon'));
      b.appendChild(element('span', 'lt-rail-label', s.title));
      b.addEventListener('click', () => selectSection(s.id, { land: true }));
      railItems.appendChild(b);
    }
  }

  function markRail() {
    const { railItems } = refs();
    if (!railItems) return;
    for (const b of railItems.querySelectorAll('.lt-rail-item')) {
      if (b.dataset.section === state.section) b.setAttribute('aria-current', 'page');
      else b.removeAttribute('aria-current');
    }
  }

  function openRail() {
    const { rail, railItems } = refs();
    if (!rail || !railItems) return;
    rail.classList.add('is-open');
    const current = railItems.querySelector(`[data-section="${state.section}"]`) || railItems.firstElementChild;
    if (current) current.focus({ preventScroll: true });
  }

  function closeRail() {
    const { rail } = refs();
    if (rail) rail.classList.remove('is-open');
    const last = state.lastContent;
    if (last && last.isConnected && !last.closest('[hidden]')) focusItem(last);
    else landInContent();
  }

  function selectSection(id, options = {}) {
    if (!SECTION_IDS.includes(id)) return;
    const { rail } = refs();
    if (rail) rail.classList.remove('is-open');
    const same = id === state.section && !state.viewAll;
    state.section = id;
    state.viewAll = null;
    state.lastContent = null;
    if (!same || options.force) render({ land: options.land });
    else if (options.land) landInContent();
    if (id === 'sports' || id === 'teams' || id === 'favorites') refreshSports(false);
    if (id === 'channels' || id === 'guide' || id === 'search') refreshBoard(false);
  }

  /* ══════════════════════════════════════════════════════════════════════════
     KEYS AND PRESSES
     dpad.js moves focus spatially for the whole app. Inside Live TV the moves
     are decided HERE (the rail, the rows, the guide's time axis), and a key
     that is handled is consumed so dpad.js does not move focus a second time.
     A key this screen leaves alone — UP from the top row — still reaches
     dpad.js, which is how focus gets back to the nav bar.
     ══════════════════════════════════════════════════════════════════════════ */

  function keyOf(event) {
    const k = event.key;
    const c = event.keyCode;
    if (k === 'ArrowUp' || c === 38) return 'up';
    if (k === 'ArrowDown' || c === 40) return 'down';
    if (k === 'ArrowLeft' || c === 37) return 'left';
    if (k === 'ArrowRight' || c === 39) return 'right';
    if (k === 'Enter' || c === 13) return 'ok';
    // webOS sends Back as keyCode 461, Tizen as 10009. A desktop sends Escape.
    if (k === 'Escape' || k === 'Back' || k === 'GoBack' || c === 461 || c === 10009) return 'back';
    if (k === 'MediaPlayPause' || k === 'MediaPlay' || c === 415 || c === 179 || c === 10252) return 'play';
    if (k === 'm' || k === 'M' || k === 'ContextMenu' || k === 'ColorF2Yellow' || c === 405 || c === 93) return 'menu';
    return null;
  }

  function consume(event) {
    event.preventDefault();
    event.stopPropagation();
  }

  function navTargets(pane) {
    return [...pane.querySelectorAll('[data-nav]')].filter((el) => !el.disabled && el.offsetParent !== null);
  }

  /** dpad.js's own metric, inside the pane only. */
  function nearestIn(pane, key, current) {
    const rect = current.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    let best = null;
    let min = Infinity;
    for (const el of navTargets(pane)) {
      if (el === current) continue;
      const r = el.getBoundingClientRect();
      const x = r.left + r.width / 2;
      const y = r.top + r.height / 2;
      let dist = -1;
      if (key === 'up' && y < cy - 1) dist = Math.abs(y - cy) * 2 + Math.abs(x - cx);
      else if (key === 'down' && y > cy + 1) dist = Math.abs(y - cy) * 2 + Math.abs(x - cx);
      else if (key === 'left' && x < cx - 1 && Math.abs(y - cy) < rect.height / 2) dist = Math.abs(x - cx);
      else if (key === 'right' && x > cx + 1 && Math.abs(y - cy) < rect.height / 2) dist = Math.abs(x - cx);
      if (dist >= 0 && dist < min) { min = dist; best = el; }
    }
    return best;
  }

  function topInset() {
    const { view } = refs();
    const v = view ? parseFloat(getComputedStyle(view).getPropertyValue('--lt-top')) : 0;
    return Number.isFinite(v) && v > 0 ? v : 96;
  }

  /** Focus a thing and bring it — and its row's header — into view. */
  function focusItem(el) {
    if (!el) return;
    el.focus({ preventScroll: true });
    const track = el.closest('.lt-track, .lt-chips');
    if (track) {
      const t = track.getBoundingClientRect();
      const r = el.getBoundingClientRect();
      if (r.left < t.left) track.scrollLeft += r.left - t.left;
      else if (r.right > t.right - 32) track.scrollLeft += r.right - t.right + 32;
    }
    const scroller = el.closest('.lt-guide-rows');
    if (scroller) {
      const s = scroller.getBoundingClientRect();
      const r = el.getBoundingClientRect();
      if (r.top < s.top) scroller.scrollTop += r.top - s.top;
      else if (r.bottom > s.bottom) scroller.scrollTop += r.bottom - s.bottom;
      return;
    }
    const anchor = el.closest('.lt-row') || el;
    const top = topInset();
    const a = anchor.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    if (a.top < top) window.scrollBy(0, a.top - top);
    else if (r.bottom > window.innerHeight - 24) window.scrollBy(0, Math.min(r.bottom - window.innerHeight + 24, a.top - top));
  }

  /** The player (or a dialog) sits over Live TV: its keys are not ours. */
  function covered() {
    const player = playerNode();
    if (player && !player.hidden) return true;
    return Boolean(document.querySelector('dialog[open]'));
  }

  function onViewKey(event) {
    const { view, rail, pane } = refs();
    if (!view || view.hidden || covered()) return;
    const key = keyOf(event);
    if (!key) return;
    const target = document.activeElement;
    if (rail && rail.contains(target)) { railKey(event, key, target); return; }
    if (pane && pane.contains(target)) paneKey(event, key, target, pane);
  }

  function railKey(event, key, target) {
    const { railItems } = refs();
    const items = [...railItems.querySelectorAll('.lt-rail-item')];
    const i = items.indexOf(target);
    if (key === 'up') {
      if (i > 0) { consume(event); items[i - 1].focus(); }
      return;
    }
    if (key === 'down') {
      consume(event);
      if (i >= 0 && i < items.length - 1) items[i + 1].focus();
      return;
    }
    if (key === 'right') { consume(event); closeRail(); return; }
    if (key === 'left') { consume(event); return; }
    if (key === 'back') {
      // BACK from the rail leaves Live TV: to the nav bar's own Live TV chip.
      consume(event);
      const { rail } = refs();
      if (rail) rail.classList.remove('is-open');
      const chip = [...document.querySelectorAll('[data-view="livetv"]')].find((el) => el.offsetParent !== null);
      if (chip) chip.focus();
    }
  }

  function paneKey(event, key, target, pane) {
    if (target.classList.contains('lt-gcell')) { guideKey(event, key, target); return; }
    const isInput = target.tagName === 'INPUT';
    if (key === 'back') {
      consume(event);
      if (state.viewAll) closeViewAll(); else openRail();
      return;
    }
    if (key === 'play') {
      if (target.dataset.hold) { consume(event); holdTarget(target); }
      return;
    }
    if (key === 'ok') {
      if (target.dataset.hold && !isInput) {
        consume(event);
        if (!event.repeat && !hold.target) startHold(target);
      }
      return;
    }
    if (key === 'menu') return;
    if (isInput && (key === 'left' || key === 'right')) return;
    const next = nearestIn(pane, key, target);
    if (next) { consume(event); focusItem(next); return; }
    if (key === 'left') { consume(event); openRail(); return; }
    if (key === 'up') return;
    consume(event);
  }

  /* Hold OK = favourite. The press is decided on KEYUP: a short press plays,
     a press held past HOLD_MS stars and does not play. */
  function startHold(target) {
    hold.target = target;
    hold.held = false;
    clearTimeout(hold.timer);
    hold.timer = setTimeout(() => {
      if (hold.target !== target) return;
      hold.held = true;
      holdTarget(target);
    }, HOLD_MS);
  }

  function onViewKeyUp(event) {
    if (keyOf(event) !== 'ok' || !hold.target) return;
    if (covered()) { clearTimeout(hold.timer); hold.target = null; hold.held = false; return; }
    const target = hold.target;
    const held = hold.held;
    clearTimeout(hold.timer);
    hold.target = null;
    hold.held = false;
    consume(event);
    if (!held && target.isConnected) target.click();
  }

  function itemFor(card) {
    const list = lists.get(card.dataset.row) || [];
    const index = list.findIndex((c) => c.id === card.dataset.id);
    return index >= 0 ? { list, index, channel: list[index] } : null;
  }

  function holdTarget(target) {
    if (target.dataset.hold === 'channel') {
      const found = itemFor(target);
      if (found) holdChannel(found.channel);
      return;
    }
    if (target.dataset.hold === 'game') {
      const entry = gameIndex.get(target.dataset.game);
      const ch = entry ? channelForGame(entry.game) : null;
      if (ch) holdChannel(ch);
      else toast('This game has no channel yet — follow its team in Teams instead.');
    }
  }

  function holdChannel(channel) {
    if (!channel) return;
    const on = toggleFavourite(channel);
    toast(on ? `Added ${firstLine(channel)} to Favorites` : `Removed ${firstLine(channel)} from Favorites`);
    rebuild();
    render({ keepFocus: true });
  }

  function onPaneClick(event) {
    const target = event.target.closest('button');
    const { pane } = refs();
    if (!target || !pane || !pane.contains(target)) return;
    if (target.classList.contains('lt-gcell')) { previewOrWatch(target); return; }
    if (target.dataset.chip) { pressChip(target.dataset.chip); return; }
    if (target.dataset.crest) { pressCrest(target.dataset.crest); return; }
    if (target.dataset.id === '__viewall__') { openViewAll(target.dataset.row); return; }
    if (target.dataset.game) {
      const entry = gameIndex.get(target.dataset.game);
      if (entry) watchGame(entry, target);
      return;
    }
    if (target.dataset.hold === 'channel') {
      const found = itemFor(target);
      if (!found) return;
      const shelf = state.shelves.find((s) => s.key === target.dataset.row);
      playFrom(found.list, found.index, shelf ? shelf.title : 'Live TV', target);
    }
  }

  function onPaneContextMenu(event) {
    const target = event.target.closest('[data-hold]');
    if (!target) return;
    event.preventDefault();
    holdTarget(target);
  }

  function pressChip(chip) {
    if (chip === 'back') { closeViewAll(); return; }
    if (chip === 'more') { loadMoreViewAll(false); return; }
    const [kind, key] = [chip.slice(0, chip.indexOf(':')), chip.slice(chip.indexOf(':') + 1)];
    if (kind === 'sports') state.sportsLeague = key;
    if (kind === 'teams') state.teamsLeague = key;
    render({ keepFocus: true });
  }

  function pressCrest(key) {
    if (!key || key.indexOf(':') < 0) return;
    const on = toggleFollow(key);
    const answer = state.teams[state.teamsLeague];
    const abbr = key.slice(key.indexOf(':') + 1);
    const team = answer && answer.teams.find((t) => followKey(state.teamsLeague, t) === key);
    toast(on ? `Following ${team ? teamLabel(team) : abbr}` : `Stopped following ${team ? teamLabel(team) : abbr}`);
    render({ keepFocus: true });
  }

  function watchGame(entry, origin) {
    const ch = channelForGame(entry.game);
    if (!ch) {
      const g = entry.game;
      toast(g.startMs && g.startMs > Date.now() ? `Not on yet — starts ${kickoff(g.startMs)}` : 'Not on yet — no feed is up for this game.');
      return;
    }
    const playable = entry.list.filter(Boolean);
    playFrom(playable, Math.max(0, playable.indexOf(ch)), 'Games', origin);
  }

  function toast(message) {
    const { toast: node } = refs();
    if (!node) return;
    node.textContent = message;
    node.hidden = false;
    clearTimeout(timers.toast);
    timers.toast = setTimeout(() => { node.hidden = true; }, TOAST_MS);
  }

  /* ══════════════════════════════════════════════════════════════════════════
     THE LIVE PLAYER (§2.14.7)
     The app's one player (app.js openPlayer, window.BlazingPlayer) plays the
     stream; this module only adds what live TV needs on top of it: the
     overlay, channel up/down in the row it was opened from, and the picture
     mode. On the native shells (Apple TV webview, Android, Tizen avplay,
     BlazeOS) openPlayer hands off and #player never shows, so none of this
     runs there — those players are their own.
     ══════════════════════════════════════════════════════════════════════════ */

  const live = {
    active: false,
    channels: [],
    index: 0,
    row: '',
    origin: null,
    originKey: null,
    gen: 0,
    overlayTimer: 0,
    stopTimer: 0,
    observer: null,
    keysWired: false,
    programme: null,
  };

  function playerNode() { return byId('player'); }
  function videoNode() { return byId('video'); }

  function playFrom(channels, index, rowTitle, origin) {
    const ch = channels[index];
    if (!ch) return;
    if (!groupAllowed(state.cap, ch.group)) {
      toast(noProfile() ? NO_PROFILE_COPY : `This profile’s rating limit hides ${firstLine(ch)}.`);
      return;
    }
    live.channels = channels;
    live.index = index;
    live.row = rowTitle;
    live.origin = origin || null;
    live.originKey = origin ? { row: origin.dataset.row || '', id: origin.dataset.id || '', game: origin.dataset.game || '' } : null;
    tune(index, true);
  }

  async function tune(index, first) {
    const ch = live.channels[index];
    if (!ch) return;
    const gen = ++live.gen;
    live.index = index;
    live.programme = ch.now || null;
    if (!first) showOverlay('Connecting…');
    else toast(`Tuning ${firstLine(ch)}…`);
    const ticket = await liveFetch(`/live/ticket/${encodeURIComponent(ch.id)}`);
    if (gen !== live.gen) return;
    if (!ticket || !plainText(ticket.url)) {
      const why = storedCredentials() ? `${firstLine(ch)} isn't working right now.` : NO_PROFILE_COPY;
      if (first || !live.active) toast(why);
      else showOverlay(`${why} ▲▼ for another channel.`);
      return;
    }
    if (!window.BlazingPlayer || typeof window.BlazingPlayer.open !== 'function') {
      toast('The player is not ready yet. Try again in a moment.');
      return;
    }
    // The server declares the format: a ticket URL carries no .m3u8 to sniff.
    window.BlazingPlayer.open(firstLine(ch), `${FLEET_BASE}${ticket.url}`, {
      streamFormat: plainText(ticket.format).toLowerCase(),
    });
    const player = playerNode();
    if (!player || player.hidden) { live.active = false; return; }
    enterLive();
    applyPicture();
    showOverlay('');
    scheduleStopReread();
  }

  function enterLive() {
    const player = playerNode();
    if (!player) return;
    live.active = true;
    player.classList.add('lt-live');
    ensureOverlay();
    if (!live.keysWired) {
      live.keysWired = true;
      window.addEventListener('keydown', onPlayerKey, true);
    }
    if (!live.observer && typeof MutationObserver === 'function') {
      live.observer = new MutationObserver(() => {
        if (live.active && player.hidden) exitLive();
      });
      live.observer.observe(player, { attributes: true, attributeFilter: ['hidden'] });
    }
  }

  /** BACK closed the player: back to the exact card or guide cell it came from. */
  function exitLive() {
    live.active = false;
    ++live.gen;
    clearTimeout(live.overlayTimer);
    clearTimeout(live.stopTimer);
    const player = playerNode();
    if (player) player.classList.remove('lt-live');
    const overlay = byId('livetv-overlay');
    if (overlay) overlay.hidden = true;
    const video = videoNode();
    if (video) video.style.objectFit = '';
    const origin = live.origin;
    if (origin && origin.isConnected && origin.offsetParent !== null) { focusItem(origin); return; }
    if (live.originKey && restoreFocus(live.originKey)) return;
    landInContent();
  }

  function ensureOverlay() {
    let overlay = byId('livetv-overlay');
    if (overlay) return overlay;
    const stage = document.querySelector('#player .player-stage');
    if (!stage) return null;
    overlay = element('div', 'lt-overlay');
    overlay.id = 'livetv-overlay';
    overlay.hidden = true;
    overlay.setAttribute('aria-live', 'polite');
    stage.appendChild(overlay);
    return overlay;
  }

  function paintOverlay(note) {
    const overlay = ensureOverlay();
    if (!overlay) return;
    const ch = live.channels[live.index];
    if (!ch) return;
    overlay.replaceChildren();
    const chip = element('div', 'lt-ov-logo');
    if (ch.light) chip.classList.add('is-light');
    const img = logoImage(ch.logo, '', (dead) => dead.replaceWith(element('span', 'lt-ov-logo-name', firstLine(ch))));
    chip.appendChild(img || element('span', 'lt-ov-logo-name', firstLine(ch)));
    overlay.appendChild(chip);

    const panel = element('div', 'lt-ov-panel');
    const line1 = element('div', 'lt-ov-line1');
    const video = videoNode();
    const paused = Boolean(video && video.paused && video.readyState >= 2);
    const pill = element('span', 'lt-pill', paused ? 'PAUSED' : 'LIVE');
    if (paused) pill.dataset.tone = 'dim';
    line1.appendChild(pill);
    line1.appendChild(element('span', 'lt-ov-name', firstLine(ch)));
    panel.appendChild(line1);
    const p = ch.game ? null : live.programme;
    const line2 = ch.game ? secondLine(ch) : (p ? p.title : '');
    if (line2) panel.appendChild(element('p', 'lt-ov-line2', line2));
    const done = progressOf(p);
    if (p && p.stopMs && done > 0) {
      const prog = element('div', 'lt-ov-progress');
      const bar = element('span', 'lt-ov-bar');
      const fill = element('span', 'lt-ov-fill');
      fill.style.width = `${Math.round(done * 1000) / 10}%`;
      bar.appendChild(fill);
      prog.appendChild(bar);
      prog.appendChild(element('span', 'lt-ov-until', `until ${clockLabel(p.stopMs)}`));
      panel.appendChild(prog);
    }
    const chips = element('div', 'lt-ov-chips');
    chips.appendChild(element('span', 'lt-ov-chip', `${live.index + 1}/${live.channels.length} · ${live.row}`));
    chips.appendChild(element('span', 'lt-ov-chip', PICTURE_LABEL[pictureMode()]));
    chips.appendChild(element('span', 'lt-ov-hint', '▲▼ channel · OK pause · MENU (M) picture'));
    panel.appendChild(chips);
    overlay.appendChild(panel);
    if (note) overlay.appendChild(element('p', 'lt-ov-note', note));
  }

  /** On start, on a channel change and on OK; gone after 5 s unless paused. */
  function showOverlay(note) {
    const overlay = ensureOverlay();
    if (!overlay) return;
    paintOverlay(note);
    overlay.hidden = false;
    clearTimeout(live.overlayTimer);
    live.overlayTimer = setTimeout(() => {
      const video = videoNode();
      if (video && video.paused && video.readyState >= 2) return;
      overlay.hidden = true;
    }, OVERLAY_MS);
  }

  /** §2.14.9: the programme line is re-read at the programme's stop. */
  function scheduleStopReread() {
    clearTimeout(live.stopTimer);
    const p = live.programme;
    if (!p || !p.stopMs) return;
    const ch = live.channels[live.index];
    const gen = live.gen;
    const wait = Math.max(2000, p.stopMs - Date.now() + 2000);
    live.stopTimer = setTimeout(async () => {
      if (!live.active || gen !== live.gen || !ch) return;
      const fresh = await fetchNow([ch.id]);
      if (!live.active || gen !== live.gen) return;
      live.programme = (fresh && fresh[ch.id]) || (ch.next ? { title: ch.next.title, startMs: ch.next.startMs, stopMs: 0 } : null);
      const overlay = byId('livetv-overlay');
      if (overlay && !overlay.hidden) paintOverlay('');
      scheduleStopReread();
    }, Math.min(wait, 2147483000));
  }

  function pictureMode() {
    const stored = readStore(PICTURE_STORE, 'fit');
    return PICTURE_MODES.includes(stored) ? stored : 'fit';
  }

  function applyPicture() {
    const video = videoNode();
    if (video) video.style.objectFit = PICTURE_FIT[pictureMode()];
  }

  /** UP/DOWN: the previous / next channel in the row, wrapping, skipping anything the cap refuses. */
  function stepChannel(delta) {
    const count = live.channels.length;
    let next = live.index;
    for (let i = 0; i < count; i += 1) {
      next = wrap(next, delta, count);
      if (next === null) return;
      if (groupAllowed(state.cap, live.channels[next].group)) break;
    }
    if (next === live.index || next === null) { showOverlay(''); return; }
    tune(next, false);
  }

  function onPlayerKey(event) {
    const player = playerNode();
    if (!live.active || !player || player.hidden) return;
    const key = keyOf(event);
    if (!key || key === 'back') return; // app.js closes the player on Back
    const focused = document.activeElement;
    if (key === 'ok' && focused && focused.closest && focused.closest('.player-bar')) return;
    if (key === 'up' || key === 'down') { consume(event); stepChannel(key === 'up' ? -1 : 1); return; }
    if (key === 'ok') {
      consume(event);
      if (event.repeat) return;
      const status = window.BlazingPlayer && window.BlazingPlayer.status ? window.BlazingPlayer.status() : null;
      if (status && window.BlazingPlayer.setPaused) window.BlazingPlayer.setPaused(!status.paused);
      setTimeout(() => showOverlay(''), 60);
      return;
    }
    if (key === 'menu') {
      consume(event);
      writeStore(PICTURE_STORE, nextPicture(pictureMode()));
      applyPicture();
      showOverlay('');
      return;
    }
    if (key === 'left' || key === 'right') {
      // Feeds: the web is handed ONE stream per ticket (/live/ticket picks the
      // first candidate). Choosing another needs a fleet change — see the
      // BLZ-0113 report. Until then LEFT/RIGHT just bring the overlay up.
      consume(event);
      showOverlay('');
    }
  }

  /* ══════════════════════════════════════════════════════════════════════════
     WIRING, PROFILE, MOUNT
     ══════════════════════════════════════════════════════════════════════════ */

  function measureTop() {
    const { view } = refs();
    if (!view) return;
    const bar = document.querySelector('.topbar');
    const r = bar && bar.offsetParent !== null ? bar.getBoundingClientRect() : null;
    const top = r && r.bottom > 0 ? Math.round(r.bottom + 12) : 12;
    view.style.setProperty('--lt-top', `${top}px`);
  }

  function wire() {
    if (state.wired) return;
    const { view, rail, pane } = refs();
    if (!view || !pane) return;
    state.wired = true;
    buildRail();
    view.addEventListener('keydown', onViewKey);
    view.addEventListener('keyup', onViewKeyUp);
    pane.addEventListener('click', onPaneClick);
    pane.addEventListener('contextmenu', onPaneContextMenu);
    pane.addEventListener('focusin', (event) => {
      state.lastContent = event.target;
      pane.classList.add('lt-engaged');
      for (const hot of pane.querySelectorAll('.lt-hot')) hot.classList.remove('lt-hot');
      const row = event.target.closest('.lt-track, .lt-grid, .lt-scores, .lt-sched-plate, .lt-crests, .lt-chips');
      if (row) row.classList.add('lt-hot');
      if (event.target.classList.contains('lt-gcell')) paintGuideDetails(event.target);
    });
    pane.addEventListener('focusout', (event) => {
      if (!event.relatedTarget || !pane.contains(event.relatedTarget)) {
        pane.classList.remove('lt-engaged');
        for (const hot of pane.querySelectorAll('.lt-hot')) hot.classList.remove('lt-hot');
      }
    });
    if (rail) {
      rail.addEventListener('focusin', () => rail.classList.add('is-open'));
      rail.addEventListener('focusout', (event) => {
        if (!event.relatedTarget || !rail.contains(event.relatedTarget)) rail.classList.remove('is-open');
      });
    }
    window.addEventListener('resize', measureTop);
  }

  /**
   * A SWITCH MUST RE-FILTER WHAT IS ALREADY ON SCREEN, not only what loads
   * next (the Roku's BRK-14). The board itself is per DEVICE, so it is kept
   * and re-gated; only what the old profile was looking at goes.
   */
  function adoptProfile(detail) {
    const next = plainText(detail && detail.maxRating).toLowerCase() || null;
    state.cap = next;
    state.viewAll = null;
    state.search = { query: '', results: [], status: '', gen: state.search.gen + 1 };
    state.sportsLeague = '';
    ++state.boardGen;
    rebuild();
    if (!state.mounted) return;
    stopPreview();
    render();
    if (!noProfile()) refreshBoard(true);
  }

  document.addEventListener('blazing-profile-selected', (event) => {
    adoptProfile((event && event.detail) || {});
  });
  document.addEventListener('blazing-profile-signed-out', () => {
    adoptProfile({});
  });

  function mount() {
    wire();
    if (!state.wired) return;
    measureTop();
    if (!state.mounted) {
      state.mounted = true;
      rebuild();
      render();
      scheduleBoard();
      scheduleSports();
      scheduleClock();
    } else {
      rebuild();
      render({ keepFocus: true });
    }
    // §2.14.9: re-read on entering when the copy is older than 60 s.
    refreshBoard(false);
    if (['sports', 'teams', 'favorites'].includes(state.section)) refreshSports(false);
  }

  /* The pure halves, published for the unit tests the way profile.js publishes
     its own rules: a rule left inline is a rule with no test behind it. */
  window.BlazingLiveTv = {
    mount,
    select: (id) => selectSection(id, { land: true }),
    rules: {
      groupAllowed,
      slots: guideSlots,
      positionPx: guidePositionPx,
      nowLine,
      progress: progressOf,
      window: guideWindow,
      isPlaceholder,
      parseRows,
      parseSports,
      normaliseChannel,
      shelves,
      dotFor,
      hexColour,
      wrap,
      followKey,
      involvesFollowed,
      followedFirst,
      leagueChips,
      teamChips,
      cleanName,
      clockLabel,
      timeSpan,
      duration,
      kickoff,
      firstLine,
      secondLine,
      searchBoard,
      everyChannel,
      fallbackRows,
      liveNowCount,
      sportsFromGames,
      guidePage,
      visibleSlots,
      nextPicture,
      GUIDE_MAX_PAGES,
    },
  };
})();
