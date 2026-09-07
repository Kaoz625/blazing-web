/* Blazing web YouTube — the browsable YouTube destination.
 *
 * DESIGN.md (roku channels, line 74) names YouTube in the canonical eleven, and
 * the Roku has shipped the whole thing for weeks — source/lib/YouTube.brs plus
 * components/screens/YouTubeScreen.brs. This client shipped NONE of it: grep for
 * '/youtube/' across this repo before this file landed and the answer was zero
 * hits. Not a stub, not a broken view — the section simply did not exist on the
 * web while it existed on the television.
 *
 * NO IFRAME, AND NO DATA API. Both are bans, not preferences:
 *
 *   - A YouTube iframe cannot run on Roku, Apple TV, Fire TV, webOS, Tizen or
 *     VegaOS, and every feature in this product has to work on all of them. The
 *     media has to arrive as a plain video URL from our own backend, which is
 *     what /proxy/yt-resolve hands back.
 *   - The Data API is rationed at 10,000 units a day and a search costs 100 of
 *     them, i.e. 100 searches for the entire house. The fleet's youtube.js says
 *     this at length and uses yt-dlp instead; this file just consumes the result.
 *
 * WIRE CONTRACT (fleet.lyreosai.com — blazing-fleet/server.js:2378-2450, all ten
 * routes verified live on 6 Sep 2026 from this machine):
 *   GET    /youtube/home?per=<n>            -> { shelves: [{id,name,query,videos[]}] }   15 shelves
 *   GET    /youtube/search?q=&limit=        -> { videos: [] }
 *   GET    /youtube/channel/<ref>?limit=    -> { videos: [] }
 *   GET    /youtube/playlist/<id>?limit=    -> { videos: [] }
 *   GET    /youtube/channelinfo/<ref>       -> { id,name,avatar,subscribers,description }
 *   GET    /youtube/subs?profile=<id>       -> { channels: [{id,name,at}] }
 *   POST   /youtube/subs {profile,id,name}  -> { channels: [] }
 *   DELETE /youtube/subs/<ref>?profile=<id> -> { channels: [] }
 *   GET    /youtube/feed?profile=&per=      -> { videos: [] }
 *   GET    /youtube/health?ids=a,b,c        -> { health: { id: {ok,reason} } }
 * A video row is { id, title, duration, channel, channelId, views, thumb }.
 *
 * PLAYBACK IS THE EDUCATION CHAIN, NOT A SECOND ONE. app.js already plays
 * YouTube video in this browser with no embed: /proxy/yt-resolve?json=1&via=proxy
 * on the ADDON, then hls.js. Three facts make each part of that mandatory and
 * each was measured before it was written down (see resolveEduStream in app.js):
 *   1. `json=1`, because without it the route answers 302 into a signed manifest
 *      whose container has to be guessed, and the guess is wrong.
 *   2. `via=proxy`, because Google serves the signed HLS manifest with no
 *      Access-Control-Allow-Origin at all, so a browser cannot fetch it. The
 *      addon re-serves manifest and segments with a CORS header. Televisions do
 *      not pass this flag — they are not browsers and the direct URL is faster.
 *   3. hls.js, because YouTube no longer serves a combined progressive format,
 *      so the only playable link is an HLS variant manifest and Chrome cannot
 *      open one from a bare <video src>.
 * So this file resolves, and hands the URL to app.js's openPlayer through
 * window.BlazingPlayer. That keeps ONE player: the watchdog, the retry, the
 * telemetry, and the Apple TV / Android / Roku / Tizen native branches all come
 * for free, and a second copy of them here would be the next thing to drift.
 *
 * THE SECTION MENU IS BUILT FROM WHAT THE FLEET SENT, never from a list in this
 * file. That is the Roku's own scar, in its words: the fleet went from seven
 * shelves to fifteen, YouTubeScreen kept its hardcoded eight, and "half the
 * rooms in the app had no door". A menu written down in two places drifts the
 * first time one of them changes.
 *
 * NO SECOND ACCENT. styles.css records that Theme.brs deleted "Games green,
 * Adult magenta, YouTube red" by name, because a focus ring that changes hue by
 * section teaches the eye that focus means different things in different places.
 * Focus here is the one accent, like everywhere else.
 *
 * NO PROFILE GATE. Markus ruled on 6 Sep 2026 that accounts he invites are open
 * by design, and grepping the Roku channel for a youtubeAllowedNow() finds
 * nothing — YouTube has no age gate on any client in this fleet. What IS per
 * profile is what is YOURS: the follow list (server side, so it follows you to
 * the television) and Keep watching (this device, like the Roku's registry).
 */
'use strict';

(() => {
  const FLEET_BASE = window.BLAZING_FLEET_BASE || 'https://fleet.lyreosai.com';
  // Hardcoded to the same literal app.js uses for API_BASE rather than invented
  // as a new window global. A second override that app.js did not honour would
  // be a split: the resolver call below and app.js's own resolveEduStream would
  // be able to point at different hosts in the same page.
  const ADDON_BASE = 'https://addon.lyreosai.com';

  const FETCH_TIMEOUT_MS = 20000;
  // yt-dlp has to solve YouTube's player JS server-side, which is slow on a cold
  // cache. The list timeout above is tuned for a JSON read and is far too short
  // — this is the same 30s app.js gives the identical call.
  const RESOLVE_TIMEOUT_MS = 30000;

  const PER_SHELF = 12;
  const SEARCH_LIMIT = 24;
  const CHANNEL_LIMIT = 30;
  const PLAYLIST_LIMIT = 40;
  const FEED_PER = 4;

  // Keep watching lives on the device, keyed by profile, exactly like the Roku's
  // Store.brs YouTubeHistoryGet/Add. Twenty is that file's limit too.
  const HISTORY_KEY = 'blazing-yt-history-v1:';
  const HISTORY_LIMIT = 20;

  // The same three shapes the fleet's youtube.js validates with. Checking them
  // here as well is not belt-and-braces: a bad ref is a wasted round trip and a
  // 502 rendered as "YouTube did not answer", which reads as an outage.
  const VIDEO_ID_RE = /^[A-Za-z0-9_-]{6,24}$/;
  const CHANNEL_RE = /^(UC[A-Za-z0-9_-]{20,24}|@[A-Za-z0-9._-]{1,64})$/;
  const LIST_ID_RE = /^[A-Za-z0-9_-]{2,64}$/;

  const state = {
    bound: false,
    loaded: false,
    loading: false,
    profileId: null,
    shelves: [],
    subs: [],
    feed: [],
    section: 'home',
    query: '',
    channel: null,
    playlistId: '',
    // Bumped by every profile switch and every section change, so a slow answer
    // that lands after the viewer has moved on is dropped instead of painting
    // the previous room's videos over the current one.
    generation: 0,
  };

  /* ── small shared helpers ───────────────────────────────────────────────── */

  function element(tag, className) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    return node;
  }

  function plainText(value, fallback = '') {
    const out = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
    return out ? out.slice(0, 400) : fallback;
  }

  // The same rule app.js's safeHttpsUrl uses everywhere a network value reaches
  // an <img src> or a <video src>: https only, so an upstream value can never
  // become a javascript: or data: URI in the DOM.
  function safeHttpsUrl(value) {
    try {
      const url = new URL(String(value || ''));
      return url.protocol === 'https:' ? url.href : '';
    } catch {
      return '';
    }
  }

  function telemetry(name, props) {
    try { window.BlazingTelemetry && window.BlazingTelemetry.log(name, props); } catch { /* never throws */ }
  }

  async function fetchJSON(url, options) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), ...options });
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  }

  /** H:MM:SS over an hour, M:SS under it — the format YouTubeDuration() prints. */
  function duration(seconds) {
    const total = Math.max(0, Math.floor(Number(seconds) || 0));
    if (!total) return '';
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const two = (n) => String(n).padStart(2, '0');
    return h ? `${h}:${two(m)}:${two(s)}` : `${m}:${two(s)}`;
  }

  /** 57059232 -> "57M views". Zero is not "0 views", it is nothing at all:
   *  yt-dlp prints NA for a view count it does not have and the fleet turns that
   *  into 0, so a literal zero here would be a measurement we never took. */
  function views(count) {
    const n = Number(count) || 0;
    if (n <= 0) return '';
    if (n >= 1e9) return `${(n / 1e9).toFixed(1).replace(/\.0$/, '')}B views`;
    if (n >= 1e6) return `${(n / 1e6).toFixed(1).replace(/\.0$/, '')}M views`;
    if (n >= 1e3) return `${Math.round(n / 1e3)}K views`;
    return `${n} views`;
  }

  function subscribers(count) {
    const n = Number(count) || 0;
    if (n <= 0) return '';
    if (n >= 1e6) return `${(n / 1e6).toFixed(1).replace(/\.0$/, '')}M subscribers`;
    if (n >= 1e3) return `${Math.round(n / 1e3)}K subscribers`;
    return `${n} subscribers`;
  }

  /** One wire row, trusted for nothing. Returns null for anything unplayable. */
  function normalize(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const id = String(raw.id || '').trim();
    if (!VIDEO_ID_RE.test(id)) return null;
    const channelId = String(raw.channelId || '').trim();
    return {
      id,
      title: plainText(raw.title, id),
      duration: Number(raw.duration) > 0 ? Number(raw.duration) : 0,
      channel: plainText(raw.channel),
      channelId: CHANNEL_RE.test(channelId) ? channelId : '',
      views: Number(raw.views) > 0 ? Number(raw.views) : 0,
      // Always available at a known size with no extra request, and the fleet
      // already builds it — but it still goes through the https gate, because
      // "the server built it" is where an unchecked value usually comes from.
      thumb: safeHttpsUrl(raw.thumb) || `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
    };
  }

  function normalizeAll(list) {
    return (Array.isArray(list) ? list : []).map(normalize).filter(Boolean);
  }

  function refs() {
    return {
      view: document.getElementById('youtube-view'),
      form: document.getElementById('yt-search-form'),
      input: document.getElementById('yt-search-input'),
      sections: document.getElementById('yt-sections'),
      channel: document.getElementById('yt-channel'),
      status: document.getElementById('yt-status'),
      rows: document.getElementById('yt-rows'),
    };
  }

  function setStatus(text) {
    const { status } = refs();
    if (status) status.textContent = text || '';
  }

  /* ── Keep watching ──────────────────────────────────────────────────────── */

  function historyKey() {
    // Signed out is its own bucket rather than a shared one. Two people on one
    // browser must not read each other's watch history back off this device.
    return HISTORY_KEY + encodeURIComponent(state.profileId || 'signed-out');
  }

  function history() {
    try {
      const data = JSON.parse(localStorage.getItem(historyKey()) || '[]');
      return normalizeAll(data);
    } catch {
      return [];
    }
  }

  /** Re-watching moves a video to the front rather than adding a second copy —
   *  Store.brs makes the same point: a repeat play otherwise pushes everything
   *  else off the end of the shelf. */
  function historyAdd(video) {
    if (!video || !video.id) return;
    const next = [video, ...history().filter((v) => v.id !== video.id)].slice(0, HISTORY_LIMIT);
    try { localStorage.setItem(historyKey(), JSON.stringify(next)); } catch { /* private mode: the shelf is simply empty */ }
  }

  /* ── cards and rows ─────────────────────────────────────────────────────── */

  /**
   * One card is ONE focus stop, and that is a d-pad decision rather than a
   * layout one. YouTube's own web card carries a second link on the channel
   * line; on a remote that turns every DOWN press between rows into two, because
   * dpad.js moves by geometry and the channel line sits directly under the
   * thumbnail. Channels are reachable from the chips instead — see channelChips.
   */
  function card(video) {
    const button = element('button', 'yt-card');
    button.type = 'button';
    button.dataset.videoId = video.id;
    if (video.channelId) button.dataset.channelId = video.channelId;
    button.setAttribute('aria-label', `Play ${video.title}`);

    const thumb = element('span', 'yt-thumb');
    const image = element('img', 'yt-thumb-img');
    image.loading = 'lazy';
    image.decoding = 'async';
    image.alt = '';
    image.src = video.thumb;
    // A dead thumbnail has to be MARKED, not left as a blank rectangle that
    // reads exactly like a card still loading. Same rule as .card.no-image.
    image.addEventListener('error', () => thumb.classList.add('no-image'), { once: true });
    thumb.appendChild(image);
    const length = duration(video.duration);
    if (length) {
      const badge = element('span', 'yt-duration');
      badge.textContent = length;
      thumb.appendChild(badge);
    }

    const title = element('span', 'yt-card-title');
    title.textContent = video.title;
    const meta = element('span', 'yt-card-meta');
    meta.textContent = [video.channel, views(video.views)].filter(Boolean).join(' · ');

    button.append(thumb, title, meta);
    button.addEventListener('click', () => play(video));
    return button;
  }

  function row(name, videos, extra) {
    const section = element('section', 'row yt-row');
    const heading = element('h2', 'row-title');
    heading.textContent = name;
    const track = element('div', 'row-track');
    videos.forEach((video) => track.appendChild(card(video)));
    section.append(heading);
    if (extra) section.append(extra);
    section.append(track);
    return section;
  }

  /**
   * The distinct channels behind a set of results, as chips.
   *
   * This is how a channel page is reached at all, and it exists because the card
   * above is deliberately a single button. A search for "lofi" answers with four
   * or five channels; those five chips are five focus stops, against the
   * twenty-four a per-card channel link would add.
   */
  function channelChips(videos) {
    const seen = new Map();
    for (const video of videos) {
      if (video.channelId && video.channel && !seen.has(video.channelId)) {
        seen.set(video.channelId, video.channel);
      }
    }
    if (!seen.size) return null;
    const wrap = element('div', 'yt-chips');
    const label = element('span', 'yt-chips-label');
    label.textContent = 'Channels';
    wrap.appendChild(label);
    for (const [id, name] of seen) {
      const chip = element('button', 'yt-chip');
      chip.type = 'button';
      chip.dataset.channelId = id;
      chip.textContent = name;
      chip.addEventListener('click', () => openChannel(id, name));
      wrap.appendChild(chip);
    }
    return wrap;
  }

  /* ── playback ───────────────────────────────────────────────────────────── */

  /**
   * Resolve one video id to a playable URL AND its container.
   *
   * Returns null on any failure; the caller says so on screen. See the header of
   * this file for why every one of these query parameters is load-bearing.
   */
  async function resolve(id) {
    if (!VIDEO_ID_RE.test(String(id || ''))) return null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), RESOLVE_TIMEOUT_MS);
    try {
      const res = await fetch(
        `${ADDON_BASE}/proxy/yt-resolve?id=${encodeURIComponent(id)}&json=1&via=proxy`,
        { mode: 'cors', credentials: 'omit', signal: controller.signal },
      );
      if (!res.ok) return null;
      const data = await res.json();
      // The proxied form comes back as a PATH, not an absolute URL, so the addon
      // does not have to know which hostname it is being served under.
      const raw = data && data.url;
      const absolute = (typeof raw === 'string' && raw.startsWith('/')) ? `${ADDON_BASE}${raw}` : raw;
      const url = safeHttpsUrl(absolute);
      if (!url) return null;
      return { url, streamFormat: (data && data.streamFormat) || '' };
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  async function play(video) {
    const generation = state.generation;
    setStatus('Getting the video…');
    const stream = await resolve(video.id);
    if (generation !== state.generation) return;
    if (!stream) {
      // Name the piece that failed. "Cannot play" alone has sent people hunting
      // for a dead video when the video was fine and the resolver was down.
      setStatus('That video could not be opened — the resolver on the server did not answer.');
      telemetry('play_failed', { id: video.id, from: 'youtube' });
      return;
    }
    setStatus('');
    // Recorded BEFORE the player opens, not after it closes: a viewer who backs
    // out in ten seconds still watched it, and the Roku records at the same
    // moment (MainScene.brs YouTubeHistoryAdd on the selection).
    historyAdd(video);
    if (state.section === 'home') renderHome();
    telemetry('play_start', { id: video.id, from: 'youtube', section: state.section });
    if (window.BlazingPlayer && window.BlazingPlayer.open) {
      window.BlazingPlayer.open(video.title, stream.url, { streamFormat: stream.streamFormat });
      return;
    }
    // app.js owns the player and is loaded before this file, so this is a
    // "someone changed the script order" message rather than a real state.
    setStatus('The player did not load, so this video cannot be started.');
  }

  /* ── subscriptions ──────────────────────────────────────────────────────── */

  function following(ref) {
    return state.subs.some((c) => c && c.id === ref);
  }

  async function loadSubs() {
    if (!state.profileId) { state.subs = []; return; }
    const data = await fetchJSON(`${FLEET_BASE}/youtube/subs?profile=${encodeURIComponent(state.profileId)}`);
    state.subs = (data && Array.isArray(data.channels) ? data.channels : [])
      .filter((c) => c && CHANNEL_RE.test(String(c.id || '')))
      .map((c) => ({ id: String(c.id), name: plainText(c.name, String(c.id)) }));
  }

  async function follow(ref, name) {
    if (!state.profileId || !CHANNEL_RE.test(ref)) return;
    const data = await fetchJSON(`${FLEET_BASE}/youtube/subs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ profile: state.profileId, id: ref, name }),
    });
    if (data && Array.isArray(data.channels)) {
      state.subs = data.channels.map((c) => ({ id: String(c.id), name: plainText(c.name, String(c.id)) }));
    }
    telemetry('nav_action', { action: 'yt_follow', from: 'youtube' });
    renderSections();
  }

  async function unfollow(ref) {
    if (!state.profileId || !CHANNEL_RE.test(ref)) return;
    const data = await fetchJSON(
      `${FLEET_BASE}/youtube/subs/${encodeURIComponent(ref)}?profile=${encodeURIComponent(state.profileId)}`,
      { method: 'DELETE' },
    );
    if (data && Array.isArray(data.channels)) {
      state.subs = data.channels.map((c) => ({ id: String(c.id), name: plainText(c.name, String(c.id)) }));
    }
    telemetry('nav_action', { action: 'yt_unfollow', from: 'youtube' });
    renderSections();
  }

  /* ── the section menu ───────────────────────────────────────────────────── */

  /**
   * Home, Following, then one chip per shelf the fleet actually sent, then
   * Playlists. Rebuilt every time the shelves or the follow list change, and
   * never read from a list in this file — see the header.
   */
  function renderSections() {
    const { sections } = refs();
    if (!sections) return;
    const entries = [{ id: 'home', label: 'Home' }, { id: 'subs', label: 'Following' }];
    for (const shelf of state.shelves) entries.push({ id: `shelf:${shelf.id}`, label: shelf.name });
    entries.push({ id: 'playlist', label: 'Playlists' });
    if (state.section === 'search') entries.push({ id: 'search', label: 'Search results' });
    if (state.section === 'channel' && state.channel) {
      entries.push({ id: 'channel', label: plainText(state.channel.name, 'Channel') });
    }

    sections.replaceChildren(...entries.map((entry) => {
      const chip = element('button', 'yt-section');
      chip.type = 'button';
      chip.dataset.section = entry.id;
      chip.textContent = entry.label;
      const on = entry.id === state.section;
      chip.classList.toggle('active', on);
      chip.setAttribute('aria-current', on ? 'true' : 'false');
      chip.addEventListener('click', () => showSection(entry.id));
      return chip;
    }));
  }

  /* ── rendering each section ─────────────────────────────────────────────── */

  function renderHome() {
    const { rows, channel } = refs();
    if (!rows) return;
    if (channel) { channel.hidden = true; channel.replaceChildren(); }

    const out = [];
    // Order matters and it is the Roku's order, in YouTubeScreen.brs's own
    // words: "the things that are YOURS come before the things that are
    // everyone's." Keep watching, then your channels, then the shelves.
    const watched = history();
    if (watched.length) out.push(row('Keep watching', watched));
    if (state.feed && state.feed.length) out.push(row('New from your channels', state.feed));
    for (const shelf of state.shelves) {
      if (shelf.videos.length) out.push(row(shelf.name, shelf.videos));
    }
    rows.replaceChildren(...out);

    if (!out.length) {
      // "Did not answer" while a request is still in flight is a lie, and it is
      // the one a viewer sees most: leaving the tab and coming back re-enters
      // mount() with the first load still running, so this branch is reached
      // before any shelf could possibly exist.
      setStatus(state.loading
        ? 'Loading YouTube…'
        : 'YouTube did not answer. The shelves come from the fleet, and it is not reachable right now.');
    } else {
      const shelfCount = state.shelves.filter((s) => s.videos.length).length;
      setStatus(`${shelfCount} shelves${watched.length ? `, ${watched.length} to keep watching` : ''}.`);
    }
  }

  function renderShelf(id) {
    const { rows, channel } = refs();
    if (!rows) return;
    if (channel) { channel.hidden = true; channel.replaceChildren(); }
    const shelf = state.shelves.find((s) => s.id === id);
    if (!shelf || !shelf.videos.length) {
      rows.replaceChildren();
      setStatus('That shelf came back empty.');
      return;
    }
    const chips = channelChips(shelf.videos);
    rows.replaceChildren(row(shelf.name, shelf.videos, chips));
    setStatus(`${shelf.videos.length} in ${shelf.name}.`);
  }

  async function renderSubs() {
    const { rows, channel } = refs();
    if (!rows) return;
    if (channel) { channel.hidden = true; channel.replaceChildren(); }
    const generation = state.generation;

    if (!state.profileId) {
      rows.replaceChildren();
      setStatus('Choose a profile to follow channels — the follow list is yours, and it follows you to the television.');
      return;
    }
    if (!state.subs.length) {
      rows.replaceChildren();
      setStatus('You follow no channels yet. Search for something, open a channel from the Channels chips, and press Follow.');
      return;
    }

    setStatus('Loading your channels…');
    // The feed is ONE request that the fleet fans out and interleaves, so
    // following twenty channels is still one round trip from a device on a TV's
    // network — see subsFeed() in the fleet's youtube.js for why it interleaves
    // rather than concatenates.
    const feed = await fetchJSON(`${FLEET_BASE}/youtube/feed?profile=${encodeURIComponent(state.profileId)}&per=${FEED_PER}`);
    if (generation !== state.generation) return;
    const videos = normalizeAll(feed && feed.videos);

    const chips = element('div', 'yt-chips');
    const label = element('span', 'yt-chips-label');
    label.textContent = 'Following';
    chips.appendChild(label);
    for (const sub of state.subs) {
      const chip = element('button', 'yt-chip');
      chip.type = 'button';
      chip.dataset.channelId = sub.id;
      chip.textContent = sub.name;
      chip.addEventListener('click', () => openChannel(sub.id, sub.name));
      chips.appendChild(chip);
    }

    if (videos.length) {
      rows.replaceChildren(row('New from your channels', videos, chips));
      setStatus(`${videos.length} new from ${state.subs.length} channel${state.subs.length === 1 ? '' : 's'}.`);
    } else {
      const empty = element('section', 'row yt-row');
      const heading = element('h2', 'row-title');
      heading.textContent = 'New from your channels';
      empty.append(heading, chips);
      rows.replaceChildren(empty);
      setStatus('Nothing new from your channels right now.');
    }
  }

  async function runSearch(query) {
    const q = plainText(query);
    if (q.length < 2) {
      setStatus('Type at least two characters to search YouTube.');
      return;
    }
    state.query = q;
    state.section = 'search';
    renderSections();
    const generation = ++state.generation;
    const { rows, channel } = refs();
    if (channel) { channel.hidden = true; channel.replaceChildren(); }
    if (rows) rows.replaceChildren();
    setStatus(`Searching YouTube for “${q}”…`);

    const data = await fetchJSON(`${FLEET_BASE}/youtube/search?q=${encodeURIComponent(q)}&limit=${SEARCH_LIMIT}`);
    if (generation !== state.generation) return;
    const videos = normalizeAll(data && data.videos);
    if (!videos.length) {
      setStatus(data ? `Nothing for “${q}”.` : 'YouTube did not answer that search.');
      return;
    }
    if (rows) rows.replaceChildren(row(`Results for “${q}”`, videos, channelChips(videos)));
    setStatus(`${videos.length} result${videos.length === 1 ? '' : 's'} for “${q}”.`);
    telemetry('nav_action', { action: 'yt_search', from: 'youtube' });
  }

  /**
   * A channel page: header, Follow button, and everything it has published.
   *
   * The header comes from /youtube/channelinfo, which is the ONE job the Data
   * API key genuinely earns — in flat-playlist mode yt-dlp prints "NA" for the
   * channel name and avatar, so there is nothing to read them out of. With no
   * key configured the fleet still answers, the page just wears the handle as
   * its title, so this must not treat a bare fallback as a failure.
   */
  async function openChannel(ref, fallbackName) {
    if (!CHANNEL_RE.test(String(ref || ''))) return;
    state.section = 'channel';
    state.channel = { id: ref, name: plainText(fallbackName, ref) };
    renderSections();
    const generation = ++state.generation;
    const { rows, channel } = refs();
    if (rows) rows.replaceChildren();
    setStatus('Loading the channel…');

    const [info, list] = await Promise.all([
      fetchJSON(`${FLEET_BASE}/youtube/channelinfo/${encodeURIComponent(ref)}`),
      fetchJSON(`${FLEET_BASE}/youtube/channel/${encodeURIComponent(ref)}?limit=${CHANNEL_LIMIT}`),
    ]);
    if (generation !== state.generation) return;

    const name = plainText(info && info.name, state.channel.name);
    state.channel = { id: ref, name };

    if (channel) {
      const art = element('div', 'yt-channel-art');
      const avatar = safeHttpsUrl(info && info.avatar);
      if (avatar) {
        const image = element('img', 'yt-channel-avatar');
        image.alt = '';
        image.loading = 'lazy';
        image.decoding = 'async';
        image.src = avatar;
        art.appendChild(image);
      } else {
        art.classList.add('no-image');
      }
      const text = element('div', 'yt-channel-text');
      const title = element('h2', 'yt-channel-name');
      title.textContent = name;
      const line = element('p', 'yt-channel-meta');
      line.textContent = subscribers(info && info.subscribers);
      text.append(title, line);

      const action = element('button', following(ref) ? 'secondary-button' : 'primary-button');
      action.type = 'button';
      action.id = 'yt-follow';
      action.textContent = following(ref) ? 'Following' : 'Follow';
      action.setAttribute('aria-pressed', following(ref) ? 'true' : 'false');
      if (!state.profileId) {
        action.disabled = true;
        action.title = 'Choose a profile to follow channels.';
      }
      action.addEventListener('click', async () => {
        if (!state.profileId) return;
        action.disabled = true;
        if (following(ref)) await unfollow(ref); else await follow(ref, name);
        action.disabled = false;
        action.className = following(ref) ? 'secondary-button' : 'primary-button';
        action.textContent = following(ref) ? 'Following' : 'Follow';
        action.setAttribute('aria-pressed', following(ref) ? 'true' : 'false');
      });

      channel.replaceChildren(art, text, action);
      channel.hidden = false;
    }

    const videos = normalizeAll(list && list.videos);
    if (!videos.length) {
      setStatus('That channel published nothing we can list.');
      return;
    }
    if (rows) rows.replaceChildren(row(`From ${name}`, videos));
    setStatus(`${videos.length} from ${name}.`);
    telemetry('nav_action', { action: 'yt_channel', from: 'youtube' });
  }

  /**
   * Playlists, opened by id or by a pasted YouTube URL.
   *
   * A pasted link is the realistic input — nobody types PLOHoVaTp8R7d… — so the
   * `list=` parameter is pulled out of any URL that carries one, and a bare id
   * is still accepted.
   */
  function playlistIdFrom(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    if (LIST_ID_RE.test(raw)) return raw;
    try {
      const list = new URL(raw).searchParams.get('list');
      return list && LIST_ID_RE.test(list) ? list : '';
    } catch {
      return '';
    }
  }

  function renderPlaylist() {
    const { rows, channel } = refs();
    if (!rows) return;
    if (channel) { channel.hidden = true; channel.replaceChildren(); }

    const form = element('form', 'search-form yt-playlist-form');
    form.id = 'yt-playlist-form';
    const input = element('input', '');
    input.id = 'yt-playlist-input';
    input.type = 'search';
    input.name = 'ytlist';
    input.autocomplete = 'off';
    input.placeholder = 'Playlist link or id';
    input.value = state.playlistId;
    input.setAttribute('aria-label', 'YouTube playlist link or id');
    const submit = element('button', 'primary-button');
    submit.type = 'submit';
    submit.textContent = 'Open playlist';
    form.append(input, submit);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      openPlaylist(input.value);
    });

    const host = element('div', 'yt-playlist-host');
    rows.replaceChildren(form, host);
    if (!state.playlistId) setStatus('Paste a YouTube playlist link, or its id, to open it here.');
  }

  async function openPlaylist(value) {
    const id = playlistIdFrom(value);
    if (!id) {
      setStatus('That is not a playlist link or id.');
      return;
    }
    state.playlistId = id;
    const generation = ++state.generation;
    setStatus('Loading the playlist…');
    const data = await fetchJSON(`${FLEET_BASE}/youtube/playlist/${encodeURIComponent(id)}?limit=${PLAYLIST_LIMIT}`);
    if (generation !== state.generation) return;
    const videos = normalizeAll(data && data.videos);
    const host = document.querySelector('.yt-playlist-host');
    if (!videos.length) {
      if (host) host.replaceChildren();
      setStatus(data ? 'That playlist came back empty — it may be private.' : 'YouTube did not answer for that playlist.');
      return;
    }
    if (host) host.replaceChildren(row('Playlist', videos, channelChips(videos)));
    setStatus(`${videos.length} in this playlist.`);
    telemetry('nav_action', { action: 'yt_playlist', from: 'youtube' });
  }

  function showSection(id) {
    state.section = id;
    ++state.generation;
    renderSections();
    if (id === 'home') { renderHome(); return; }
    if (id === 'subs') { renderSubs(); return; }
    if (id === 'playlist') { renderPlaylist(); if (state.playlistId) openPlaylist(state.playlistId); return; }
    if (id.startsWith('shelf:')) { renderShelf(id.slice(6)); return; }
    if (id === 'search') { runSearch(state.query); return; }
    if (id === 'channel' && state.channel) { openChannel(state.channel.id, state.channel.name); return; }
    renderHome();
  }

  /* ── loading and mounting ───────────────────────────────────────────────── */

  async function loadHome() {
    if (state.loading) return;
    state.loading = true;
    const generation = state.generation;
    setStatus('Loading YouTube…');
    // Home and the follow list in parallel. One request per shelf would be
    // fifteen round trips before the screen drew — the whole reason the fleet
    // has a /youtube/home at all.
    const [home] = await Promise.all([
      fetchJSON(`${FLEET_BASE}/youtube/home?per=${PER_SHELF}`),
      loadSubs(),
    ]);
    state.loading = false;
    if (generation !== state.generation) return;

    state.shelves = ((home && Array.isArray(home.shelves)) ? home.shelves : [])
      .map((shelf) => ({
        id: plainText(shelf && shelf.id),
        name: plainText(shelf && shelf.name, 'Shelf'),
        videos: normalizeAll(shelf && shelf.videos),
      }))
      .filter((shelf) => shelf.id);
    state.loaded = state.shelves.length > 0;

    // The follow feed is fetched here too so Home can carry it, but a profile
    // with no follows must not pay for a request that can only answer [].
    if (state.profileId && state.subs.length) {
      const feed = await fetchJSON(`${FLEET_BASE}/youtube/feed?profile=${encodeURIComponent(state.profileId)}&per=${FEED_PER}`);
      if (generation !== state.generation) return;
      state.feed = normalizeAll(feed && feed.videos);
    } else {
      state.feed = [];
    }

    renderSections();
    if (state.section === 'home') renderHome();
  }

  function bindOnce() {
    if (state.bound) return;
    state.bound = true;
    const { form, input } = refs();
    if (form) {
      form.addEventListener('submit', (event) => {
        event.preventDefault();
        runSearch(input ? input.value : '');
      });
    }
  }

  function mount() {
    bindOnce();
    renderSections();
    if (state.loaded) {
      showSection(state.section);
    } else {
      // loadHome() FIRST, and not for the network: everything up to its first
      // await runs synchronously, so it is what sets state.loading and the
      // "Loading YouTube…" line. Called the other way round, renderHome() runs
      // with loading still false, finds no shelves, and prints "YouTube did not
      // answer" over a request that has not been made yet.
      //
      // renderHome() second and NOT awaited: Keep watching is on this device
      // and needs no network at all, so a returning viewer sees their own row
      // immediately instead of an empty page with a spinner.
      loadHome();
      renderHome();
    }
    telemetry('screen_view', { screen: 'youtube' });
  }

  // The same broadcast profile.js has fired on every switch since it was
  // written. A profile switch has to re-read what is ALREADY on screen, not
  // only what loads next: the follow list and Keep watching are both per
  // profile, and leaving the previous person's rows up is the web version of
  // the Roku's BRK-14.
  document.addEventListener('blazing-profile-selected', async (event) => {
    const detail = (event && event.detail) || {};
    state.profileId = detail.id || null;
    ++state.generation;
    state.feed = [];
    await loadSubs();
    renderSections();
    const { view } = refs();
    if (view && !view.hidden) showSection(state.section);
  });

  document.addEventListener('blazing-profile-signed-out', () => {
    state.profileId = null;
    state.subs = [];
    state.feed = [];
    ++state.generation;
    renderSections();
    const { view } = refs();
    if (view && !view.hidden) showSection(state.section);
  });

  window.BlazingYouTube = {
    mount,
    showSection,
    search: runSearch,
    openChannel,
    openPlaylist,
    history,
    // Exposed for the harnesses and the console. Carries no secret: ids and
    // titles only, which is the same thing the cards already show.
    debug: () => ({
      shelves: state.shelves.map((s) => ({ id: s.id, videos: s.videos.length })),
      section: state.section,
      subs: state.subs.length,
      profileId: state.profileId,
      keepWatching: history().length,
    }),
  };
})();
