/* Blazing web Settings — the screen this client did not have at all.
 *
 * PARITY SOURCE, read line by line rather than invented here:
 *   firetv  client/app/src/main/java/com/nyctailblazers/blazingtv/MainActivity.kt
 *           :207-300  buildPlaybackForm/rebuildPlaybackForm — the cycle-on-press
 *                     rows and their exact labels
 *           :333-386  buildAddonForm — the add-on URL field, its two buttons and
 *                     the "follows your account" note
 *           :137-200  buildLiveTvSourceForm — the M3U / Xtream playlist form
 *   firetv  SourceFilters.kt:41-43 — HEIGHT_LADDER / SEEDER_LADDER / SIZE_LADDER
 *   roku    source/lib/SourceFilter.brs — SourceFilterReject's vocabulary
 *           ("seeders" / "size" / "res" / "codec" / "uncached" / "lang"),
 *           "UNKNOWN IS NOT REJECTED", and AutoNextEnabled's DEFAULT ON
 *   roku    components/screens/SettingsScreen.brs:45-158 — the row order
 *
 * The labels are copied, not paraphrased. Markus: "roku, web, and firestick
 * should all feel like im using the same app no matter what." A row that says
 * "Minimum quality: 1080p" on a Fire TV must not say "Quality floor: HD" here.
 *
 * DELIBERATELY NOT COPIED: Roku's SettingsScreen.brs:345-427 dispatch shape.
 * It switches on hard-coded row indices and its own comment at :119-132 calls
 * that a defect — inserting a row renumbers every row below it. Every row here
 * carries its own handler.
 *
 * WIRE CONTRACT (fleet.lyreosai.com):
 *   GET/PUT/DELETE /account/secret/stremio_addon_url  — the household's add-on
 *       list. GET answers {present, value}; PUT takes {value}. Reached through
 *       window.BlazingProfile.accountSecret(), which owns the device credential.
 *   POST /device/live/sources {kind,name,url,username,password}  — the same
 *       route firetv LiveClient.kt:228 posts to.
 *
 * EVERYTHING ELSE IS LOCAL. The source filters are this browser's taste, not
 * the household's rule, exactly as they are on the Roku (a registry key) and on
 * the Fire TV (SharedPreferences). They are not synced and must not be: a
 * filter is not a parental control, and the parental controls live in
 * profile.js where the PIN is.
 */
'use strict';

(() => {
  const FLEET_BASE = window.BLAZING_FLEET_BASE || 'https://fleet.lyreosai.com';
  const ADDON_BASE = window.BLAZING_API_BASE || 'https://addon.lyreosai.com';

  const FILTER_KEY = 'blazing-source-filters-v1';
  const AUTO_NEXT_KEY = 'blazing-auto-next-episode-v1';
  const STRIP_SDH_KEY = 'blazing-hide-sdh-v1';

  /** The only account secret this screen is allowed to name. */
  const ADDON_SECRET = 'stremio_addon_url';

  // firetv SourceFilters.kt:41-43, value for value.
  const HEIGHT_LADDER = Object.freeze([0, 720, 1080, 2160]);
  const SEEDER_LADDER = Object.freeze([0, 5, 10, 20, 50]);
  const SIZE_LADDER = Object.freeze([0, 2, 5, 10, 20]);

  const RATINGS = Object.freeze(['general', 'teen', 'mature', 'adult']);

  /* Defaults are all-off, the same promise roku SourceFilter.brs makes in its
     header: "A fresh install behaves exactly as it did before this file
     existed." Auto-next is the one exception and it is ON — see autoNext(). */
  const DEFAULTS = Object.freeze({
    minHeight: 0,
    minSeeders: 0,
    maxSizeGb: 0,
    noUncached: false,
    noHevc: false,
    noAv1: false,
    no3d: false,
    noForeign: false,
  });

  // firetv SourceFilters.kt:155-170, transcribed.
  const HEVC = /\b(?:hevc|h\.?265|x265)\b/i;
  const AV1 = /\bav1\b/i;
  const THREE_D = /\b(?:h-?sbs|half[ .-]?sbs|full[ .-]?sbs|sbs3d|3d[ .-]?sbs|h-?ou|half[ .-]?ou|over[ .-]?under|anaglyph|3d[ .-]?bluray|bluray[ .-]?3d)\b/i;
  const FOREIGN = /\b(?:dublado|dual[ .-]?audio|hindi|tamil|telugu|russian|castellano|espa[nñ]ol|latino|fr(?:ench|ench dub)|german|italian|polski|lektor|t[uü]rk[cç]e|dubbed)\b/i;

  /* A debrid service that HOLDS the file tags its row [RD+] / [TB+]; one that
     would have to fetch it first tags [RD download]. roku StreamRanker.brs:642
     turns the same two facts into "cached" / "uncached", and "instant sources
     only" is the viewer asking for anything but the second. */
  const DEBRID_CACHED = /\[(?:rd|tb|ad|pm)\s*\+\]/i;
  const DEBRID_SLOW = /\[(?:rd|tb|ad|pm)\s*(?:download|slow)\]|\buncached\b|⏳/i;

  /* SDH markers on a SUBTITLE TRACK LABEL. Fire TV's stripSdh rewrites the text
     of an external .srt (SubtitleFilter.kt:74); this client fetches no external
     subtitle files at all — grep '/subtitles/' in this repo finds nothing — so
     there is no furniture here to strip. The honest same-intent control on the
     web is "do not offer me, and never auto-pick, the hearing-impaired track",
     which is what stream-preferences.js does with this. */
  const SDH_LABEL = /\b(?:sdh|hi|cc)\b|hearing[ -]?impaired|\[cc\]/i;

  const clampInt = (value, ladder) => {
    const n = Math.trunc(Number(value));
    return ladder.includes(n) ? n : ladder[0];
  };

  /** Field by field, never a wholesale replace — roku SourceFilter.brs:48-58's
   *  reason holds here too: a blob written by an older build is missing keys. */
  function normalize(value) {
    const source = (value && typeof value === 'object') ? value : {};
    return {
      minHeight: clampInt(source.minHeight, HEIGHT_LADDER),
      minSeeders: clampInt(source.minSeeders, SEEDER_LADDER),
      maxSizeGb: clampInt(source.maxSizeGb, SIZE_LADDER),
      noUncached: source.noUncached === true,
      noHevc: source.noHevc === true,
      noAv1: source.noAv1 === true,
      no3d: source.no3d === true,
      noForeign: source.noForeign === true,
    };
  }

  function readStore(key) {
    try { return localStorage.getItem(key); } catch { return null; }
  }

  function writeStore(key, value) {
    try { localStorage.setItem(key, value); return true; } catch { return false; }
  }

  let filters = normalize(null);
  try { filters = normalize(JSON.parse(readStore(FILTER_KEY) || 'null')); } catch { filters = normalize(null); }

  const CHANGE = 'blazing-settings-changed';

  function announce() {
    document.dispatchEvent(new CustomEvent(CHANGE, { detail: { filters: { ...filters } } }));
  }

  function saveFilters(change) {
    filters = normalize({ ...filters, ...change });
    writeStore(FILTER_KEY, JSON.stringify(filters));
    announce();
  }

  /* DEFAULT ON, and roku SourceFilter.brs:155-162 says why in Markus's own
     words: "Auto-play next episode: we really need this" — a feature that has
     to be found in Settings before it works is a feature nobody has. Stored as
     the same '1'/'0' the Roku registry holds. */
  const autoNext = () => readStore(AUTO_NEXT_KEY) !== '0';
  function setAutoNext(on) { writeStore(AUTO_NEXT_KEY, on ? '1' : '0'); announce(); }

  /* Defaults OFF: for a viewer who needs SDH, hiding it is the bug.
     firetv SourceFilters.kt:94-104, same reasoning, same default. */
  const hideSdh = () => readStore(STRIP_SDH_KEY) === '1';
  function setHideSdh(on) { writeStore(STRIP_SDH_KEY, on ? '1' : '0'); announce(); }

  /** The next rung, wrapping back to Off. firetv MainActivity.kt:228-231. */
  function nextRung(current, ladder) {
    const index = ladder.indexOf(Math.trunc(Number(current)));
    return (index < 0 || index + 1 >= ladder.length) ? ladder[0] : ladder[index + 1];
  }

  const onOff = (value) => (value ? 'On' : 'Off');
  const offOr = (n, suffix) => (n <= 0 ? 'Off' : `${n}${suffix}`);
  const minHeightLabel = (h) => (h >= 2160 ? '4K' : h > 0 ? `${h}p` : 'Off');

  /** How quickly this row can start, in roku StreamRanker.brs:642's vocabulary. */
  function startKind(info) {
    const blob = String((info && info.blob) || '').toLowerCase();
    if (DEBRID_SLOW.test(blob)) return 'uncached';
    // Only a hash: it still has to go through debrid when it is picked, and it
    // carries no promise of starting quickly.
    if (!info || !info.url) return 'uncached';
    if (DEBRID_CACHED.test(blob) || (info.infoHash && String(info.infoHash))) return 'cached';
    return 'direct';
  }

  /* The minimum a stream has to be described by for [reject] to judge it. Used
     only when caps.js did not load: its parseStream() produces a richer version
     of exactly this shape and is preferred wherever it is available, so the two
     can never disagree about a browser that has both. */
  function describe(raw) {
    const name = String((raw && raw.name) || '');
    const title = String((raw && raw.title) || (raw && raw.description) || '');
    const blob = `${name} ${title}`.toLowerCase();
    const height = (() => {
      if (/\b(?:2160p?|4k|uhd)\b/i.test(blob)) return 2160;
      if (/\b1080p?\b/i.test(blob)) return 1080;
      if (/\b720p?\b/i.test(blob)) return 720;
      if (/\b480p?\b/i.test(blob)) return 480;
      return 0;
    })();
    const sizeMatch = blob.match(/(\d+(?:[.,]\d+)?)\s*(gb|mb)\b/i);
    const sizeGb = sizeMatch
      ? (/mb/i.test(sizeMatch[2]) ? Number(sizeMatch[1].replace(',', '.')) / 1024 : Number(sizeMatch[1].replace(',', '.')))
      : 0;
    const seedMatch = blob.match(/(?:👤|👥|s:|seeders?:?)\s*(\d+)/i);
    return {
      raw,
      url: (raw && typeof raw.url === 'string') ? raw.url : '',
      infoHash: (raw && raw.infoHash) || '',
      blob,
      height,
      codec: HEVC.test(blob) ? 'hevc' : AV1.test(blob) ? 'av1' : '',
      sizeGb: Number.isFinite(sizeGb) ? sizeGb : 0,
      seeders: seedMatch ? Number(seedMatch[1]) : 0,
      foreign: FOREIGN.test(blob),
    };
  }

  /**
   * '' when the viewer is happy with this stream, otherwise the reason.
   *
   * UNKNOWN IS NOT REJECTED — roku SourceFilter.brs:93-97 verbatim: "Half of all
   * release names carry no size and most carry no seeder count... Treating 0 as
   * 'fails the minimum' would empty the list for anyone who sets a filter at
   * all, and it would do it silently. A filter can only remove what it can
   * actually see."
   */
  function reject(info, value = filters) {
    if (!info) return '';
    const f = normalize(value);
    const blob = String(info.blob || `${info.name || ''} ${info.title || ''}`).toLowerCase();
    const seeders = Number(info.seeders) || 0;
    const sizeGb = Number(info.sizeGb) || 0;
    const height = Number(info.height) || 0;
    const codec = String(info.codec || '').toLowerCase();

    if (f.minSeeders > 0 && seeders > 0 && seeders < f.minSeeders) return 'seeders';
    if (f.maxSizeGb > 0 && sizeGb > 0 && sizeGb > f.maxSizeGb) return 'size';
    if (f.minHeight > 0 && height > 0 && height < f.minHeight) return 'res';
    if (f.noHevc && (codec === 'hevc' || HEVC.test(blob))) return 'codec';
    if (f.noAv1 && (codec === 'av1' || AV1.test(blob))) return 'codec';
    if (f.no3d && THREE_D.test(blob)) return '3d';
    if (f.noUncached && startKind({ ...info, blob }) === 'uncached') return 'uncached';
    if (f.noForeign && (info.foreign === true || FOREIGN.test(blob))) return 'lang';
    return '';
  }

  /** True when at least one filter is on, so the caller can skip the per-row work. */
  function active(value = filters) {
    const f = normalize(value);
    return f.minSeeders > 0 || f.maxSizeGb > 0 || f.minHeight > 0
      || f.noUncached || f.noHevc || f.noAv1 || f.no3d || f.noForeign;
  }

  /** One line naming what is on. roku SourceFilter.brs:130-149, same words. */
  function summary(value = filters) {
    const f = normalize(value);
    if (!active(f)) return 'Off';
    const parts = [];
    if (f.minHeight > 0) parts.push(`${f.minHeight}p+`);
    if (f.minSeeders > 0) parts.push(`${f.minSeeders}+ seeders`);
    if (f.maxSizeGb > 0) parts.push(`under ${f.maxSizeGb} GB`);
    if (f.noUncached) parts.push('instant only');
    if (f.noHevc) parts.push('no HEVC');
    if (f.noAv1) parts.push('no AV1');
    if (f.no3d) parts.push('no 3D');
    if (f.noForeign) parts.push('English audio');
    return parts.join(',  ');
  }

  /**
   * Drop what the VIEWER does not want from a list caps.js has already ranked.
   *
   * Takes and returns the ranked `info` objects, NOT raw streams, so the caller
   * keeps the ordering the device probe produced. It answers with a count per
   * reason because the source list says out loud how many rows it removed —
   * a list that silently shrinks from 400 to 12 reads as a broken back end.
   */
  function filterInfos(infos, value = filters) {
    const f = normalize(value);
    const dropped = { total: 0 };
    if (!active(f) || !Array.isArray(infos)) return { infos: Array.isArray(infos) ? infos : [], dropped };
    const kept = [];
    for (const info of infos) {
      const why = reject(info, f);
      if (!why) { kept.push(info); continue; }
      dropped[why] = (dropped[why] || 0) + 1;
      dropped.total += 1;
    }
    return { infos: kept, dropped };
  }

  /** The same question of a list of RAW streams, for the no-caps.js fallback. */
  function filterStreams(streams, value = filters) {
    const f = normalize(value);
    if (!active(f) || !Array.isArray(streams)) return { streams: Array.isArray(streams) ? streams : [], dropped: { total: 0 } };
    const result = filterInfos(streams.map(describe), f);
    return { streams: result.infos.map((info) => info.raw), dropped: result.dropped };
  }

  const DROP_WORDS = Object.freeze({
    seeders: 'too few seeders', size: 'too large', res: 'below your quality floor',
    codec: 'a codec you skip', uncached: 'not instant', '3d': '3D', lang: 'not English audio',
  });

  /** "12 sources hidden by your settings (too large, not instant)." */
  function droppedNote(dropped) {
    if (!dropped || !dropped.total) return '';
    const why = Object.keys(DROP_WORDS).filter((key) => dropped[key]).map((key) => DROP_WORDS[key]);
    return `${dropped.total} source${dropped.total === 1 ? '' : 's'} hidden by your settings`
      + (why.length ? ` (${why.join(', ')}).` : '.');
  }

  /**
   * True when the label is a hearing-impaired track. Exported because
   * stream-preferences.js owns the track list and asks this per label.
   */
  const isSdhLabel = (label) => SDH_LABEL.test(String(label || ''));

  /* ── who may change where content comes from ─────────────────────────────
   *
   * B13. On the Fire TV a capped profile is bounced out of the add-on store
   * (AddonStoreActivity.kt:50) and can then walk into Settings and retype the
   * add-on URL, which syncs to the ACCOUNT and follows every approved device in
   * the house. This client is being given that same screen today, so it gets
   * the gate at the same time rather than shipping the hole first.
   *
   * The rule is firetv ProfileGateRules.grownUp(): not a Kids profile, and
   * rated at least 'mature'. NULL IS A NO — no profile means least is known
   * about who is holding the keyboard, which is the moment to show least.
   */
  function ratingAllows(cap, tier) {
    const capIndex = RATINGS.indexOf(String(cap || '').toLowerCase());
    if (capIndex < 0) return false;
    const tierIndex = RATINGS.indexOf(String(tier || '').toLowerCase());
    if (tierIndex < 0) return false;
    return tierIndex <= capIndex;
  }

  function grownUp(profile) {
    if (!profile || typeof profile !== 'object') return false;
    if (profile.isKids === true) return false;
    return ratingAllows(profile.maxRating, 'mature');
  }

  /* ── the screen ──────────────────────────────────────────────────────────── */

  const state = {
    mounted: false,
    profile: null,
    addonValue: '',
    addonLoaded: false,
  };

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function sectionTitle(host, label) {
    host.append(element('h2', 'settings-section', label));
  }

  /**
   * A row that CYCLES on press. firetv MainActivity.kt:207-216 explains the
   * shape: "A television remote cannot type a number, so each row steps through
   * the short ladder of values people actually pick and wraps back to Off."
   * The web keeps it because this same file is what a webOS and a Tizen TV run,
   * where the only input is a D-pad — and because a mouse loses nothing.
   */
  function row(host, label, onPress, { disabled = false } = {}) {
    const button = element('button', 'settings-row', label);
    button.type = 'button';
    button.disabled = disabled;
    button.addEventListener('click', () => { onPress(); render(); });
    host.append(button);
    return button;
  }

  function statusLine(host, id, message, tone = 'info') {
    const line = element('p', 'settings-note', message);
    line.id = id;
    line.dataset.tone = tone;
    line.setAttribute('role', 'status');
    host.append(line);
    return line;
  }

  function setTone(node, message, tone) {
    if (!node) return;
    node.textContent = message;
    node.dataset.tone = tone;
  }

  function host() { return document.getElementById('settings-host'); }

  /**
   * Rebuilt whole on every press, so a label can never drift from what is
   * actually stored — the same promise rebuildPlaybackForm makes
   * (MainActivity.kt:217-218) and the same one buildButtons makes on the Roku
   * (SettingsScreen.brs:42-44).
   *
   * Focus is restored by the row's own id rather than by index: the add-on and
   * playlist sections appear and disappear with the profile, so an index
   * remembered before a profile switch points at a different control after it.
   */
  function render() {
    const root = host();
    if (!root) return;
    const focusedId = document.activeElement && root.contains(document.activeElement)
      ? document.activeElement.id : '';
    root.replaceChildren();

    /* ── Playback and sources ── firetv MainActivity.kt:234-283, in order ── */
    sectionTitle(root, 'Playback and sources');
    const f = filters;
    row(root, `Play next episode automatically: ${onOff(autoNext())}`, () => setAutoNext(!autoNext()))
      .id = 'settings-auto-next';
    row(root, `Minimum quality: ${minHeightLabel(f.minHeight)}`, () => saveFilters({ minHeight: nextRung(f.minHeight, HEIGHT_LADDER) }))
      .id = 'settings-min-height';
    row(root, `Minimum seeders: ${offOr(f.minSeeders, '')}`, () => saveFilters({ minSeeders: nextRung(f.minSeeders, SEEDER_LADDER) }))
      .id = 'settings-min-seeders';
    row(root, `Maximum size: ${offOr(f.maxSizeGb, ' GB')}`, () => saveFilters({ maxSizeGb: nextRung(f.maxSizeGb, SIZE_LADDER) }))
      .id = 'settings-max-size';
    row(root, `Instant sources only: ${onOff(f.noUncached)}`, () => saveFilters({ noUncached: !f.noUncached }))
      .id = 'settings-no-uncached';
    row(root, `Skip HEVC / H.265: ${onOff(f.noHevc)}`, () => saveFilters({ noHevc: !f.noHevc }))
      .id = 'settings-no-hevc';
    row(root, `Skip AV1: ${onOff(f.noAv1)}`, () => saveFilters({ noAv1: !f.noAv1 }))
      .id = 'settings-no-av1';
    row(root, `Skip 3D releases: ${onOff(f.no3d)}`, () => saveFilters({ no3d: !f.no3d }))
      .id = 'settings-no-3d';
    row(root, `Hide SDH captions: ${onOff(hideSdh())}`, () => setHideSdh(!hideSdh()))
      .id = 'settings-hide-sdh';
    row(root, `English audio only: ${onOff(f.noForeign)}`, () => saveFilters({ noForeign: !f.noForeign }))
      .id = 'settings-no-foreign';
    statusLine(root, 'settings-filter-summary', `Source filters: ${summary(f)}`, 'info');

    /* ── Language ── the two selects that used to exist ONLY on the detail
       sheet (stream-preferences.js:61-62). They stay there as well: the detail
       sheet is where a viewer changes their mind about one title, and this is
       where they set the house default. Same module, same storage, so the two
       can never disagree. ── */
    sectionTitle(root, 'Language');
    const languageHost = element('div', 'settings-language');
    languageHost.id = 'settings-language';
    root.append(languageHost);
    const mountLanguage = window.BlazingStreamPreferences && window.BlazingStreamPreferences.mountSettings;
    if (mountLanguage) mountLanguage(languageHost);
    if (!state.profile) {
      statusLine(root, 'settings-language-note', 'Choose a profile to set audio and subtitle languages.', 'empty');
    }

    /* ── Profile ── the way to the parental controls, which live in the gate
       (profile.js) where the PIN pad and the unlock token already are. ── */
    sectionTitle(root, 'Profile');
    const parental = element('button', 'settings-row', state.profile
      ? `Parental controls for ${state.profile.name}`
      : 'Parental controls');
    parental.type = 'button';
    parental.id = 'settings-parental';
    parental.addEventListener('click', () => {
      if (window.BlazingProfile && window.BlazingProfile.openParental) {
        window.BlazingProfile.openParental(state.profile ? state.profile.id : '');
      } else if (window.BlazingProfile && window.BlazingProfile.open) {
        window.BlazingProfile.open();
      }
    });
    root.append(parental);
    const switchProfile = element('button', 'settings-row', 'Switch profile');
    switchProfile.type = 'button';
    switchProfile.id = 'settings-switch-profile';
    switchProfile.addEventListener('click', () => window.BlazingProfile && window.BlazingProfile.open && window.BlazingProfile.open());
    root.append(switchProfile);

    /* ── Where content comes from ── B13's gate. Drawn at all only for a
       grown-up profile; for anyone else the section is one sentence saying so,
       in the same words the Fire TV toast uses. ── */
    sectionTitle(root, 'Where content comes from');
    if (!grownUp(state.profile)) {
      statusLine(
        root,
        'settings-sources-gate',
        state.profile
          ? `This profile's rating limit hides Sources.`
          : 'Choose a profile to change where content comes from.',
        'empty',
      );
    } else {
      renderAddonForm(root);
      renderPlaylistForm(root);
    }

    /* ── About ── tvOS keeps its four read-only fields below the controls
       (Sections.swift:516-519) and that is the right place for them. ── */
    sectionTitle(root, 'About');
    const about = element('dl', 'settings-about');
    [
      ['Profile', state.profile ? state.profile.name : 'None chosen'],
      ['Rating limit', state.profile ? String(state.profile.maxRating || 'general') : '—'],
      ['Fleet', FLEET_BASE],
      ['Sources', ADDON_BASE],
    ].forEach(([term, value]) => {
      about.append(element('dt', '', term), element('dd', '', value));
    });
    root.append(about);

    if (focusedId) {
      const again = root.querySelector(`#${CSS.escape(focusedId)}`);
      if (again && typeof again.focus === 'function') again.focus();
    }
  }

  /** firetv MainActivity.kt:333-386 — field, Save and sync, Use default, note. */
  function renderAddonForm(root) {
    const field = document.createElement('input');
    field.type = 'url';
    field.id = 'settings-addon-url';
    field.className = 'settings-input';
    field.placeholder = 'HTTPS add-on URL';
    field.spellcheck = false;
    field.setAttribute('aria-label', 'HTTPS add-on URL');
    field.value = state.addonValue;
    root.append(field);

    const actions = element('div', 'settings-actions');
    const save = element('button', 'primary-button', 'Save and sync');
    save.type = 'button';
    save.id = 'settings-addon-save';
    const reset = element('button', 'secondary-button', 'Use default');
    reset.type = 'button';
    reset.id = 'settings-addon-reset';
    actions.append(save, reset);
    root.append(actions);

    const note = statusLine(root, 'settings-addon-note',
      'This add-on follows your account on every approved device.', 'empty');

    const secret = window.BlazingProfile && window.BlazingProfile.accountSecret;
    if (!secret) {
      setTone(note, 'The profile server is not connected in this browser yet.', 'error');
      save.disabled = true;
      reset.disabled = true;
      return;
    }

    if (!state.addonLoaded) {
      state.addonLoaded = true;
      setTone(note, 'Loading the add-on for your account…', 'loading');
      secret(ADDON_SECRET, { method: 'GET' }).then((result) => {
        if (!result || !result.ok) {
          setTone(document.getElementById('settings-addon-note'),
            'Could not read the add-on for your account.', 'error');
          return;
        }
        state.addonValue = result.present ? String(result.value || '') : '';
        const live = document.getElementById('settings-addon-url');
        if (live) live.value = state.addonValue;
        setTone(document.getElementById('settings-addon-note'),
          'This add-on follows your account on every approved device.', 'empty');
      }).catch(() => {
        setTone(document.getElementById('settings-addon-note'),
          'Could not read the add-on for your account.', 'error');
      });
    }

    const normalizeUrl = (raw) => {
      // A comma-separated list is legal here and is how the house adds more
      // than one source at once — firetv AddonConfig.kt's header documents the
      // bug that came from treating the list as a single URL. Every entry must
      // be https, and every entry keeps its own /manifest.json.
      const parts = String(raw || '').split(',').map((part) => part.trim()).filter(Boolean);
      if (!parts.length) return '';
      for (const part of parts) {
        let url;
        try { url = new URL(part); } catch { return ''; }
        if (url.protocol !== 'https:') return '';
      }
      return parts.join(',');
    };

    save.addEventListener('click', () => {
      const value = normalizeUrl(field.value);
      if (!value) {
        setTone(note, 'Enter a valid HTTPS add-on URL.', 'error');
        return;
      }
      save.disabled = true;
      reset.disabled = true;
      setTone(note, 'Saving…', 'loading');
      secret(ADDON_SECRET, { method: 'PUT', value }).then((result) => {
        save.disabled = false;
        reset.disabled = false;
        if (!result || !result.ok) {
          setTone(note, (result && result.error) || 'Saved nowhere — the account did not accept it.', 'error');
          return;
        }
        state.addonValue = value;
        setTone(note, 'Saved on your account.', 'success');
      }).catch(() => {
        save.disabled = false;
        reset.disabled = false;
        setTone(note, 'Saved nowhere — the account did not accept it.', 'error');
      });
    });

    reset.addEventListener('click', () => {
      save.disabled = true;
      reset.disabled = true;
      setTone(note, 'Restoring the default…', 'loading');
      secret(ADDON_SECRET, { method: 'DELETE' }).then((result) => {
        save.disabled = false;
        reset.disabled = false;
        if (!result || !result.ok) {
          setTone(note, 'The account did not accept the reset.', 'error');
          return;
        }
        state.addonValue = '';
        field.value = '';
        setTone(note, 'Default add-on restored on every device.', 'success');
      }).catch(() => {
        save.disabled = false;
        reset.disabled = false;
        setTone(note, 'The account did not accept the reset.', 'error');
      });
    });
  }

  /**
   * firetv MainActivity.kt:137-200. Live TV ships with NO bundled providers and
   * NO credentials in the app — the viewer pastes their own M3U URL, or an
   * Xtream server URL with a user name and password.
   *
   * The password field is a real password field and its value never leaves this
   * function except in the POST body: it is not stored, not logged and not put
   * in the address.
   */
  function renderPlaylistForm(root) {
    sectionTitle(root, 'Add your Live TV playlist');
    const make = (id, placeholder, type = 'text') => {
      const node = document.createElement('input');
      node.type = type;
      node.id = id;
      node.className = 'settings-input';
      node.placeholder = placeholder;
      node.spellcheck = false;
      node.setAttribute('aria-label', placeholder);
      if (type === 'password') node.autocomplete = 'off';
      root.append(node);
      return node;
    };
    const name = make('settings-live-name', 'Playlist name');
    const url = make('settings-live-url', 'M3U URL, or Xtream server URL', 'url');
    const user = make('settings-live-user', 'Username (Xtream only)');
    const pass = make('settings-live-pass', 'Password (Xtream only)', 'password');

    const add = element('button', 'primary-button', 'Add playlist');
    add.type = 'button';
    add.id = 'settings-live-add';
    root.append(add);
    const note = statusLine(root, 'settings-live-note',
      'Add an M3U link, or an Xtream link with a user name and password.', 'empty');

    const post = window.BlazingProfile && window.BlazingProfile.addLiveSource;
    if (!post) {
      add.disabled = true;
      setTone(note, 'The profile server is not connected in this browser yet.', 'error');
      return;
    }

    add.addEventListener('click', () => {
      const link = url.value.trim();
      if (!link) {
        setTone(note, 'Enter a playlist URL first.', 'error');
        return;
      }
      const username = user.value.trim();
      const password = pass.value;
      const kind = (username && password) ? 'xtream' : 'm3u';
      add.disabled = true;
      setTone(note, 'Adding…', 'loading');
      post({
        kind,
        name: name.value.trim() || 'My Playlist',
        url: link,
        username: username || undefined,
        password: password || undefined,
      }).then((result) => {
        add.disabled = false;
        // Never leave the credential sitting in the DOM after it has been sent.
        pass.value = '';
        if (!result || !result.ok) {
          setTone(note, (result && result.error) || 'Could not add that playlist.', 'error');
          return;
        }
        setTone(note, 'Playlist added — it will appear in Live TV shortly.', 'success');
      }).catch(() => {
        add.disabled = false;
        pass.value = '';
        setTone(note, 'Could not add that playlist.', 'error');
      });
    });
  }

  document.addEventListener('blazing-profile-selected', (event) => {
    const detail = (event && event.detail) || {};
    if (!detail.id) return;
    state.profile = {
      id: String(detail.id),
      name: String(detail.name || 'Profile'),
      isKids: detail.isKids === true,
      maxRating: String(detail.maxRating || 'general'),
      allowAdult: detail.allowAdult === true,
    };
    // A different viewer may not be allowed to see the account's add-on at all.
    state.addonLoaded = false;
    state.addonValue = '';
    if (state.mounted) render();
  });

  document.addEventListener('blazing-profile-signed-out', () => {
    state.profile = null;
    state.addonLoaded = false;
    state.addonValue = '';
    if (state.mounted) render();
  });

  function mount() {
    state.mounted = true;
    render();
  }

  window.BlazingSettings = {
    mount,
    filters: () => ({ ...filters }),
    autoNext,
    setAutoNext,
    hideSdh,
    setHideSdh,
    isSdhLabel,
    filterInfos,
    filterStreams,
    droppedNote,
    summary,
    active,
    /* The pure half, exported for settings.test.mjs so the ladders, the
       rejection vocabulary and the grown-up gate are tested without a DOM. */
    core: Object.freeze({
      DEFAULTS, HEIGHT_LADDER, SEEDER_LADDER, SIZE_LADDER,
      normalize, nextRung, reject, active, summary, describe, startKind,
      grownUp, ratingAllows, minHeightLabel, offOr, onOff, isSdhLabel, droppedNote,
    }),
  };
})();
