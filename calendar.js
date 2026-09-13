/* Blazing web Calendar — what is out, and when, across films, TV, anime and
 * manga.
 *
 * B12. This screen existed on the Roku alone. Markus asked for it there in
 * these words — "I think we should also add a calendar for airing times and
 * schedule runs and release dates for the animes, manga, tv shows, and
 * movies" — and the browser, the Fire Stick and the Apple TV had no counterpart
 * at all, while /calendar has been serving the whole window the entire time.
 *
 * WHAT THIS IS A COPY OF: roku components/screens/CalendarScreen.{xml,brs} and
 * the fetch in components/tasks/AddonTask.brs (doCalendar). The five filters,
 * the day ordering, the day labels, the twelve-hour clock and the two contract
 * rules below are that screen's, not new work.
 *
 * WIRE CONTRACT (fleet.lyreosai.com, blazing-fleet/calendar.js):
 *   GET /calendar?days_back=30&days_ahead=30
 *       -> { window:{from,to,today,daysBack,daysAhead,tz,generatedAt},
 *            kinds, counts, total, notes,
 *            days: [{date,weekday,today,items:[…]}] }
 *       item: {id,tmdb,kind,name,poster,when,date,exactTime,season,episode,
 *              subtitle,source,openable}
 *
 * TWO THINGS THE CONTRACT ASKS FOR, and both are honoured below:
 *   exactTime:false means the source gave a calendar DAY and no clock time —
 *     every TMDB film and TV date is like that — so an hour must never be
 *     printed for one. Inventing "00:00" would be a lie the viewer cannot see
 *     through.
 *   openable:false means there is nothing to open: a manga chapter is a release
 *     note, not a title with a details page. Pressing one says so instead of
 *     opening an empty sheet.
 *
 * ONE REQUEST, FILTERED LOCALLY. The fleet also accepts ?kind=, but it already
 * sent the whole window, so switching between Movies and Anime must not cost
 * another round trip. That is the Roku's onKindChosen, and the reason it says
 * so out loud.
 */
'use strict';

(() => {
  const FLEET = window.BLAZING_FLEET_BASE || 'https://fleet.lyreosai.com';
  const FETCH_TIMEOUT_MS = 25000;
  /* A MONTH EACH WAY. Markus: "then go a month forward and then after a month
     forward a month back." The fleet clamps at 30/60 and answers every day in
     the window, so this is one request either way — the Roku's own numbers. */
  const DAYS_BACK = 30;
  const DAYS_AHEAD = 30;

  /** [label, the kind the fleet knows it by]. '' is everything. */
  const KINDS = Object.freeze([
    ['All', ''],
    ['Movies', 'movie'],
    ['TV Shows', 'series'],
    ['Anime', 'anime'],
    ['Manga', 'manga'],
  ]);

  const MONTHS = Object.freeze(['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']);
  const DAY_MS = 86400000;

  const state = {
    bound: false,
    days: null,       // null = never fetched
    loading: false,
    kind: '',
    request: 0,
    gate: '',         // the cap the rows on screen were filtered against
    services: null,
  };

  const node = (tag, cls, copy) => {
    const out = document.createElement(tag);
    if (cls) out.className = cls;
    if (copy) out.textContent = copy;
    return out;
  };

  const text = (value, limit = 600) =>
    String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, limit);

  const httpsUrl = (value) => {
    try {
      const url = new URL(String(value || ''));
      return url.protocol === 'https:' ? url.href : '';
    } catch {
      return '';
    }
  };

  async function fetchJSON(url) {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      mode: 'cors',
      credentials: 'omit',
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }

  /* ── What a title is RATED, resolved HERE rather than left inside app.js ───
   *
   * THE HOLE THIS CLOSES. app.js's visibleMetas() (app.js:5930) resolves a tier
   * for every meta it is handed, keeps that answer in a LOCAL VARIABLE, and
   * returns the metas it kept without ever writing the tier onto them. This
   * screen used to hand it `contentRating: ''` for every row, so the tier that
   * admitted a card died inside that call — while app.js goes on to re-read
   * meta.contentRating on the SAME card twice more: at openDetail (app.js:3257)
   * and 550ms into a hover or a tab-focus in attachHoverTrailer (app.js:2423 and
   * :2430). ratingAllowed('') is false for exactly one cap, 'general', which is
   * every Kids profile — so under that cap the whole window was drawn, a press
   * answered "This title is not available for this profile." and a hover DELETED
   * the card out of the grid, leaving its caption behind. Resolving the tier here
   * and writing it onto the meta means ONE value admits a card and re-admits it
   * at every later check.
   *
   * ONLY A `tt` ID IS WORTH ASKING ABOUT. Every anime row is `kitsu:` or
   * `anilist:` and every manga row is `mangadex:` (blazing-fleet/calendar.js:491
   * and :628), and no ratings source can classify one. app.js knows that —
   * ratingTierFor() returns '' on its first line for a non-`tt` id (app.js:5907)
   * — but it charges the budget BEFORE it finds out (app.js:5944), and the fleet
   * sorts the timed anime and manga rows to the FRONT of every day
   * (blazing-fleet/calendar.js:709). A default 61-day window is roughly 430 rows
   * against a budget of 150, so the rows that issue no request drank the budget
   * and the recently-released `tt` films at the back of the walk were scored
   * UNKNOWN — which passes under a teen cap. The walk below spends a unit only
   * on an id that costs a request, and spends it once per id: a weekly series is
   * the same id on every airing day. Both rules are the Roku's, from
   * source/lib/RatingApi.brs:96-108, and the first web port dropped both.
   *
   * A SECOND COPY OF THIS LIVES IN roadmaps.js, for the same reason and with the
   * same numbers. app.js's copy cannot be borrowed: window.BlazingCatalogue
   * (app.js:5969) publishes visibleMetas() and not ratingTierFor(), so there is
   * no way to ask app.js what tier it resolved.
   */
  /** The Roku's RatingSessionStart("calendar", 150, 20), rounded to what a
   *  browser should have open at once. app.js:5878 carries the same pair. */
  const RATING_BUDGET = 150;
  const RATING_LOOKUPS = 6;
  /** `${kind}:${id}` -> tier, for the session. A FAILED request is NOT an answer
   *  and is not remembered here: caching it would pin a title to "unknown" for
   *  the rest of the session, the mistake the Roku's calendar task writes down at
   *  AddonTask.brs:438. */
  const TIERS = new Map();

  /** The key a rating answer is filed under, or '' for an id no ratings source
   *  can classify — which is what makes a `kitsu:`/`anilist:`/`mangadex:` row
   *  free. The `split(':')[0]` is for a Stremio episode id (tt0903747:5:14),
   *  which is rated as its series. */
  function ratingKey(entry) {
    const id = String((entry && entry.id) || '').trim();
    if (id.slice(0, 2).toLowerCase() !== 'tt') return '';
    return `${entry.type === 'series' ? 'series' : 'movie'}:${id.split(':')[0]}`;
  }

  /** The keys this pass should ask about: classifiable ids only, once each,
   *  never one already answered, and never more than the budget. */
  function ratingWants(entries, known = TIERS, budget = RATING_BUDGET) {
    const wants = [];
    const seen = new Set();
    for (const entry of entries || []) {
      const key = ratingKey(entry);
      if (!key || seen.has(key) || known.has(key)) continue;
      seen.add(key);
      if (wants.length >= budget) break;
      wants.push(key);
    }
    return wants;
  }

  /** Fill TIERS for everything in `entries` worth asking about. Six at a time,
   *  and a failure leaves the id unknown rather than wrong. */
  async function resolveTiers(entries) {
    const wants = ratingWants(entries);
    let cursor = 0;
    const worker = async () => {
      while (cursor < wants.length) {
        const key = wants[cursor];
        cursor += 1;
        const cut = key.indexOf(':');
        try {
          const data = await fetchJSON(
            `${FLEET}/rating/${key.slice(0, cut)}/${encodeURIComponent(key.slice(cut + 1))}`,
          );
          TIERS.set(key, String((data && data.tier) || '').toLowerCase());
        } catch { /* see TIERS above: not an answer, so not remembered */ }
      }
    };
    await Promise.all(Array.from({ length: Math.min(RATING_LOOKUPS, wants.length) }, worker));
  }

  /**
   * The ids that may be DRAWN, out of the metas app.js's visibleMetas() kept.
   *
   * THE RESIDUAL THIS CLOSES, and it is the last way the two halves can still
   * disagree. TIERS deliberately does not remember a FAILED request (see the
   * note on TIERS above), so a `tt` row whose lookup threw reaches entryMeta()
   * with contentRating '' — and app.js then asks the SAME question again on its
   * own budget (app.js:5943-5947, a separate cache from ours, so a miss here is
   * always a second request there). If OUR request failed and THAT one
   * succeeded, visibleMetas() admits the row on a tier it keeps to itself while
   * the card still carries '' — and ratingAllowed('') is false for exactly one
   * cap, 'general' (app.js:5850). So under a kids cap that single row goes back
   * to being drawn, refusing a press (app.js:3257) and deleting itself 550ms
   * into a hover (app.js:2423) — the whole of finding 2, for one row.
   *
   * So under that cap a row is drawn only if the card can carry the tier that
   * admitted it. Anything else is dropped, which OVER-blocks by at most the
   * rows whose lookup failed while app.js's retry succeeded — a narrow window,
   * and it fails safe rather than drawing a dead control. Under every other cap
   * ratingAllowed('') is true at all three checks, so nothing needs dropping and
   * nothing is dropped.
   *
   * A MISSING CAP IS THE KIDS CAP, not "no cap". app.js:5846 reads
   * `state.profileCap || 'general'`, so cap() answering null — nobody connected
   * — gates exactly like 'general' there. Mirror it here or this guard would be
   * off by one profile state, which is the state a page load starts in.
   */
  function admitted(metas, cap) {
    const list = Array.isArray(metas) ? metas : [];
    if (String(cap || 'general').toLowerCase() !== 'general') return list.slice();
    return list.filter((meta) => meta && meta.contentRating);
  }

  // ── the rules, all pure so calendar.test.mjs can hold them ────────────────

  function normaliseEntry(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const id = text(raw.id, 120);
    const name = text(raw.name, 300);
    if (!id || !name) return null;
    const kind = text(raw.kind, 20).toLowerCase();
    return {
      id,
      name,
      kind,
      /* The detail sheet only knows two types. An anime is a series and so is a
         manga row, which is why `openable` rather than `kind` decides whether
         anything opens at all. */
      type: kind === 'series' || kind === 'anime' || kind === 'manga' ? 'series' : 'movie',
      poster: httpsUrl(raw.poster),
      when: text(raw.when, 40),
      date: text(raw.date, 20),
      exactTime: raw.exactTime === true,
      subtitle: text(raw.subtitle, 200),
      openable: raw.openable === true,
    };
  }

  function normaliseDays(raw) {
    return (Array.isArray(raw) ? raw : []).map((day) => {
      if (!day || typeof day !== 'object') return null;
      const date = text(day.date, 20);
      if (!date) return null;
      return {
        date,
        weekday: text(day.weekday, 20),
        items: (Array.isArray(day.items) ? day.items : []).map(normaliseEntry).filter(Boolean),
      };
    }).filter(Boolean);
  }

  /** "2026-08-23T14:35:00Z" -> "2026-08-23". '' for anything else. */
  function isoDayOf(iso) {
    const day = String(iso || '').split('T')[0];
    return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : '';
  }

  function todayIso(now = new Date()) {
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  /** Day arithmetic on an ISO date, through epoch milliseconds — the only way
   *  to get month ends and leap years right without writing a calendar. */
  function shiftIso(iso, days) {
    const day = isoDayOf(iso);
    if (!day) return '';
    const at = new Date(`${day}T12:00:00Z`);
    if (Number.isNaN(at.getTime())) return '';
    return new Date(at.getTime() + days * DAY_MS).toISOString().slice(0, 10);
  }

  /**
   * THE ORDER MARKUS ASKED FOR, in his words: "have today first, then tomorrow,
   * then yesterday, then go a month forward, and then after a month forward, a
   * month back. That way we have — I like that setup better."
   *
   * So: today, tomorrow, yesterday, then the rest of the future ascending, then
   * the rest of the past going backwards, nearest first. The fleet answers in
   * plain date order, which opens the screen on a week of history.
   */
  function orderedDays(days, today) {
    const tomorrow = shiftIso(today, 1);
    const yesterday = shiftIso(today, -1);
    const head = [];
    const future = [];
    const past = [];
    for (const day of days || []) {
      if (day.date === today || day.date === tomorrow || day.date === yesterday) head.push(day);
      else if (day.date > today) future.push(day);
      else past.push(day);
    }
    const out = [];
    for (const want of [today, tomorrow, yesterday]) {
      for (const day of head) if (day.date === want) out.push(day);
    }
    /* The fleet already sends ascending dates, so the future needs no sorting
       and the past only needs reversing. */
    out.push(...future);
    for (let i = past.length - 1; i >= 0; i -= 1) out.push(past[i]);
    return out;
  }

  /** "2026-08-23" -> "23 Aug", the same day-then-month order the Roku says. */
  function prettyDate(iso) {
    const parts = String(iso || '').split('-');
    if (parts.length < 3) return String(iso || '');
    const month = Number(parts[1]) - 1;
    if (!(month >= 0 && month <= 11)) return String(iso);
    return `${Number(parts[2])} ${MONTHS[month]}`;
  }

  /** Dates the way a person says them. */
  function dayLabel(date, today) {
    if (!date) return 'Scheduled';
    if (date === today) return 'Today';
    if (date === shiftIso(today, 1)) return 'Tomorrow';
    if (date === shiftIso(today, -1)) return 'Yesterday';
    return prettyDate(date);
  }

  /**
   * "2026-08-23T14:30:00Z" -> that instant on the VIEWER'S clock: "10:30 am" in
   * New York, "11:30 pm" in Tokyo. Empty for anything that is not a full
   * timestamp, which is the safe answer: a missing time prints nothing at all.
   *
   * THE VIEWER'S ZONE, NOT THE WIRE'S. This used to slice characters 11-16 out
   * of the string and print them, which prints a UTC hour to everybody on earth.
   * `when` is always `new Date(...).toISOString()` upstream
   * (blazing-fleet/calendar.js:495 and :631) and the window says so in its own
   * response — `tz: 'UTC'`, with the note "Days are bucketed in UTC. Re-bucket
   * from each item's `when` if you need local days." Neither half of that note
   * was honoured: an anime airing at 14:30Z printed "2:30 pm" for a New York
   * viewer whose real airing was 10:30 am, four hours out in summer and five in
   * winter, under a day name that WAS read locally — the two halves of one card
   * in two different time frames. localDays() below is the note's other half.
   * The Roku has the same defect at CalendarScreen.brs:205; this is the one
   * client that can fix it.
   *
   * TWELVE HOUR, with the am/pm said out loud. It used to print "14:30" on the
   * Roku and Markus could not tell what he was looking at: "Are these in
   * military time? Or is this how long each one is? 445, 447. I don't understand
   * these." A bare 24-hour number reads as a duration, which is the other thing
   * a number next to an episode could plausibly mean.
   */
  function clockOf(iso) {
    const value = String(iso || '');
    /* The T is still the gate and it is load-bearing: `new Date('2026-08-23')`
       parses as UTC midnight, so without it a date that never had an hour would
       start printing one — the "00:00 would be a lie" rule at the top of this
       file, broken from the other end. */
    if (value.indexOf('T') < 0) return '';
    const at = new Date(value);
    if (Number.isNaN(at.getTime())) return '';
    const hh = at.getHours();
    const mm = String(at.getMinutes()).padStart(2, '0');
    const suffix = hh >= 12 ? 'pm' : 'am';
    const h12 = hh % 12 === 0 ? 12 : hh % 12;
    return `${h12}:${mm} ${suffix}`;
  }

  /** The viewer's calendar day for an instant on the wire, '' for anything that
   *  is not one. It is todayIso() of that instant on purpose: the two have to be
   *  the same local read or dayLabel() is comparing different frames again. */
  function localDayOf(iso) {
    const value = String(iso || '');
    if (value.indexOf('T') < 0) return '';
    const at = new Date(value);
    if (Number.isNaN(at.getTime())) return '';
    return todayIso(at);
  }

  /**
   * The fleet's UTC day buckets, re-bucketed into the viewer's days — the other
   * half of the contract note quoted on clockOf above.
   *
   * ONLY A ROW WITH A REAL CLOCK MOVES. `exactTime:true` is anime and manga and
   * nothing else (blazing-fleet/calendar.js:499 and :633), and those are the only
   * rows that carry an instant. A film or a season carries a release DATE with
   * `exactTime:false`, and its `when` is that date at midnight UTC — converting
   * one would drag every release in the western hemisphere back a day, which is
   * the wrong answer to a right-looking question. Without this, an airing at
   * 2026-08-24T01:00:00Z sat in the UTC 24th, was labelled "Tomorrow" from the
   * local date, and read "9:00 pm" on the 23rd underneath.
   *
   * A day the move empties stays empty and render() drops it; a local day the
   * window never had is created, which is what the far edge of a 61-day window
   * needs when a 23:30 airing belongs to tomorrow's UTC bucket.
   */
  function localDays(days) {
    const byDate = new Map();
    const bucket = (date, weekday) => {
      let day = byDate.get(date);
      if (!day) {
        day = { date, weekday: weekday || '', items: [] };
        byDate.set(date, day);
      }
      return day;
    };
    for (const day of days || []) bucket(day.date, day.weekday);
    for (const day of days || []) {
      for (const entry of day.items) {
        const local = entry.exactTime ? localDayOf(entry.when) : '';
        bucket(local || day.date, local ? '' : day.weekday).items.push(entry);
      }
    }
    const out = [...byDate.values()];
    /* Ascending, because orderedDays() splits future from past and then leans on
       the fleet's own ascending order for the forward half — a day created here
       would otherwise sit wherever the Map happened to put it. */
    out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    /* And the fleet's one ordering rule INSIDE a day survives the move: the
       timed rows come first (blazing-fleet/calendar.js:709). Array.prototype.sort
       is stable, so everything else keeps the order it arrived in. */
    for (const day of out) {
      day.items.sort((a, b) => (a.exactTime === b.exactTime ? 0 : (a.exactTime ? -1 : 1)));
    }
    return out;
  }

  /** The second line under a card: the episode, and the time only when there
   *  IS one. */
  function entryLine(entry) {
    const bits = [];
    if (entry.subtitle) bits.push(entry.subtitle);
    if (entry.exactTime) {
      const clock = clockOf(entry.when);
      if (clock) bits.push(clock);
    }
    return bits.join('   ·   ');
  }

  /** One day's items after the kind filter. '' keeps everything. */
  function filterItems(items, kind) {
    if (!kind) return (items || []).slice();
    return (items || []).filter((entry) => entry.kind === kind);
  }

  // ── the screen ────────────────────────────────────────────────────────────

  function refs() {
    return {
      tabs: document.getElementById('calendar-tabs'),
      status: document.getElementById('calendar-status'),
      retry: document.getElementById('calendar-retry'),
      host: document.getElementById('calendar-days'),
    };
  }

  /** The shape app.js's buildCard() and openDetail() want.
   *
   * contentRating is the tier resolveTiers() found, NOT '' — see the block at
   * the top of this file. entryCard() builds a fresh meta for every card and
   * render() builds another set for the gate, so the tier has to come from
   * TIERS rather than from whichever object survived the last call.
   *
   * `tiers` is an argument only so calendar.test.mjs can hand in a map without a
   * network; production always takes the default. Note the call sites pass one
   * entry each rather than using `.map(entryMeta)`, which would hand the array
   * index in as the map. */
  function entryMeta(entry, tiers = TIERS) {
    return {
      id: entry.id,
      type: entry.type,
      name: entry.name,
      poster: entry.poster,
      background: entry.poster,
      description: '',
      releaseInfo: entry.date ? entry.date.slice(0, 4) : '',
      contentRating: tiers.get(ratingKey(entry)) || '',
    };
  }

  function entryCard(entry) {
    const wrap = node('div', 'calendar-entry');
    /* A manga chapter has no details page to open. Say so rather than opening a
       sheet that would have nothing on it — the sentence is the Roku's own, out
       of onCalendarAction in components/MainScene.brs. */
    const card = entry.openable
      ? state.services.buildCard(entryMeta(entry))
      : state.services.buildCard(entryMeta(entry), () => {
        state.services.showToast(`${entry.name} — released, nothing to open here.`);
      });
    if (!entry.openable) card.classList.add('calendar-unopenable');
    wrap.append(card);
    const line = entryLine(entry);
    if (line) wrap.append(node('span', 'calendar-entry-meta', line));
    return wrap;
  }

  /**
   * ONE FETCH, and it carries no request token on purpose. `state.loading` is
   * what stops a second one, and the answer is the same 61-day window whoever
   * asked for it — so a filter pressed while this is in flight must NOT be
   * allowed to make the arriving window look stale and throw it away. render()
   * carries the token instead, because that is the call a filter really races.
   */
  async function loadDays() {
    const { status, retry, host } = refs();
    if (!host || state.loading) return;
    state.loading = true;
    status.textContent = 'Loading…';
    retry.hidden = true;
    host.replaceChildren();

    let data = null;
    try {
      data = await fetchJSON(`${FLEET}/calendar?days_back=${DAYS_BACK}&days_ahead=${DAYS_AHEAD}`);
    } catch {
      state.loading = false;
      status.textContent = 'Could not reach the calendar.';
      retry.hidden = false;
      return;
    }
    state.loading = false;
    state.days = normaliseDays(data && data.days);
    await render();
  }

  async function render() {
    const { status, retry, host } = refs();
    if (!host || state.days === null) return;
    const request = ++state.request;
    retry.hidden = true;

    const today = todayIso();
    const rows = [];
    const flat = [];
    for (const day of orderedDays(localDays(state.days), today)) {
      const items = filterItems(day.items, state.kind);
      if (!items.length) continue;
      rows.push({ date: day.date, items });
      flat.push(...items);
    }

    /* RATED BEFORE DRAWN, one pass for the whole window rather than one per day
       — the budget above is what stops a 61-day window turning into hundreds of
       lookups, and a per-day call would hand each day a fresh one. This is the
       Roku's one-session rule in AddonTask.doCalendar. resolveTiers() goes FIRST
       so visibleMetas() judges each row on the tier the card will carry, rather
       than on an answer it resolves and then keeps to itself. */
    await resolveTiers(flat);
    if (request !== state.request) return;
    const visible = await state.services.visibleMetas(flat.map((entry) => entryMeta(entry)));
    if (request !== state.request) return;
    state.gate = String(state.services.cap() || '');
    /* Not `visible` straight into the Set — see admitted() above for the one
       row a kids cap can still be handed dead. */
    const allowed = new Set(admitted(visible, state.gate).map((meta) => meta.id));

    const sections = [];
    let total = 0;
    for (const row of rows) {
      const items = row.items.filter((entry) => allowed.has(entry.id));
      if (!items.length) continue;   // a day the cap emptied is dropped, not drawn as a bare date
      total += items.length;
      const section = node('section', 'result-row');
      section.append(node('h2', 'row-title', dayLabel(row.date, today)));
      const grid = node('div', 'search-results');
      grid.append(...items.map(entryCard));
      section.append(grid);
      sections.push(section);
    }

    host.replaceChildren(...sections);
    if (!total) {
      status.textContent = 'Nothing scheduled in this window.';
      return;
    }
    status.textContent = `${total} in the next few weeks`;
  }

  function renderTabs() {
    const { tabs } = refs();
    if (!tabs) return;
    for (const button of tabs.querySelectorAll('[data-calendar-kind]')) {
      button.setAttribute('aria-selected', String((button.dataset.calendarKind || '') === state.kind));
    }
  }

  function bindOnce() {
    if (state.bound) return;
    state.bound = true;
    const { tabs, retry } = refs();
    if (tabs) {
      tabs.addEventListener('click', (event) => {
        const button = event.target.closest('[data-calendar-kind]');
        if (!button) return;
        const kind = button.dataset.calendarKind || '';
        if (kind === state.kind) return;
        state.kind = kind;
        renderTabs();
        render();
      });
    }
    if (retry) retry.addEventListener('click', () => { state.days = null; loadDays(); });
  }

  /**
   * Mounted on EVERY visit, not once: the cap can change under this screen and
   * a window built once would keep whatever it was filtered against. The FETCH
   * happens once — the fleet already sent a whole 61-day window.
   */
  function mount() {
    /* Pulled at mount, not pushed at load — index.html runs app.js before this
       file, so there is nothing to push to when app.js executes. */
    state.services = window.BlazingCatalogue;
    if (!state.services) return;
    bindOnce();
    renderTabs();
    if (state.days === null) {
      if (!state.loading) loadDays();
    } else if (state.gate !== String(state.services.cap() || '')) {
      render();
    }
  }

  window.BlazingCalendar = {
    mount,
    /** The pure rules, for calendar.test.mjs. */
    rules: {
      KINDS, normaliseEntry, normaliseDays, isoDayOf, todayIso, shiftIso,
      orderedDays, prettyDate, dayLabel, clockOf, localDayOf, localDays,
      entryLine, filterItems, ratingKey, ratingWants, entryMeta, admitted,
    },
  };
})();
