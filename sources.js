/* Blazing web Stream Sources — where a stream in this browser actually comes
 * from, and the add-on directory behind it. READ ONLY, and it says so out loud.
 *
 * Audit item B2. The finding was not "the browser is missing a screen": it was
 * that the same drawer row, in the same position, opens two DIFFERENT and
 * incompatible systems on the two televisions that have it —
 *
 *   Roku "Sources"     the Stremio add-on directory. Plain HTTP+JSON, which is
 *                      why a Roku can speak it. Toggling a row there installs
 *                      the add-on FOR THAT ROKU
 *                      (roku channels/components/screens/AddonsScreen.brs).
 *   Fire TV "Sources"  the Kodi add-on store. Kodi add-ons are Python running
 *                      ON THE SERVER, installed through the fleet behind a
 *                      parental PIN (AddonStoreActivity.kt:19-28, 50).
 *
 * — and that a source added on one device is invisible on the other two. The
 * audit's ruling is explicit about what may and may not be done about that
 * before Markus rules on what "Sources" means:
 *
 *   "Do not port either one … The defensible minimum is (a) rename the two rows
 *    so they stop claiming to be the same screen, and (b) give the two clients
 *    that have no door a read-only view of whichever list is authoritative."
 *
 * (a) is the Roku's and the Fire TV's own repos to change and is not touched
 * from here. (b) is this screen. The Apple TV closed its half first
 * (blazing-tvos/Sources/StreamSourcesView.swift, itself built from the Roku);
 * this file is the browser's half, built from that one, so all three read the
 * same feeds in the same order and say the same words about the same add-on.
 *
 * READ-ONLY IS DELIBERATE AND ENFORCED, not a first phase. THERE IS NOTHING FOR
 * IT TO WRITE. A browser cannot install a Stremio add-on — that registry is the
 * Roku's own, per-television — and it certainly cannot run a Kodi add-on, which
 * is a Python plugin needing a Kodi runtime no browser has. A switch drawn here
 * would be a control that does nothing, which is exactly what this audit was
 * convened to find. tvOS makes the same point by giving each row a Button with
 * an EMPTY action (StreamSourcesView.swift:395-399); the rows below are the same
 * shape — a hover/focus target that fills the panel beside them and nothing
 * else. THERE IS NO INPUT, NO TOGGLE AND NO NON-GET REQUEST IN THIS FILE, and
 * sources.smoke.mjs asserts both of those against the live DOM and the wire.
 *
 * NOT TO BE CONFUSED WITH settings.js:507-630 `renderAddonForm`, which stays
 * exactly as it is. That is a WRITE box — one free-text field doing a
 * read-modify-write on the account secret `stremio_addon_url` — and it is the
 * household's own list, not the directory. This screen is the directory.
 *
 * AND THE NAME. Not "Sources": this app already has a Sources control, on the
 * detail sheet, and there it means "the copies of THIS film" — a per-title
 * stream list. Two different screens one word apart is the defect the audit
 * opened with, so this one is called Stream Sources in the drawer and in the
 * heading, the same two places tvOS names it.
 *
 * WIRE CONTRACT, read live and never typed in here:
 *   GET <META_BASE>/addon_catalog/all/official.json
 *   GET <META_BASE>/addon_catalog/all/community.json
 *       -> { addons: [{ transportUrl, manifest: { name, description, types,
 *                       resources, behaviorHints: { configurationRequired } } }] }
 *       Stremio publishes its add-on list THROUGH the add-on protocol, which is
 *       why the list keeps itself current with no website to remember. The two
 *       feeds are the Roku's own (AddonClient.brs:1083-1120,
 *       `StremioAddonDirectory`) and tvOS's (StreamSourcesView.swift).
 *   GET <ADDON_BASE>/manifest.json
 *       -> the aggregator's own account of itself. It is the only place that
 *       list exists — the addon serves no /api/sources route (probed 12 Sep
 *       2026: 404) — so it is the authoritative statement for this client.
 */
'use strict';

(() => {
  /* The aggregator every film and series in this browser is actually resolved
     by. Same constant settings.js:48 reads, same default. */
  const ADDON_BASE = window.BLAZING_API_BASE || 'https://addon.lyreosai.com';

  /* Cinemeta. app.js:12 already holds this exact string as CINEMETA, and tvOS
     holds it as BlazingAPI.metaBase (BlazingAPI.swift:11) — it is not a new
     origin, it is the one the catalogue rows have always come from. Not read
     off app.js: that const is module-private to app.js and is not exported. */
  const META_BASE = 'https://v3-cinemeta.strem.io';

  /* tvOS's two timeouts, kept apart for the same reason it keeps them apart:
     the directory is two large documents and the manifest is one small one. */
  const DIRECTORY_TIMEOUT_MS = 25000;
  const MANIFEST_TIMEOUT_MS = 20000;

  /* Official first, then community — the Roku's order, which is also the order
     that puts the seven add-ons anybody recognises at the top of a list of a
     hundred. Measured on tvOS 12 Sep 2026: 7 official, 95 community. */
  const FEEDS = Object.freeze([
    Object.freeze([`${META_BASE}/addon_catalog/all/official.json`, 'Official']),
    Object.freeze([`${META_BASE}/addon_catalog/all/community.json`, 'Community']),
  ]);

  /* THE ROKU'S OWN SENTENCE, word for word, from
     roku channels/components/screens/AddonsScreen.brs:28. tvOS repeats it at
     StreamSourcesView.swift:354 for the same reason, and that reason is the
     whole of B2: it is the sentence that stops somebody expecting the Fire
     Stick's screen here. Three clients, one sentence. Do not reword it. */
  const FOOTER_SHARED = 'Kodi add-ons cannot run here - they are Python. These speak the Stremio protocol, which is plain HTTP, which is why a Roku can use them.';

  /* This client's half of the same truth — tvOS's second footer paragraph with
     "This Apple TV" swapped for the thing the reader is actually holding. */
  const FOOTER_WEB = 'This browser installs neither. Everything it plays is resolved by the aggregator above, so switching a source on or off is done on the Roku — and the Kodi add-ons on the server are installed from the Fire Stick, behind the parental PIN.';

  /** The Roku's sentence for a dead feed (AddonsScreen.brs onCatalog). */
  const DEAD_DIRECTORY = 'Could not reach the add-on directory - check the network.';

  /* The Roku's showDetail note, kept because it is the one piece of this list a
     reader genuinely needs explaining. "not on this TV" is the only edit: the
     reader is in a browser, and a sentence that names the wrong device is worse
     than a paraphrase. */
  const NEEDS_SETUP_NOTE = 'Configure this one on its own website first. The URL it gives you goes in the aggregator\'s source list, not in this browser - then every device gets it at once.';
  const READY_NOTE = 'Already reachable through the aggregator above. There is nothing to switch on here.';

  /** Shown when nobody is allowed to see this screen. settings.js:475-480. */
  const GATE_CAPPED = 'This profile\'s rating limit hides Stream Sources.';
  const GATE_NO_PROFILE = 'Choose a profile to see where content comes from.';

  const state = {
    mounted: false,
    /** null until the first load finishes; [] means the directory answered nothing. */
    addons: null,
    aggregator: null,
    loading: false,
    failed: false,
    /** The base of the row whose detail panel is on screen. */
    focused: '',
    /** The profile broadcast, or null. NULL IS A NO — see allowed(). */
    profile: null,
  };

  /* ── the gate ────────────────────────────────────────────────────────────
   *
   * B13 is already closed on this client and this screen must not reopen it.
   * The rule is settings.js:330-333 `grownUp()` — not a Kids profile, and rated
   * at least 'mature' — and it is REUSED rather than copied. A second copy of a
   * parental rule is a second copy that drifts, and the audit has already found
   * that shape once.
   *
   * A MISSING BlazingSettings IS A NO. settings.js is in the service worker's
   * shell list and loads before this file, so the only way `core` is absent is
   * a half-updated install — which is the moment to show least, not most. Same
   * doctrine as the null profile: NULL IS A NO.
   */
  function allowed() {
    const rule = window.BlazingSettings
      && window.BlazingSettings.core
      && window.BlazingSettings.core.grownUp;
    if (typeof rule !== 'function') return false;
    return rule(state.profile) === true;
  }

  /* ── the wire ─────────────────────────────────────────────────────────── */

  async function getJson(url, timeoutMs) {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(timeoutMs),
        mode: 'cors',
        credentials: 'omit',
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) return null;
      return await response.json();
    } catch {
      // A dead feed is a MESSAGE, not a thrown page. render() tells the reader.
      return null;
    }
  }

  function plainText(value, fallback = '') {
    if (typeof value !== 'string') return fallback;
    const trimmed = value.trim();
    return trimmed || fallback;
  }

  function clip(text, limit) {
    const flat = plainText(String(text || '').replace(/\s+/g, ' '));
    return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
  }

  /**
   * "https://x/manifest.json" -> "https://x". Anything that is not an http URL
   * answers empty and is dropped, which is the Roku's `AddonBaseFromManifestUrl`
   * exactly (and tvOS's `StremioDirectory.base(fromManifestURL:)`).
   */
  function baseFromManifestUrl(value) {
    let url = plainText(value);
    if (url.endsWith('/manifest.json')) url = url.slice(0, -'/manifest.json'.length);
    if (url.endsWith('/')) url = url.slice(0, -1);
    return url.startsWith('http') ? url : '';
  }

  /**
   * `resources` is a MIX of plain strings and {name, types} objects in the live
   * feed, which is why it is read by hand. tvOS decodes it the same way and says
   * why: a strict [String] throws on the first object form and takes the whole
   * catalogue with it.
   */
  function resourceNames(resources) {
    if (!Array.isArray(resources)) return [];
    return resources
      .map((entry) => (typeof entry === 'string' ? entry : plainText(entry && entry.name)))
      .filter(Boolean);
  }

  /** The Roku's `RowMeta`, minus the INSTALLED tag it has no meaning for here. */
  function rowMeta(addon) {
    const bits = [];
    if (addon.hasStreams) bits.push('streams');
    if (addon.hasCatalogs) bits.push('catalogs');
    if (addon.needsConfig) bits.push('needs setup');
    bits.push(addon.origin);
    return bits.join('  ·  ');
  }

  async function loadDirectory() {
    const out = [];
    const seen = new Set();
    for (const [url, origin] of FEEDS) {
      const answer = await getJson(url, DIRECTORY_TIMEOUT_MS);
      const entries = answer && Array.isArray(answer.addons) ? answer.addons : [];
      for (const entry of entries) {
        const manifest = entry && entry.manifest;
        if (!manifest || typeof manifest !== 'object') continue;
        const base = baseFromManifestUrl(entry.transportUrl);
        if (!base || seen.has(base)) continue;
        seen.add(base);
        const names = resourceNames(manifest.resources);
        out.push({
          name: plainText(manifest.name, base),
          description: clip(manifest.description, 260),
          base,
          types: (Array.isArray(manifest.types) ? manifest.types : [])
            .map((type) => plainText(type)).filter(Boolean).slice(0, 4).join(' · '),
          hasStreams: names.includes('stream'),
          hasCatalogs: names.includes('catalog'),
          /* Two thirds of the community list are like this. A bare manifest URL
             is not a working add-on: an indexer with no debrid key answers with
             raw infoHash values, and nothing in this house has a torrent client
             to give them to. */
          needsConfig: Boolean(manifest.behaviorHints && manifest.behaviorHints.configurationRequired === true),
          origin,
        });
      }
    }
    return out;
  }

  async function load() {
    if (state.loading) return;
    state.loading = true;
    // Both at once — they are different origins and neither waits on the other.
    const [aggregator, addons] = await Promise.all([
      getJson(`${ADDON_BASE}/manifest.json`, MANIFEST_TIMEOUT_MS),
      loadDirectory(),
    ]);
    state.loading = false;
    state.aggregator = aggregator && typeof aggregator === 'object' ? aggregator : null;
    state.addons = addons;
    state.failed = addons.length === 0;
    state.focused = addons.length ? addons[0].base : '';
    render();
  }

  /* ── the screen ─────────────────────────────────────────────────────────── */

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function host() { return document.getElementById('sources-host'); }

  function statusLine(parent, id, message, tone = 'info') {
    const line = element('p', 'sources-note', message);
    line.id = id;
    line.dataset.tone = tone;
    line.setAttribute('role', 'status');
    parent.append(line);
    return line;
  }

  /** The aggregator card — what this browser ACTUALLY uses, above the directory
      rather than below it, because it is the answer to the question the
      screen's name asks. tvOS puts it in the same place for the same reason. */
  function aggregatorCard(parent) {
    const card = element('section', 'sources-card');
    card.id = 'sources-aggregator';
    card.append(element('p', 'sources-eyebrow', 'THIS BROWSER'));
    card.append(element('h2', 'sources-card-title',
      plainText(state.aggregator && state.aggregator.name, 'Blazing aggregator')));
    card.append(element('p', 'sources-card-base', ADDON_BASE));
    card.append(element('p', 'sources-card-copy', state.aggregator
      ? plainText(state.aggregator.description, 'The aggregator did not describe itself.')
      : 'Asking the aggregator what it queries…'));
    const catalogues = state.aggregator && Array.isArray(state.aggregator.catalogs)
      ? state.aggregator.catalogs.length : 0;
    const types = state.aggregator && Array.isArray(state.aggregator.types)
      ? state.aggregator.types.map((type) => plainText(type)).filter(Boolean).join(' · ') : '';
    if (catalogues) {
      card.append(element('p', 'sources-card-meta',
        `${catalogues} catalogue${catalogues === 1 ? '' : 's'}${types ? `   ·   ${types}` : ''}`));
    }
    parent.append(card);
  }

  /**
   * One row. A <button> WITH NO WRITE ACTION, and that is the point rather than
   * an omission — see the note at the head of this file. It selects itself so
   * the panel beside it fills in, which is the same thing tvOS's empty-action
   * Button does on focus, and it is the whole of what pressing a row can mean
   * in a client that installs nothing.
   */
  function sourceRow(parent, addon) {
    const button = element('button', 'sources-row');
    button.type = 'button';
    button.dataset.base = addon.base;
    button.setAttribute('aria-pressed', addon.base === state.focused ? 'true' : 'false');
    button.append(element('span', 'sources-row-name', addon.name));
    button.append(element('span', 'sources-row-meta', rowMeta(addon)));
    const show = () => select(addon.base);
    button.addEventListener('click', show);
    // Focus as well as click, so a keyboard or a D-pad fills the panel by
    // arriving on a row rather than by pressing it. That is tvOS's behaviour
    // (onChange(of: focused)), and on a webOS or Tizen television running this
    // same file it is the ONLY way the panel ever fills.
    button.addEventListener('focus', show);
    parent.append(button);
  }

  /**
   * Move the panel onto one add-on WITHOUT rebuilding the list.
   *
   * Deliberately not a render(). render() does replaceChildren() on the host,
   * and `show` above is wired to `focus` — so a full rebuild would tear the
   * element out from under the very focus event that asked for it, then have to
   * put focus back by hand, inside the handler. That is re-entrant and it is
   * the kind of thing that works in one browser and does not in the other,
   * which this repo's CI is built to punish. Only two things actually change
   * when a selection moves: which row is pressed, and what the panel says.
   */
  function select(base) {
    if (state.focused === base) return;
    state.focused = base;
    const root = host();
    if (!root) return;
    root.querySelectorAll('.sources-row').forEach((row) => {
      row.setAttribute('aria-pressed', row.dataset.base === state.focused ? 'true' : 'false');
    });
    const panel = document.getElementById('sources-detail');
    if (panel) panel.replaceWith(buildDetailPanel());
  }

  function buildDetailPanel() {
    const panel = element('aside', 'sources-detail');
    panel.id = 'sources-detail';
    const addon = (state.addons || []).find((entry) => entry.base === state.focused);
    if (addon) {
      panel.append(element('h2', 'sources-detail-title', addon.name));
      panel.append(element('p', 'sources-detail-meta', rowMeta(addon)));
      if (addon.types) panel.append(element('p', 'sources-detail-meta', addon.types));
      panel.append(element('p', 'sources-detail-copy', addon.description || addon.base));
      panel.append(element('p', 'sources-detail-copy',
        addon.needsConfig ? NEEDS_SETUP_NOTE : READY_NOTE));
    }
    // THE HONEST FOOTER, and both sentences are load-bearing. See the constants.
    const footer = element('div', 'sources-footer');
    footer.id = 'sources-footer';
    footer.append(element('p', 'sources-footer-line', FOOTER_SHARED));
    footer.append(element('p', 'sources-footer-line', FOOTER_WEB));
    panel.append(footer);
    return panel;
  }

  /**
   * Rebuilt whole on every change, the same promise settings.js's render()
   * makes: nothing on this screen can drift from what was actually fetched.
   *
   * Focus is restored by the row's own BASE rather than by index, because the
   * list is rebuilt from two feeds and an index means a different add-on the
   * moment either feed changes length.
   */
  function render() {
    const root = host();
    if (!root) return;
    const active = document.activeElement;
    const hadFocus = active && root.contains(active) && active.dataset
      ? (active.dataset.base || '') : '';
    root.replaceChildren();

    /* THE GATE, before anything is fetched or drawn. Mirrors settings.js:468-483
       — one line saying so, rather than the content. */
    if (!allowed()) {
      statusLine(root, 'sources-gate',
        state.profile ? GATE_CAPPED : GATE_NO_PROFILE, 'empty');
      return;
    }

    const status = state.addons === null
      ? 'Loading the add-on directory…'
      : state.failed
        ? DEAD_DIRECTORY
        : `${state.addons.length} add-on${state.addons.length === 1 ? '' : 's'} in the Stremio directory`;
    statusLine(root, 'sources-status', status, state.failed ? 'error' : 'info');
    statusLine(root, 'sources-readonly', 'Read only in this browser.', 'empty');

    const layout = element('div', 'sources-layout');
    const list = element('div', 'sources-list');
    list.id = 'sources-list';
    aggregatorCard(list);
    list.append(element('p', 'sources-eyebrow sources-list-heading', 'STREMIO ADD-ON DIRECTORY'));
    /* A DEAD FEED MUST NOT READ AS "no sources". An empty list under a heading
       is the silent no-op this whole audit exists to catch, so the failure gets
       a sentence of its own right where the rows would have been. */
    if (state.failed) statusLine(list, 'sources-empty', DEAD_DIRECTORY, 'error');
    else for (const addon of state.addons || []) sourceRow(list, addon);
    layout.append(list);
    layout.append(buildDetailPanel());
    root.append(layout);

    if (hadFocus) {
      const again = list.querySelector(`.sources-row[data-base="${CSS.escape(hadFocus)}"]`);
      if (again && typeof again.focus === 'function') again.focus();
    }
  }

  /* ── the drawer row ──────────────────────────────────────────────────────
   *
   * HIDDEN, NOT REMOVED, and the difference is deliberate. `[hidden]` is
   * `display: none !important` (styles.css:117), so a capped profile is offered
   * no row it can see, tab to, or read out — which is the requirement. Taking
   * the node OUT of the drawer would additionally make the drawer's LENGTH
   * depend on who is watching, and navparity.smoke.mjs counts
   * `.drawer-nav [data-view]` against its own list of destinations. A count that
   * changes with the profile is a count that goes red for the wrong reason on
   * whichever profile a future fixture happens to pick.
   *
   * Hiding the row is not the gate on its own. render() re-checks allowed()
   * every time, so typing the route by hand reaches the refusal, not the list.
   */
  function syncDrawerRow() {
    const row = document.querySelector('.drawer-nav [data-view="sources"]');
    if (row) row.hidden = !allowed();
  }

  /** The directory is asked for ONCE, and only for somebody allowed to see it. */
  function maybeLoad() {
    if (!allowed()) return;
    if (state.addons === null && !state.loading) load();
  }

  function onScreen() {
    const view = document.getElementById('sources-view');
    return Boolean(view) && view.hidden === false;
  }

  function adoptProfile(detail) {
    const id = detail && detail.id ? String(detail.id) : '';
    state.profile = id ? {
      id,
      name: String(detail.name || 'Profile'),
      isKids: detail.isKids === true,
      maxRating: String(detail.maxRating || 'general'),
      allowAdult: detail.allowAdult === true,
    } : null;
    syncDrawerRow();
    if (!state.mounted) return;
    render();
    /* A viewer can be LOOKING AT this screen when the profile changes — the
       header's profile switch does not re-run the router — so a gate that has
       just opened has to fetch from here too. Without this the screen sits on
       "Loading the add-on directory…" for ever with nothing in flight, which is
       the silent no-op in its most convincing form: a status line that is not
       lying about anything except the future. Scoped to the view being on
       screen, so switching profiles anywhere else costs no requests. */
    if (onScreen()) maybeLoad();
  }

  document.addEventListener('blazing-profile-selected', (event) => {
    adoptProfile((event && event.detail) || {});
  });
  document.addEventListener('blazing-profile-signed-out', () => adoptProfile(null));

  /* Nobody has connected a profile when this file runs, so the row starts
     hidden and the first broadcast is what reveals it. Deferred to the next
     task so settings.js's IIFE has published `core` whatever the script order
     ends up being. */
  setTimeout(syncDrawerRow, 0);

  /**
   * Mounted on EVERY visit, not once, for the same reason Settings is: the gate
   * depends on the connected profile and a profile can change in another tab.
   * The FETCH happens once — the directory is the same two documents whoever is
   * watching, and it is not re-asked for a re-render.
   */
  function mount() {
    state.mounted = true;
    render();
    maybeLoad();
  }

  window.BlazingSources = { mount };
})();
