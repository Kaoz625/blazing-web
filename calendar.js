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
   * "2026-08-23T14:30:00Z" -> "2:30 pm". Empty for anything that is not that
   * shape, which is the safe answer: a missing time prints nothing at all.
   *
   * TWELVE HOUR, with the am/pm said out loud. It used to print "14:30" on the
   * Roku and Markus could not tell what he was looking at: "Are these in
   * military time? Or is this how long each one is? 445, 447. I don't understand
   * these." A bare 24-hour number reads as a duration, which is the other thing
   * a number next to an episode could plausibly mean.
   */
  function clockOf(iso) {
    const value = String(iso || '');
    const at = value.indexOf('T');
    if (at < 0) return '';
    const rest = value.slice(at + 1);
    if (rest.length < 5) return '';
    const hh = Number(rest.slice(0, 2));
    const mm = rest.slice(3, 5);
    if (!Number.isFinite(hh) || !/^\d{2}$/.test(mm)) return '';
    const suffix = hh >= 12 ? 'pm' : 'am';
    const h12 = hh % 12 === 0 ? 12 : hh % 12;
    return `${h12}:${mm} ${suffix}`;
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

  function entryMeta(entry) {
    return {
      id: entry.id,
      type: entry.type,
      name: entry.name,
      poster: entry.poster,
      background: entry.poster,
      description: '',
      releaseInfo: entry.date ? entry.date.slice(0, 4) : '',
      contentRating: '',
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
    for (const day of orderedDays(state.days, today)) {
      const items = filterItems(day.items, state.kind);
      if (!items.length) continue;
      rows.push({ date: day.date, items });
      flat.push(...items);
    }

    /* RATED BEFORE DRAWN, one pass for the whole window rather than one per day
       — the budget in app.js is what stops a 60-day window turning into
       hundreds of lookups, and a per-day call would hand each day a fresh one.
       This is the Roku's one-session rule in AddonTask.doCalendar. */
    const visible = await state.services.visibleMetas(flat.map(entryMeta));
    if (request !== state.request) return;
    state.gate = String(state.services.cap() || '');
    const allowed = new Set(visible.map((meta) => meta.id));

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
      orderedDays, prettyDate, dayLabel, clockOf, entryLine, filterItems,
    },
  };
})();
