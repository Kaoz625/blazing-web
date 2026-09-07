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

  const state = {
    mounted: false,
    wired: false,
    channels: [],
    total: 0,
    skip: 0,
    group: '',
    query: '',
    loading: false,
    generation: 0,
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
    };
  }

  function channelCard(channel) {
    const name = plainText(channel.name, 'Untitled channel');
    const button = element('button', 'card livetv-card');
    button.type = 'button';
    button.dataset.channelId = plainText(channel.id);
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

    const meta = element('span', 'livetv-card-meta');
    const bits = [];
    const group = plainText(channel.group);
    if (group) bits.push(group.charAt(0).toUpperCase() + group.slice(1));
    if (channel.hasGuide) bits.push('Guide');
    meta.textContent = bits.join(' · ');
    button.appendChild(meta);

    return button;
  }

  function describe() {
    const { status } = refs();
    if (!status) return;
    const shown = state.channels.length;
    if (state.loading && !shown) {
      status.textContent = 'Finding channels…';
      return;
    }
    if (!shown) {
      status.textContent = state.query
        ? `Nothing matched “${state.query}”. Try a channel name — CNN, BBC, CBS.`
        : state.group
          ? `Nothing but placeholder rows in ${state.group}. Try another group, or search by name.`
          // NOT "choose a profile": Live TV reads the public index without one,
          // so saying that sent a viewer who HAD chosen to go looking for a
          // profile bug that was not there.
          : 'No channels came back. Try a search — CNN, BBC, CBS.';
      return;
    }
    // The server's own total, filter included — never the filtered-down count.
    // See the header note: under-reporting the index sends people bug-hunting.
    const where = state.query ? ` matching “${state.query}”`
      : state.group ? ` in ${state.group}` : '';
    status.textContent = `Showing ${shown} of ${state.total.toLocaleString()} channels${where}.`;
  }

  function renderGroups(groups) {
    const { groups: host } = refs();
    if (!host) return;
    host.replaceChildren();
    const all = [{ id: '', name: 'All', count: 0 }, ...groups];
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
    const groups = Array.isArray(data && data.groups) ? data.groups : [];
    if (!groups.length) return;
    renderGroups(groups.map((g) => ({
      id: plainText(g.id),
      name: plainText(g.name, plainText(g.id, 'Group')),
      count: Number(g.count) || 0,
    })).filter((g) => g.id));
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
    if (state.loading) return;
    state.loading = true;
    const generation = ++state.generation;
    const { results, loadMore } = refs();
    if (!append && results) results.replaceChildren();
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
      // A stale answer from a filter the viewer has already moved off must not
      // paint over the one they are looking at.
      if (generation !== state.generation) return;

      const rows = Array.isArray(data && data.channels) ? data.channels : [];
      state.total = Number(data && data.total) || 0;
      state.skip += rows.length;
      keep.push(...rows.filter((c) => !isPlaceholder(c) && plainText(c.id)));
      // `rows.length`, not the kept count: a page that was entirely
      // placeholders still moved the cursor, and there is more behind it.
      if (rows.length < PAGE_SIZE) { exhausted = true; break; }
      if (keep.length) break;
    }
    state.loading = false;
    state.channels = append ? state.channels.concat(keep) : keep;

    if (results) {
      const frag = document.createDocumentFragment();
      for (const channel of keep) frag.appendChild(channelCard(channel));
      results.appendChild(frag);
    }
    if (loadMore) loadMore.hidden = exhausted;
    describe();
  }

  function reload() {
    state.skip = 0;
    state.channels = [];
    state.total = 0;
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
  async function play(channelId, name) {
    const { status } = refs();
    if (status) status.textContent = `Tuning ${name}…`;

    const ticket = await liveFetch(`/live/ticket/${encodeURIComponent(channelId)}`);
    if (!ticket || !plainText(ticket.url)) {
      if (status) {
        // An anonymous read sees only the public subset, so "nothing to play"
        // and "you are not connected" look identical from here. Name the more
        // likely one rather than telling a signed-out viewer the channel is dead.
        status.textContent = storedCredentials()
          ? `${name} has no playable stream right now.`
          : `${name} needs a connected profile — live channels are private to this household.`;
      }
      return;
    }

    if (!window.BlazingPlayer || typeof window.BlazingPlayer.open !== 'function') {
      if (status) status.textContent = 'The player is not ready yet. Try again in a moment.';
      return;
    }
    // The server declares the format. Sniffing this URL cannot work — it ends
    // in a ticket and carries no .m3u8 for looksLikeHls() to find.
    window.BlazingPlayer.open(name, `${FLEET_BASE}${ticket.url}`, {
      streamFormat: plainText(ticket.format).toLowerCase(),
    });
    describe();
  }

  function wire() {
    if (state.wired) return;
    const { form, input, results, loadMore } = refs();
    if (!results) return;
    state.wired = true;

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
      play(card.dataset.channelId, name);
    });

    if (loadMore) {
      loadMore.addEventListener('click', () => loadPage({ append: true }));
    }
  }

  function mount() {
    wire();
    if (state.mounted) return;
    state.mounted = true;
    loadGroups();
    reload();
  }

  window.BlazingLiveTv = { mount };
})();
