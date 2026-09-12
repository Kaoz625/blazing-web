/* Blazing web Live TV — the fleet's 38,000-channel live index, in a browser.
 *
 * This is one of the three canonical destinations DESIGN.md line 74 names that
 * this client had no view for at all. The Roku has shipped
 * source/lib/LiveTV.brs + components/screens/LiveTvScreen.brs for weeks against
 * the very same routes; read those for the on-device behaviour this mirrors.
 *
 * WIRE CONTRACT (fleet.lyreosai.com, blazing-fleet repo). Every /live/* read is
 * device-authenticated: without a deviceId the server answers with the public
 * subset only, and /live/stream/<id> comes back {"streams":[]} — measured, not
 * assumed, on 6 Sep 2026.
 *
 *   GET /live/groups
 *       -> { groups: [{ id, name, count }] }
 *       Measured live: general 30676, sports 4416, entertainment 1827,
 *       movies 1385, news 1063, music 1019, documentary 528, kids 427.
 *   GET /live/channels?healthy=1&limit=&skip=[&group=][&q=]
 *       -> { total, channels: [{ id, name, logo, group, country,
 *                                categories[], streamCount, hasGuide }] }
 *       `total` respects the filter, so it is the honest count for the header.
 *   GET /live/stream/<id>
 *       -> { streams: [{ url, format, label, quality, height, codec, audio }] }
 *       JSON, NOT media. Handing this URL straight to a <video> is the exact
 *       mistake LiveTV.brs:160 records making — resolve first, play the url.
 *   GET /live/now?channels=a,b,c        (B33, max 100 ids)
 *       -> { now: { "<id>": { title, category, start, stop } | null } }
 *       Measured on a full 100-id batch: 100 keys, 3 of them non-null. EPG
 *       coverage on the public list is 202 of 9,910 channels — one free source
 *       — so most cards never get a line and every part of this stays silent
 *       and cheap when that happens.
 *   GET /live/guide?channels=a,b,c&from=&to=   (B23, same 100-id cap)
 *       -> { guide: { "<id>": [{ title, start, stop, desc, category }] } }
 *   GET /live/channels?withGuide=1
 *       The guided subset, a couple of hundred rows rather than 38,899. It is
 *       what keeps the grid guide's walk to three pages.
 *
 * THE PARENTAL CAP (B24). A live channel carries NO certification, so
 * app.js ratingAllowed() has nothing to decide on and would wave all 38,899
 * through. Live TV is therefore gated by GROUP NAME — see groupAllowed(), which
 * is the clause-for-clause port of Roku LiveTV.brs:666 and Fire TV
 * ProfileGateRules.kt:203. Three locks: the group chips, the page filter, and
 * the press. A null cap is a NO at all three.
 *
 * WHY THIS SCREEN IS SEARCH-FIRST, and the Roku is not.
 *
 * Browsing from skip=0 is nearly worthless here. One page of 500 measured
 * 470 placeholder rows to 30 real ones — endless "- NO EVENT STREAMING - | 8K
 * EXCLUSIVE | BR: DISNEY+ PPV 101" entries and "##### CBS ALABAMA #####"
 * separator lines that are section headings in someone's playlist, not
 * channels. A grid that opens on those reads as a broken app. Search asks the
 * SERVER (q=), so it reaches the whole 38,899-row index rather than whatever
 * happened to page in: q=cnn -> 38, q=bbc -> 248, q=cbs -> 555.
 *
 * The Roku pages 8000 channels into memory because a television has no
 * keyboard and its viewer is browsing; LiveTV.brs:100 calls that ceiling a
 * MEMORY ceiling and says out loud that it reaches about a fifth of the index.
 * A browser has a keyboard and no such ceiling, so it does the opposite: it
 * asks for exactly the page it is showing. Same routes, same data, and the
 * shape each device is actually good at.
 *
 * DEAD ROWS ARE HIDDEN, NEVER COUNTED AWAY. isPlaceholder() drops the
 * decoration-only names; the header still reports the server's own `total`, so
 * nobody is told "12 channels" about an index with thousands. Under-reporting a
 * catalogue is how a viewer goes looking for a bug that is not there — the same
 * reasoning LiveTvSnapshot carries the server total up to the Roku status line.
 */
'use strict';

(() => {
  const FLEET_BASE = window.BLAZING_FLEET_BASE || 'https://fleet.lyreosai.com';
  const DEVICE_STORAGE_KEY = 'blazing-web-profile-device-v1';
  // 12s, matching LiveTvFleetPage's deliberate choice of 12 over 20: this
  // screen is interactive the whole time, so a stuck page has to give up
  // quickly rather than hold a list the viewer is already reading.
  const FETCH_TIMEOUT_MS = 12000;
  const PAGE_SIZE = 60;
  // 8 pages = 480 rows per press. Sized from the real index: one 500-row
  // sample measured 470 decoration rows to 30 real ones, so a single 60-row
  // page can very easily hold nothing worth drawing, and eight of them almost
  // never do. It is a bound, not a target — the sweep stops the moment a page
  // yields a real channel.
  const MAX_SWEEP = 8;

  /* ── B33 / B24 / B23 constants ───────────────────────────────────────────
   * Every number below is the one another client already ships, not a new
   * choice. tvOS Sources/LiveGuide.swift for the now/next store, Fire TV
   * GuideActivity.kt for the grid, and firetv ProfileGateRules.kt:203-208 for
   * the cap. Where a number differs it says so and says why. */

  // Half the server's cap of 100 ids per /live/now, exactly as the Roku and
  // tvOS set it: being half means a later change to how a block is assembled
  // cannot quietly cross the ceiling. Measured 25 Aug: 101 ids answers
  // {"error":"too many channels (max 100)","got":101}.
  const GUIDE_BATCH = 50;
  const GUIDE_MAX_CHANNELS = 100;
  // Ten minutes. Programmes start on :00 and :30, so the worst case is a "now"
  // line ten minutes stale — and the bar is recomputed from start/stop on
  // every repaint, so it keeps creeping forward inside that window.
  const GUIDE_TTL_MS = 600000;
  // A viewer holding the scrollbar can outrun the network. Blocks at the back
  // are off screen by the time they would be answered, so they are dropped.
  const GUIDE_QUEUE_MAX = 3;
  // The bar is recomputed, never stored. 30s is finer than the 4px bar can
  // show on a 30-minute programme and costs one pass over the visible cards.
  const PROGRESS_TICK_MS = 30000;

  // The kids cap. One name, shared by server/profiles.js, ProfileClient.kt,
  // Profiles.brs and app.js's own RATINGS ladder: 'general' IS the kids case
  // and nothing else is.
  const KIDS_CAP = 'general';

  /* The EPG grid, in Fire TV's numbers (GuideActivity.kt companion object). */
  const PX_PER_MIN = 8;
  const HALF_HOUR_MIN = 30;
  const WINDOW_MINUTES = 180;
  const MIN_BLOCK_MINUTES = 15;
  const TIMELINE_WIDTH = WINDOW_MINUTES * PX_PER_MIN;
  const GUIDE_PAGE_SIZE = 100;
  // Fire TV allows 100 page requests here. It can: it asks with withGuide=1 and
  // the guided catalogue is 232 rows, so the walk stops on page three every
  // time. The bound is only a runaway stop, and a browser tab that the viewer
  // is looking at must give up sooner than a set-top box — the same reasoning
  // FETCH_TIMEOUT_MS already gives for choosing 12s over the Roku's 20s.
  const GUIDE_MAX_PAGES = 12;
  // ESPN 3 and ESPN 4 carry streams with no XMLTV, so a guide-only catalogue
  // has no ESPN row at all. One small exact brand query; the four guided ESPN
  // channels dedupe by id. Straight from GuideActivity.kt:296-306.
  const GUIDE_ESPN_QUERY = 'ESPN';
  const GUIDE_ESPN_LIMIT = 20;

  const state = {
    mounted: false,
    wired: false,
    channels: [],
    total: 0,
    skip: 0,
    group: '',
    groups: [],
    query: '',
    loading: false,
    generation: 0,
    /**
     * The connected profile's rating cap, or null when nobody has connected
     * one. NULL IS A NO — see groupAllowed(). Carried the way manga.js carries
     * its own copy: from the blazing-profile-selected broadcast alone, never
     * from localStorage, so a remembered session the fleet has since disabled
     * cannot put a cap back that the owner took away.
     */
    cap: null,
    /** 'channels' or 'guide'. */
    panel: 'channels',
    guideLoading: false,
    guideLoaded: false,
    guideGeneration: 0,
    guideRows: 0,
    /** The three-hour window the grid on screen was built for, or null. */
    guideSpan: null,
  };

  function element(tag, className) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    return node;
  }

  function plainText(value, fallback = '') {
    if (typeof value !== 'string') return fallback;
    const trimmed = value.trim();
    return trimmed || fallback;
  }

  /* The page is https, so a http:// logo is blocked outright as mixed content
   * and the card would show a broken image instead of its initial. Most fleet
   * logos ARE http (photo-tmdb.com/stalker_portal/...), so this is the common
   * case, not the edge case. Same rule app.js and games.js already apply. */
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

  /**
   * True for a row that is a playlist separator or a dead PPV placeholder
   * rather than something anybody can watch.
   *
   * Every pattern here was read off the live index, not imagined:
   *   "##### CBS ALABAMA #####"   "--- National CBS Channels---"
   *   "- NO EVENT STREAMING - | 8K EXCLUSIVE | US: NFHS PPV 39"
   * The first two are headings. The third is a placeholder the provider
   * publishes thousands of; it says in its own name that it is not streaming.
   */
  function isPlaceholder(channel) {
    const name = plainText(channel && channel.name);
    if (!name) return true;
    if (/no event streaming/i.test(name)) return true;
    // A name whose letters are only decoration — #, -, =, * and spaces.
    const letters = name.replace(/[^A-Za-z0-9]/g, '');
    if (!letters) return true;
    // A heading wrapped in rules on BOTH sides, e.g. "##### X #####" or
    // "--- X ---". A single leading dash is a real channel name ("- TSN 1").
    if (/^[#\-=*\s]{3,}.*[#\-=*\s]{3,}$/.test(name)) return true;
    return false;
  }

  /* ── B24. The parental cap ───────────────────────────────────────────────
   *
   * A live channel has NO certification to look up. Everywhere else in this app
   * a title is gated by its contentRating through app.js ratingAllowed(); a
   * channel has no IMDb id and nothing behind it, so that function has nothing
   * to decide on and would wave all 38,899 through. That is why Live TV needs
   * its own predicate and why it is gated by GROUP NAME and by nothing else —
   * the same conclusion the Roku reached first (source/lib/LiveTV.brs:660-673)
   * and Fire TV ported clause for clause (ProfileGateRules.kt:203-208).
   *
   * NULL IS A NO. A missing cap is not "everyone", it is "nobody is known to be
   * watching", and this screen builds a player URL directly with no later gate
   * behind it.
   *
   * THE MATCH IS SUBSTRING AND CASE-INSENSITIVE ON PURPOSE. The fleet's group
   * names are upstream strings nobody here controls — "Kids", "kids",
   * "Children", "Kids;Animation" have all been seen, and the Roku's note at
   * LiveTV.brs:617 records about ninety combination groups arriving from one
   * provider. An exact allow-list would drop real kids channels and, worse,
   * would let a combination group through under a name it did not recognise.
   */
  function groupAllowed(cap, group) {
    if (cap === null || cap === undefined) return false;
    const tier = String(cap).toLowerCase();
    if (!tier) return false;
    if (tier !== KIDS_CAP) return true;
    const g = String(group || '').toLowerCase();
    return g.includes('kids') || g.includes('child');
  }

  /** True while a kids profile is watching — the only cap that narrows this screen. */
  function kidsCapped() {
    return String(state.cap || '').toLowerCase() === KIDS_CAP;
  }

  /** True when nobody has connected a profile, so nothing may be drawn at all. */
  function noProfile() {
    return state.cap === null || state.cap === undefined || String(state.cap) === '';
  }

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
   * Every /live/* read, with the device credential attached the way the Roku's
   * FleetAuthQuery() + FleetHeaders() pair does it: the id goes in the query so
   * the server can scope the index, the token goes in a HEADER and never into a
   * URL, so it cannot end up in a log or a referrer.
   */
  async function liveFetch(path, params = {}) {
    const credentials = storedCredentials();
    const url = new URL(`${FLEET_BASE}${path}`);
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
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  }

  function refs() {
    return {
      view: document.getElementById('livetv-view'),
      form: document.getElementById('livetv-search-form'),
      input: document.getElementById('livetv-search-input'),
      groups: document.getElementById('livetv-groups'),
      status: document.getElementById('livetv-status'),
      results: document.getElementById('livetv-results'),
      loadMore: document.getElementById('livetv-load-more'),
      channelsPanel: document.getElementById('livetv-channels-panel'),
      guidePanel: document.getElementById('livetv-guide-panel'),
      guideOpen: document.getElementById('livetv-guide-open'),
      guideClose: document.getElementById('livetv-guide-close'),
      guideStatus: document.getElementById('livetv-guide-status'),
      guideGrid: document.getElementById('livetv-guide-grid'),
    };
  }

  /** Whichever status line the viewer is actually looking at. */
  function statusNode() {
    const { status, guideStatus } = refs();
    return state.panel === 'guide' ? (guideStatus || status) : status;
  }

  function say(text) {
    const node = statusNode();
    if (node) node.textContent = text;
  }

  /* ══════════════════════════════════════════════════════════════════════════
     B33. NOW/NEXT ON THE CARD.
     A port of tvOS Sources/LiveGuide.swift, which is itself the Roku's
     LiveTvScreen.brs discipline in Swift. The five rules it carries, and why
     each one is load-bearing rather than a nicety:

       ALIGNED 50-ID BLOCKS, not a window centred on whatever just scrolled in.
       Scrolling down a row and back up lands inside the same block and asks for
       nothing. A centred window re-asks on every single move.

       AN IN-FLIGHT SET, so a channel is never asked about twice. Ten cards
       crossing the viewport at once all resolve to the same block.

       A TEN-MINUTE TTL. See GUIDE_TTL_MS.

       A QUEUE CAPPED AT THREE, and ONE REQUEST AT A TIME. The guide is a nicety
       on top of a grid that already works, so it never opens several
       connections and competes with the channel paging for the same sockets.

       SKIP hasGuide === false. The server already answered that question when
       it listed the channel, and 9,708 of 9,910 public channels answer it "no".
       Absent means unknown and is still asked; only an explicit false is
       skipped. Measured on a full 100-id batch: 100 keys, 3 of them non-null.
     ══════════════════════════════════════════════════════════════════════════ */

  const guide = {
    /** id -> { title, category, startMs, stopMs }. Only channels that HAVE one. */
    entries: new Map(),
    /** id -> epoch ms of the last ask, answered or not. */
    askedAt: new Map(),
    inFlight: new Set(),
    queue: [],
    busy: false,
  };

  /**
   * The viewer changed group or typed a search. The ANSWERS stay — they are
   * keyed by channel id and a listing does not depend on which chip the channel
   * was found under — but everything queued is about rows that are no longer on
   * screen, so it is dropped and its ids released for a later ask.
   */
  function guideListChanged() {
    for (const ids of guide.queue) for (const id of ids) guide.inFlight.delete(id);
    guide.queue.length = 0;
  }

  function guideReset() {
    guideListChanged();
    guide.entries.clear();
    guide.askedAt.clear();
    guide.inFlight.clear();
    guide.busy = false;
  }

  /** Ask about the block this card stands in, and pull the next one in near its end. */
  function guideAskAround(index) {
    const channels = state.channels;
    if (!channels.length) return;
    const idx = Math.max(0, Number(index) || 0);
    const first = Math.floor(idx / GUIDE_BATCH) * GUIDE_BATCH;
    guideQueueBlock(first);
    // Twelve cards from the edge — a bit over two rows on this grid, far enough
    // ahead that a page-down lands on cards that already have their listings.
    if ((idx - first) >= (GUIDE_BATCH - 12)) guideQueueBlock(first + GUIDE_BATCH);
    guidePump();
  }

  function guideQueueBlock(first) {
    const channels = state.channels;
    if (first < 0 || first >= channels.length) return;
    const last = Math.min(first + GUIDE_BATCH, channels.length);
    const now = Date.now();
    const ids = [];
    for (let i = first; i < last; i += 1) {
      const channel = channels[i];
      const id = plainText(channel && channel.id);
      if (!id) continue;
      if (channel.hasGuide === false) continue;
      if (guide.inFlight.has(id)) continue;
      const at = guide.askedAt.get(id);
      if (at !== undefined && (now - at) < GUIDE_TTL_MS) continue;
      ids.push(id);
    }
    if (!ids.length) return;
    for (const id of ids) guide.inFlight.add(id);
    guide.queue.push(ids);
    while (guide.queue.length > GUIDE_QUEUE_MAX) {
      const stale = guide.queue.shift();
      for (const id of stale) guide.inFlight.delete(id);
    }
  }

  async function guidePump() {
    if (guide.busy || !guide.queue.length) return;
    const ids = guide.queue.shift();
    guide.busy = true;
    // The null is KEPT rather than flattened to an empty map: "the server says
    // these channels are showing nothing" and "the request never arrived" have
    // to be told apart, or one dropped connection blanks fifty good listings.
    const answer = await fetchNow(ids);
    guideAbsorb(answer, ids);
  }

  /**
   * GET /live/now -> { now: { id: programme | null } }.
   * Fire TV's LiveClient.now tolerates a bare { id: programme } body too, so
   * this does; a programme with no title is the same as no programme, which is
   * what tvOS's LiveNowResponse decides for the same reason — the card would
   * otherwise draw an empty line and a bar with nothing beside it.
   */
  async function fetchNow(ids) {
    const wanted = ids.slice(0, GUIDE_MAX_CHANNELS);
    if (!wanted.length) return {};
    const data = await liveFetch('/live/now', { channels: wanted.join(',') });
    if (!data || typeof data !== 'object') return null;
    const map = (data.now && typeof data.now === 'object') ? data.now : data;
    const out = {};
    for (const [id, raw] of Object.entries(map)) {
      const programme = normaliseProgramme(raw);
      if (programme) out[id] = programme;
    }
    return out;
  }

  /** One programme, with its two stamps already in epoch ms. */
  function normaliseProgramme(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const title = plainText(raw.title);
    if (!title) return null;
    return {
      title,
      category: plainText(raw.category),
      startMs: stampMs(raw.start),
      stopMs: stampMs(raw.stop),
    };
  }

  /** "2026-08-25T16:30:00.000Z" -> epoch ms, 0 when it is not a stamp at all. */
  function stampMs(value) {
    const raw = plainText(value);
    if (!raw) return 0;
    const ms = Date.parse(raw);
    return Number.isFinite(ms) ? ms : 0;
  }

  function guideAbsorb(answer, asked) {
    guide.busy = false;
    const now = Date.now();
    for (const [id, programme] of Object.entries(answer || {})) {
      guide.entries.set(id, programme);
      guide.askedAt.set(id, now);
    }
    // Released whatever happened, and stamped as asked EVEN WHEN THE REQUEST
    // FAILED. A network blip must turn into one retry after the TTL, not one
    // retry per scroll.
    for (const id of asked) {
      guide.inFlight.delete(id);
      // Only a real answer may take a listing away. A programme that has ended
      // is dropped here; a failed request leaves the last known listing alone
      // and lets the TTL re-ask for it.
      if (answer && answer[id] === undefined) guide.entries.delete(id);
      if (!guide.askedAt.has(id)) guide.askedAt.set(id, now);
    }
    paintGuideLines();
    guidePump();
  }

  /**
   * "5:30 PM  Premier League Darts" — the line a card draws under its name, in
   * the viewer's own clock, because the guide itself is UTC. Empty for a
   * channel with no listing, and the card then falls back to its country and
   * group exactly as it did before there was a guide at all.
   */
  function nowLine(programme) {
    if (!programme || !programme.title) return '';
    if (!programme.startMs) return programme.title;
    return `${clock(programme.startMs)}  ${programme.title}`;
  }

  /** "5:30 PM" or "17:30", whichever the browser is set to. */
  function clock(ms) {
    try {
      return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    } catch {
      return '';
    }
  }

  /**
   * How far through the current programme we are, 0..1.
   *
   * Recomputed on every repaint rather than stored — the server sends a
   * `progress` too and it is deliberately ignored, because it is correct at the
   * moment of the answer and then frozen while the entry is trusted for ten
   * minutes. Returns 0 — which draws no bar at all — for anything that has not
   * started, has no stop, or has a stop that is not after its start: a guide
   * file with a bad pair of stamps is common enough that it must not produce a
   * full or a negative bar.
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

  /** id -> the card on screen, so one answered batch repaints fifty lines and
   * nothing else. Cleared with the grid. */
  const cards = new Map();
  let cardObserver = null;
  let progressTimer = null;

  function channelCard(channel, index) {
    const name = plainText(channel.name, 'Untitled channel');
    const button = element('button', 'card livetv-card');
    button.type = 'button';
    button.dataset.channelId = plainText(channel.id);
    button.dataset.index = String(index);
    // Carried on the element because the press-time cap has to test THIS card's
    // group, not whichever group chip happens to be lit now.
    button.dataset.group = plainText(channel.group);
    button.setAttribute('aria-label', `Watch ${name}`);

    const art = element('span', 'livetv-card-art');
    const logo = safeHttpsUrl(channel.logo);
    if (logo) {
      const img = element('img');
      img.src = logo;
      img.alt = '';
      img.loading = 'lazy';
      // A dead logo host must not leave a broken-image glyph in the tile.
      img.addEventListener('error', () => { img.remove(); art.textContent = name.slice(0, 2).toUpperCase(); }, { once: true });
      art.appendChild(img);
    } else {
      art.textContent = name.slice(0, 2).toUpperCase();
    }
    button.appendChild(art);

    const label = element('span', 'livetv-card-name');
    label.textContent = name;
    button.appendChild(label);

    /* B33. What is ON, not the word "Guide".
     *
     * This line used to read "News · Guide" — the group, and a literal string
     * saying the server holds listings it never went and asked for. All three
     * televisions put the programme on the card first (Roku LiveTvScreen.brs:
     * 485-522, Fire TV LiveTvActivity.kt:279-280, tvOS LiveView.swift:625-630),
     * so in the browser you picked a channel by logo alone and only found out
     * what was on after tuning it.
     *
     * ONE LINE, ALWAYS, whichever of the two it is, and the bar's height is
     * always taken even when no fill is drawn. Reserving both stops the whole
     * grid jumping under the pointer when a guide answer lands for one card in
     * fifty — tvOS reserves the same two boxes for the same reason. */
    const meta = element('span', 'livetv-card-meta');
    button.appendChild(meta);

    const bar = element('span', 'livetv-card-progress');
    const fill = element('span', 'livetv-card-progress-fill');
    bar.appendChild(fill);
    button.appendChild(bar);

    const entry = { button, meta, fill, channel };
    const id = plainText(channel.id);
    if (id) cards.set(id, entry);
    paintCard(entry);
    if (cardObserver) cardObserver.observe(button);

    return button;
  }

  /** The fallback when the guide knows nothing: country and group, as tvOS. */
  function fallbackLine(channel) {
    const bits = [];
    const country = plainText(channel.country);
    if (country) bits.push(country.toUpperCase());
    const group = plainText(channel.group);
    if (group) bits.push(group.charAt(0).toUpperCase() + group.slice(1));
    return bits.join(' · ');
  }

  function paintCard(entry, moment = Date.now()) {
    const id = plainText(entry.channel.id);
    const programme = id ? guide.entries.get(id) : null;
    const line = nowLine(programme);
    entry.meta.textContent = line || fallbackLine(entry.channel);
    entry.meta.dataset.live = line ? 'true' : 'false';
    const done = progressOf(programme, moment);
    entry.fill.style.width = `${Math.round(done * 1000) / 10}%`;
    const name = plainText(entry.channel.name, 'this channel');
    // The line is on the card but a screen reader reads the button's label, so
    // "what is on" has to be in both or only one of the two viewers gets it.
    entry.button.setAttribute('aria-label', line ? `Watch ${name} — now: ${programme.title}` : `Watch ${name}`);
    // A long programme title still ellipsises on a narrow tile, the same way it
    // does on tvOS and Fire TV. A tooltip is the browser's own way out of that,
    // and the televisions have no pointer to need one.
    entry.button.title = line ? `${name} — ${line}` : name;
  }

  /** One pass over every card on screen. Cheap: it is text and a width. */
  function paintGuideLines() {
    const moment = Date.now();
    for (const entry of cards.values()) paintCard(entry, moment);
  }

  /**
   * The bar is recomputed, never stored, so it has to be poked. Runs only while
   * the Live TV view is on screen — a background tab burning a timer to move a
   * bar nobody is looking at is the definition of waste.
   */
  function startProgressTicker() {
    if (progressTimer) return;
    progressTimer = setInterval(() => {
      const { view } = refs();
      if (!view || view.hidden) return;
      paintGuideLines();
    }, PROGRESS_TICK_MS);
  }

  /**
   * The browser's answer to the Roku's `itemFocused` and tvOS's `.onAppear`:
   * ask about the block a card is standing in only once that card has actually
   * crossed the viewport. A grid of 480 rows that asked on render would spend
   * ten round trips on cards nobody scrolled to.
   */
  function ensureCardObserver() {
    if (cardObserver || typeof IntersectionObserver !== 'function') return;
    cardObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        guideAskAround(Number(entry.target.dataset.index));
      }
    }, { rootMargin: '200px 0px' });
  }

  /** What a blocked viewer is told, in one place because three screens say it. */
  const NO_PROFILE_COPY = 'Live TV needs a connected profile — live channels are private to this household.';
  const KIDS_CAPPED_COPY = 'No kids channels. This profile’s rating limit hides Live TV.';

  function describe() {
    const { status } = refs();
    if (!status) return;
    // B24. NOBODY CONNECTED IS NOT "NO CAP". This screen builds a player URL
    // itself and has no gate behind it, so it fails closed — and it names the
    // real reason rather than reporting an empty index.
    if (noProfile()) {
      status.textContent = NO_PROFILE_COPY;
      return;
    }
    const shown = state.channels.length;
    if (state.loading && !shown) {
      status.textContent = 'Finding channels…';
      return;
    }
    if (!shown) {
      status.textContent = kidsCapped()
        ? KIDS_CAPPED_COPY
        : state.query
          ? `Nothing matched “${state.query}”. Try a channel name — CNN, BBC, CBS.`
          : state.group
            ? `Nothing but placeholder rows in ${state.group}. Try another group, or search by name.`
            // NOT "choose a profile": that branch is handled above now, and
            // saying it here sent a viewer who HAD chosen to go looking for a
            // profile bug that was not there.
            : 'No channels came back. Try a search — CNN, BBC, CBS.';
      return;
    }
    const where = state.query ? ` matching “${state.query}”`
      : state.group ? ` in ${state.group}` : '';
    // UNDER THE KIDS CAP THE SERVER'S TOTAL IS A LIE, so it is not printed.
    // Telling a child's profile it has 38,899 channels while it can see eleven
    // is the kind of small untruth that gets read as a bug — the same recount
    // the Roku makes at LiveTV.brs:683-687 for exactly that reason.
    if (kidsCapped()) {
      // No `where` either: "in kids" after "kids channels" is noise, and the
      // group was chosen by the cap rather than by the viewer.
      status.textContent = state.query
        ? `Showing ${shown} kids channel${shown === 1 ? '' : 's'} matching “${state.query}”.`
        : `Showing ${shown} kids channel${shown === 1 ? '' : 's'}.`;
      return;
    }
    // Otherwise the server's own total, filter included — never the
    // filtered-down count. See the header note: under-reporting the index sends
    // people bug-hunting.
    status.textContent = `Showing ${shown} of ${state.total.toLocaleString()} channels${where}.`;
  }

  function renderGroups(groups) {
    const { groups: host } = refs();
    if (!host) return;
    host.replaceChildren();
    // B24. A BLOCKED CHIP NEVER DRAWS. Filtering groups rather than channels is
    // what makes the cap cheap — one string test per group, before any
    // per-group request — and it is the same shape Fire TV uses at
    // LiveTvActivity.kt:130-135.
    //
    // "All" goes with them under a kids cap: a chip that says All and means
    // "the eleven kids channels" is worse than no chip, and it is also the one
    // chip whose name carries no group to test.
    if (noProfile()) return;
    const permitted = groups.filter((group) => groupAllowed(state.cap, group.name));
    const all = kidsCapped() ? permitted : [{ id: '', name: 'All', count: 0 }, ...permitted];
    if (!all.length) return;
    for (const group of all) {
      const chip = element('button', 'livetv-chip');
      chip.type = 'button';
      chip.dataset.group = group.id;
      chip.textContent = group.count
        ? `${group.name} (${group.count.toLocaleString()})`
        : group.name;
      chip.setAttribute('aria-pressed', String(group.id === state.group));
      chip.addEventListener('click', () => {
        if (state.group === group.id) return;
        state.group = group.id;
        state.query = '';
        const { input } = refs();
        if (input) input.value = '';
        for (const other of host.querySelectorAll('.livetv-chip')) {
          other.setAttribute('aria-pressed', String(other.dataset.group === group.id));
        }
        reload();
      });
      host.appendChild(chip);
    }
  }

  async function loadGroups() {
    const data = await liveFetch('/live/groups');
    const raw = Array.isArray(data && data.groups) ? data.groups : [];
    const groups = raw.map((g) => ({
      id: plainText(g.id),
      name: plainText(g.name, plainText(g.id, 'Group')),
      count: Number(g.count) || 0,
    })).filter((g) => g.id);
    if (!groups.length) return;
    state.groups = groups;
    /* A KIDS PROFILE IS PINNED TO A KIDS GROUP, not left on "All".
     *
     * The per-channel filter below would catch it either way, but only after
     * reading 427 kids rows out of a 41,341-row index one 60-row page at a
     * time — eight sweeps would very often find nothing and paint an empty
     * grid, which is the same blank screen MAX_SWEEP exists to prevent. Asking
     * the server for the group is both correct and one request. It is also what
     * the Roku shows: under the kids cap, Live TV IS the Kids group and nothing
     * else (LiveTV.brs:667-675). */
    if (kidsCapped() && !state.group) {
      const first = groups.find((g) => groupAllowed(state.cap, g.name));
      if (first) state.group = first.id;
    }
    renderGroups(groups);
  }

  /**
   * ONE PRESS KEEPS READING UNTIL IT HAS SOMETHING TO SHOW.
   *
   * A single page was not enough, and this is measured, not theoretical. The
   * live index is 41,341 channels and the top of it is almost entirely
   * decoration — "- NO EVENT STREAMING -", "##### CBS ALABAMA #####",
   * "--- National CBS Channels---". On 6 Sep 2026 the FIRST 60 rows were
   * placeholders to the last one, so isPlaceholder() correctly dropped all 60
   * and Live TV painted an empty grid under the status line "No channels came
   * back." That is what Markus saw as a blank screen: not a failed request —
   * a request that succeeded and whose whole first page was junk.
   *
   * So the cursor sweeps forward until the page yields real rows, the index
   * runs out, or MAX_SWEEP pages have been read. The bound matters: without it
   * a group with nothing but decoration in it would walk all 41,341 rows.
   */
  async function loadPage({ append = false } = {}) {
    const { results, loadMore } = refs();
    /* A SECOND "Load more" IS A DOUBLE-PRESS AND IS IGNORED. A FRESH LOAD IS
     * NOT — IT SUPERSEDES.
     *
     * This was a bare `if (state.loading) return;`, and that one line made the
     * profile switch below a no-op. adoptProfile() awaits /live/groups and then
     * calls reload(); that reload landed while the sweep started under the OLD
     * profile was still running, and was refused. The grid then kept the
     * previous profile's channels until the viewer happened to touch something
     * — the exact "filtered once at fetch time and never again" failure the
     * Roku logged as BRK-14, and the one adoptProfile's own header says must
     * not happen. A sweep is up to eight sequential requests, so being mid-load
     * is the common case on a switch, not a rare one.
     *
     * The generation bump is what makes superseding safe. The older sweep
     * returns at its next checkpoint, before it writes any state, and the newer
     * run owns state.loading from here on — which is also why the checkpoint
     * must NOT clear state.loading on its way out.
     *
     * It also makes the stale-answer guard inside the loop real for the first
     * time: while nothing but loadPage could move the generation, and loadPage
     * refused to re-enter, that check could never fire. */
    if (state.loading && append) return;
    const generation = ++state.generation;
    // B24, the first of three locks. Nobody connected means nothing is drawn
    // and nothing is even asked for.
    if (noProfile()) {
      // Released here too: this branch can now be reached by a load that
      // superseded a sweep still holding the flag, and a flag left set would
      // wedge "Load more" for the rest of the session.
      state.loading = false;
      state.channels = [];
      if (results) results.replaceChildren();
      cards.clear();
      if (loadMore) loadMore.hidden = true;
      describe();
      return;
    }
    state.loading = true;
    if (!append && results) {
      results.replaceChildren();
      cards.clear();
    }
    describe();

    const keep = [];
    let exhausted = false;
    for (let sweep = 0; sweep < MAX_SWEEP; sweep += 1) {
      const data = await liveFetch('/live/channels', {
        healthy: 1,
        limit: PAGE_SIZE,
        skip: state.skip,
        group: state.group,
        q: state.query,
      });
      // A stale answer from a filter — or a PROFILE — the viewer has already
      // moved off must not paint over the one they are looking at. Checked
      // before any state is written, and it leaves state.loading alone on
      // purpose: whoever bumped the generation owns that flag now.
      if (generation !== state.generation) return;

      const rows = Array.isArray(data && data.channels) ? data.channels : [];
      state.total = Number(data && data.total) || 0;
      state.skip += rows.length;
      // THE CAP SITS BESIDE isPlaceholder, not after the loop: a blocked
      // channel never enters `keep`, is never handed to the guide store, and
      // cannot be reached by a later change that reads state.channels for
      // something else. A channel the fleet sent with no group at all is
      // treated as ungrouped and therefore NOT a kids group — unknown fails
      // closed, the same direction as every other rule here.
      keep.push(...rows.filter((c) => !isPlaceholder(c)
        && plainText(c.id)
        && groupAllowed(state.cap, c.group)));
      // `rows.length`, not the kept count: a page that was entirely
      // placeholders still moved the cursor, and there is more behind it.
      if (rows.length < PAGE_SIZE) { exhausted = true; break; }
      if (keep.length) break;
    }
    state.loading = false;
    const base = append ? state.channels.length : 0;
    state.channels = append ? state.channels.concat(keep) : keep;

    if (results) {
      ensureCardObserver();
      const frag = document.createDocumentFragment();
      keep.forEach((channel, offset) => frag.appendChild(channelCard(channel, base + offset)));
      results.appendChild(frag);
    }
    if (loadMore) loadMore.hidden = exhausted;
    describe();
    // The observer only fires for cards that cross the viewport, and on a short
    // result the first screenful may already be laid out by now. Prime the
    // first block so a six-row search still gets its listings.
    guideAskAround(base);
  }

  function reload() {
    state.skip = 0;
    state.channels = [];
    state.total = 0;
    // The ANSWERS stay — a listing is keyed by channel id, not by which chip
    // the channel was found under. Only the queue is dropped.
    guideListChanged();
    loadPage({ append: false });
  }

  /**
   * Tune a channel, through the app's own player.
   *
   * TWO REQUESTS, AND BOTH ARE LOAD-BEARING.
   *
   * /live/ticket is asked FIRST, with the device token in a header, and it
   * hands back a short-lived opaque id. /live/play/<ticket> is what the
   * <video> is then given, and it carries no credential at all. It has to be
   * this way round for two independent reasons, either of which alone leaves a
   * permanently black player:
   *
   *   - The provider's own URL is http (iptv-templates.js:96 defaults an
   *     Xtream host to `http://${host}`) and this page is https, so a browser
   *     refuses it as mixed content BEFORE any request is made. Nothing throws
   *     and nothing appears in the network log. Roku, Fire TV and tvOS have no
   *     such rule and play the raw URL happily, which is exactly why Live TV
   *     worked on four clients and could not exist on this one.
   *   - A <video src> sends no custom headers, and neither does native HLS in
   *     Safari, so the media request cannot carry X-Device-Token however this
   *     file is written. emby.js reached the same answer for the same reason.
   *
   * The 404 body is worth reading rather than collapsing into "cannot play":
   * "no playable stream" means the fleet holds no account for that channel's
   * provider, which is a different sentence from an expired ticket.
   */
  async function play(channelId, name, group) {
    /* B24, THE SECOND LOCK, and it is not redundant.
     *
     * The list filter runs once per loadPage(); this runs on the press. A
     * profile switched while this view sat behind another one leaves the old
     * profile's cards in the grid, and this path builds a player URL directly —
     * there is no later gate to catch it. Exactly the reason Fire TV repeats
     * the same predicate at LiveTvActivity.kt:211-219. */
    if (!groupAllowed(state.cap, group)) {
      say(noProfile() ? NO_PROFILE_COPY : `This profile’s rating limit hides ${name}.`);
      return;
    }
    say(`Tuning ${name}…`);

    const ticket = await liveFetch(`/live/ticket/${encodeURIComponent(channelId)}`);
    if (!ticket || !plainText(ticket.url)) {
      // An anonymous read sees only the public subset, so "nothing to play"
      // and "you are not connected" look identical from here. Name the more
      // likely one rather than telling a signed-out viewer the channel is dead.
      say(storedCredentials() ? `${name} has no playable stream right now.` : NO_PROFILE_COPY);
      return;
    }

    if (!window.BlazingPlayer || typeof window.BlazingPlayer.open !== 'function') {
      say('The player is not ready yet. Try again in a moment.');
      return;
    }
    // The server declares the format. Sniffing this URL cannot work — it ends
    // in a ticket and carries no .m3u8 for looksLikeHls() to find.
    window.BlazingPlayer.open(name, `${FLEET_BASE}${ticket.url}`, {
      streamFormat: plainText(ticket.format).toLowerCase(),
    });
    if (state.panel === 'guide') guideDescribe(); else describe();
  }

  /* ══════════════════════════════════════════════════════════════════════════
     B23. THE GRID GUIDE.

     Until now the browser had the word "Guide" on a channel card and nothing
     behind it, while the Fire Stick has had a real three-hour scrollable grid
     for weeks. This is GuideActivity.kt ported: the same window, the same
     pixels-per-minute, the same gap-filling slot maths, the same ESPN merge and
     the same kids cap.

     WHAT IS DELIBERATELY NOT PORTED is the scroll plumbing. Fire TV runs four
     ScrollViews and synchronises them by hand because Android has no other way
     to pin a column; a browser does — `position: sticky` on the channel names
     and on the time ruler inside ONE scroller. Its own header records that
     per-row scrollers were what made rows jump, overlap and vanish on the
     stick, so copying that machinery here would be copying the bug it was
     written to work around.

     The maths IS ported exactly, and it is pure, so it is reachable from a test
     through window.BlazingLiveTv.rules — the same reason firetv keeps
     GuideTimeline outside its Views. ══════════════════════════════════════════ */

  /** The window: the current half hour, and the three hours from it. */
  function guideWindow(now = Date.now()) {
    const slotMs = HALF_HOUR_MIN * 60000;
    const start = Math.floor(now / slotMs) * slotMs;
    return { start, end: start + WINDOW_MINUTES * 60000 };
  }

  /**
   * One guide row, normalised into contiguous, gap-filled segments clipped to
   * the window. A clause-for-clause port of GuideTimeline.slots.
   *
   * The gap filling is the point. A row with one programme in it must still be
   * three hours wide, or the grid's columns stop lining up with the ruler above
   * them — which is a guide that lies about when things start.
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
      normalised.push({ title: plainText(programme.title, '—'), startMs: start, stopMs: stop });
    }
    normalised.sort((a, b) => a.startMs - b.startMs);

    const out = [];
    let cursor = windowStart;
    for (const slot of normalised) {
      if (slot.startMs > cursor) out.push({ title: 'No guide data', startMs: cursor, stopMs: slot.startMs });
      const visibleStart = Math.max(cursor, slot.startMs);
      if (slot.stopMs > visibleStart) {
        out.push({ title: slot.title, startMs: visibleStart, stopMs: slot.stopMs });
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

  /** GET /live/guide -> { guide: { id: [programme] } }, in 100-id chunks. */
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

  /**
   * Every channel the grid will show, capped, deduped and sorted by name.
   *
   * withGuide=1 is what keeps this bounded — the guided catalogue is a couple
   * of hundred rows out of 38,899. healthy is deliberately OFF, because that
   * filter was also hiding ESPN Deportes: one failed health probe is not a
   * reason to remove a channel from a GUIDE, and playback still says so plainly
   * if every candidate turns out to be dead.
   */
  async function fetchGuideChannels() {
    // Read ONCE, here, and used for every page below. Re-reading the cap per
    // page would let a profile switch landing mid-walk build a grid half under
    // one cap and half under another — GuideActivity.kt:244 says the same.
    const guideCap = state.cap;
    const channels = new Map();
    let skip = 0;
    for (let page = 0; page < GUIDE_MAX_PAGES; page += 1) {
      const data = await liveFetch('/live/channels', {
        skip, limit: GUIDE_PAGE_SIZE, withGuide: 1,
      });
      const rows = Array.isArray(data && data.channels) ? data.channels : [];
      if (!rows.length) break;
      // THE CAP, APPLIED AS THE PAGES ARRIVE. This screen walks the whole index
      // and every block on it is one press from the player, so before B24 it
      // was the widest door in the app.
      for (const row of rows) {
        const id = plainText(row.id);
        if (!id || isPlaceholder(row)) continue;
        if (!groupAllowed(guideCap, row.group)) continue;
        channels.set(id, row);
      }
      const total = Number(data && data.total) || 0;
      const next = skip + rows.length;
      if (next <= skip || (total && next >= total)) break;
      skip = next;
    }

    // ESPN 3 and ESPN 4 carry streams without XMLTV and were therefore absent
    // from a guide-only catalogue. The four guided ESPN channels dedupe by id,
    // leaving only the useful no-EPG rows. THIS IS A SECOND WAY INTO THE MAP
    // and needs the same cap — it is a brand query, so under a kids cap it
    // contributes nothing, which is the point: without the test it would put
    // sports back into a grid the filter above had just emptied.
    const espn = await liveFetch('/live/channels', {
      q: GUIDE_ESPN_QUERY, limit: GUIDE_ESPN_LIMIT,
    });
    for (const row of (Array.isArray(espn && espn.channels) ? espn.channels : [])) {
      const id = plainText(row.id);
      if (!id || isPlaceholder(row)) continue;
      if (!groupAllowed(guideCap, row.group)) continue;
      channels.set(id, row);
    }

    return [...channels.values()].sort((a, b) =>
      plainText(a.name).toLowerCase().localeCompare(plainText(b.name).toLowerCase()));
  }

  function guideDescribe(count) {
    const { guideStatus } = refs();
    if (!guideStatus) return;
    const rows = Number.isFinite(count) ? count : state.guideRows;
    if (noProfile()) { guideStatus.textContent = NO_PROFILE_COPY; return; }
    if (state.guideLoading) { guideStatus.textContent = 'Building the guide…'; return; }
    if (!rows) {
      guideStatus.textContent = kidsCapped()
        ? KIDS_CAPPED_COPY
        : 'No guide data came back. The fleet has listings for a couple of hundred channels.';
      return;
    }
    const { start, end } = state.guideSpan || guideWindow();
    guideStatus.textContent = `${rows.toLocaleString()} channel${rows === 1 ? '' : 's'} · ${clock(start)} to ${clock(end)}.`;
  }

  async function loadGuide() {
    const { guideGrid } = refs();
    if (!guideGrid) return;
    /* THERE IS DELIBERATELY NO `if (state.guideLoading) return` HERE.
     *
     * There was, and it was a hard lock rather than a nicety. adoptProfile()
     * bumps guideGeneration and then calls loadGuide(). With the guard, that
     * call was refused because a build was still in flight; the in-flight build
     * then reached its own checkpoint, saw it had been superseded and returned
     * — WITHOUT releasing state.guideLoading, because the run that superseded
     * it is supposed to own the flag. Nothing ever cleared it again, so the
     * Guide panel read "Building the guide…" for the rest of the session and
     * could never be rebuilt. The walk is up to twelve catalogue pages plus a
     * listings chunk per hundred channels, so it is in flight for seconds.
     *
     * Superseding is also the behaviour we want: the grid is always built for
     * the profile that is connected NOW. The cheap repeat — a viewer pressing
     * Guide and Channels back to back — is held off in showPanel() instead,
     * which is the press, the same split loadPage() draws at `append`. */
    const generation = ++state.guideGeneration;
    state.guideLoading = true;
    state.guideRows = 0;
    guideGrid.replaceChildren();
    guideDescribe(0);

    if (noProfile()) {
      state.guideLoading = false;
      guideDescribe(0);
      return;
    }

    const span = guideWindow();
    state.guideSpan = span;
    // Both checkpoints leave state.guideLoading set on purpose — a superseded
    // build does not own it any more. See the note at the top of this function
    // for what happened when nothing owned it at all.
    const channels = await fetchGuideChannels();
    if (generation !== state.guideGeneration) return;
    const listings = channels.length
      ? await fetchGuide(channels.map((c) => plainText(c.id)), span.start, span.end)
      : new Map();
    if (generation !== state.guideGeneration) return;

    state.guideLoading = false;
    state.guideRows = channels.length;
    state.guideLoaded = true;
    renderGuide(channels, listings, span);
    guideDescribe(channels.length);
  }

  function renderGuide(channels, listings, span) {
    const { guideGrid } = refs();
    if (!guideGrid) return;
    guideGrid.replaceChildren();
    if (!channels.length) return;

    const inner = element('div', 'livetv-guide-inner');
    inner.style.setProperty('--livetv-timeline-width', `${TIMELINE_WIDTH}px`);

    // The ruler. One label per half hour, each exactly as wide as the half hour
    // it names, so a block that starts at 5:30 sits under the 5:30 label.
    const head = element('div', 'livetv-guide-head');
    const corner = element('div', 'livetv-guide-corner');
    corner.textContent = 'Channel';
    head.appendChild(corner);
    const times = element('div', 'livetv-guide-times');
    for (let t = span.start; t < span.end; t += HALF_HOUR_MIN * 60000) {
      const cell = element('span', 'livetv-guide-time');
      cell.style.width = `${HALF_HOUR_MIN * PX_PER_MIN}px`;
      cell.textContent = clock(t);
      times.appendChild(cell);
    }
    head.appendChild(times);
    inner.appendChild(head);

    const body = document.createDocumentFragment();
    for (const channel of channels) {
      const id = plainText(channel.id);
      const row = element('div', 'livetv-guide-row');
      const name = element('div', 'livetv-guide-name');
      name.textContent = plainText(channel.name, id || 'Channel');
      row.appendChild(name);

      const track = element('div', 'livetv-guide-track');
      const slots = guideSlots(listings.get(id) || [], span.start, span.end);
      for (const slot of slots) {
        const startX = guidePositionPx(slot.startMs, span.start);
        const stopX = guidePositionPx(slot.stopMs, span.start);
        const block = element('button', 'livetv-guide-block');
        block.type = 'button';
        block.style.width = `${Math.max(1, stopX - startX)}px`;
        block.textContent = slot.title;
        block.dataset.channelId = id;
        block.dataset.group = plainText(channel.group);
        block.dataset.name = plainText(channel.name, 'This channel');
        if (slot.title === 'No guide data') block.dataset.empty = 'true';
        block.title = `${plainText(channel.name)} · ${clock(slot.startMs)} — ${slot.title}`;
        block.setAttribute('aria-label',
          `${plainText(channel.name)}, ${clock(slot.startMs)}, ${slot.title}. Watch.`);
        track.appendChild(block);
      }
      row.appendChild(track);
      body.appendChild(row);
    }
    inner.appendChild(body);
    guideGrid.appendChild(inner);
  }

  function showPanel(panel) {
    const { channelsPanel, guidePanel, guideOpen, guideClose } = refs();
    state.panel = panel === 'guide' ? 'guide' : 'channels';
    if (channelsPanel) channelsPanel.hidden = state.panel !== 'channels';
    if (guidePanel) guidePanel.hidden = state.panel !== 'guide';
    if (guideOpen) guideOpen.setAttribute('aria-expanded', String(state.panel === 'guide'));
    if (state.panel === 'guide') {
      if (guideClose) guideClose.focus();
      // Rebuilt when it has never been built, and when the window it was built
      // for has rolled on. A guide whose ruler says 5:00 at half past seven is
      // not a stale nicety, it is wrong.
      const span = guideWindow();
      // A build already running for THIS window is left to finish: pressing
      // Guide, Channels, Guide must not start the twelve-page walk three times.
      // A build running for a window that has since rolled on is not — that
      // grid would be drawn against a ruler it no longer matches.
      if (state.guideLoading && state.guideSpan && state.guideSpan.start === span.start) guideDescribe();
      else if (!state.guideLoaded || !state.guideSpan || state.guideSpan.start !== span.start) loadGuide();
      else guideDescribe();
    } else {
      if (guideOpen) guideOpen.focus();
      describe();
    }
  }

  function wire() {
    if (state.wired) return;
    const { form, input, results, loadMore, guideOpen, guideClose, guideGrid } = refs();
    if (!results) return;
    state.wired = true;

    if (guideOpen) guideOpen.addEventListener('click', () => showPanel('guide'));
    if (guideClose) guideClose.addEventListener('click', () => showPanel('channels'));
    if (guideGrid) {
      guideGrid.addEventListener('click', (event) => {
        const block = event.target.closest('.livetv-guide-block');
        if (!block || !block.dataset.channelId) return;
        play(block.dataset.channelId, block.dataset.name || 'This channel', block.dataset.group || '');
      });
    }

    if (form) {
      form.addEventListener('submit', (event) => {
        event.preventDefault();
        const next = plainText(input && input.value);
        if (next === state.query) return;
        state.query = next;
        // A search spans the whole index; keeping a group chip on top of it
        // would silently narrow a result the viewer did not narrow.
        state.group = '';
        const { groups } = refs();
        if (groups) for (const chip of groups.querySelectorAll('.livetv-chip')) {
          chip.setAttribute('aria-pressed', String(chip.dataset.group === ''));
        }
        reload();
      });
    }

    results.addEventListener('click', (event) => {
      const card = event.target.closest('[data-channel-id]');
      if (!card) return;
      const name = plainText(card.querySelector('.livetv-card-name')?.textContent, 'This channel');
      play(card.dataset.channelId, name, card.dataset.group || '');
    });

    if (loadMore) {
      loadMore.addEventListener('click', () => loadPage({ append: true }));
    }
  }

  /**
   * The cap arrives on the same broadcast profile.js has fired on every switch
   * and every restore since it was written — the one manga.js and app.js both
   * listen to. Nothing is read out of localStorage here on purpose: a
   * remembered session the fleet has since disabled or given a PIN must not be
   * able to put a cap back that the owner already took away, and profile.js
   * checks the server's copy before it dispatches.
   *
   * A SWITCH MUST RE-FILTER WHAT IS ALREADY ON SCREEN, not only what loads
   * next. A grid filtered once at fetch time and never again is precisely the
   * Roku's BRK-14.
   */
  function adoptProfile(detail) {
    const next = plainText(detail && detail.maxRating).toLowerCase() || null;
    state.cap = next;
    state.group = '';
    state.query = '';
    state.guideLoaded = false;
    state.guideSpan = null;
    /* BOTH IN-FLIGHT READS ARE INVALIDATED HERE, NOT WHEN THE RELOAD LANDS.
     *
     * loadGroups() below is awaited before reload(), so without these two bumps
     * a sweep started under the profile that just went away would keep
     * appending its channels for as long as that await takes — under the new
     * cap, but from the old cursor and the old group. Bumping now makes it
     * return at its next checkpoint instead. */
    ++state.generation;
    ++state.guideGeneration;
    guideReset();
    const { input, guideGrid, results, loadMore, status } = refs();
    if (input) input.value = '';
    if (guideGrid) guideGrid.replaceChildren();
    /* AND THE OLD PROFILE'S CARDS COME OFF THE SCREEN NOW. The press-time lock
     * in play() already refuses them, so this is not the gate — but a child's
     * profile that shows a wall of adult channels for the length of a
     * /live/groups request has not switched as far as anyone watching is
     * concerned, and that is what B24 is about. */
    state.channels = [];
    state.total = 0;
    state.skip = 0;
    cards.clear();
    if (results) results.replaceChildren();
    if (loadMore) loadMore.hidden = true;
    // Said here rather than left to reload()'s describe(): between the two sits
    // a whole /live/groups request, and "Showing 3 of 38,899 channels" over an
    // empty grid is a sentence that sends people bug-hunting.
    if (status) status.textContent = noProfile() ? NO_PROFILE_COPY : 'Finding channels…';
    if (!state.mounted) return;
    loadGroups().then(() => reload());
    if (state.panel === 'guide') loadGuide();
  }

  document.addEventListener('blazing-profile-selected', (event) => {
    adoptProfile((event && event.detail) || {});
  });
  document.addEventListener('blazing-profile-signed-out', () => {
    adoptProfile({});
  });

  async function mount() {
    wire();
    if (state.mounted) return;
    state.mounted = true;
    startProgressTicker();
    ensureCardObserver();
    // Sequential, not concurrent, and only here. loadGroups() is what pins a
    // kids profile to a kids group, and a channel request fired beside it would
    // be the unscoped one — eight sweeps of a 41,341-row index for 427 rows.
    await loadGroups();
    reload();
  }

  /* The pure halves, published for the unit test the way profile.js publishes
     its own rules. firetv keeps GuideTimeline outside its Views for this exact
     reason: a rule left inline is a rule with no test behind it. */
  window.BlazingLiveTv = {
    mount,
    rules: {
      groupAllowed,
      slots: guideSlots,
      positionPx: guidePositionPx,
      nowLine,
      progress: progressOf,
      window: guideWindow,
      isPlaceholder,
    },
  };
})();
