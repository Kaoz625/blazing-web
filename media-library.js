/* Public books and audio, with one player and private per-profile progress. */
'use strict';
(() => {
  const KEY = 'blazing-media-progress-v1:';
  const KINDS = ['books', 'music', 'podcasts'];
  const copy = (value) => JSON.parse(JSON.stringify(value));
  const text = (value, length = 500) => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, length);
  const profileAllowed = (profile) => typeof profile?.id === 'string' && Boolean(profile.id)
    && profile.isKids !== true && ['mature', 'adult'].includes(profile.effectiveMaxRating || profile.maxRating);
  const httpsURL = (raw) => {
    try { const url = new URL(raw); return url.protocol === 'https:' && !url.username && !url.password ? url.href : ''; } catch { return ''; }
  };
  const identity = (kind, id) => kind === 'books' ? /^gutenberg:[1-9]\d{0,9}$/.test(id)
    : kind === 'music' ? /^archive:[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/.test(id)
      : kind === 'podcasts' && /^itunes:[1-9]\d{0,19}$/.test(id);
  const accessAction = (error) => Number(error?.status) === 401 ? 'Sign in'
    : Number(error?.status) === 403 || error?.code === 'profile_locked' || error?.error === 'profile_locked' ? 'Choose profile' : '';
  const storage = () => { try { return localStorage; } catch { return null; } };
  function readProgress(store, profileId) {
    const empty = { books: {}, audio: {}, last: null };
    if (typeof profileId !== 'string' || !profileId) return empty;
    try {
      const raw = JSON.parse(store?.getItem(KEY + encodeURIComponent(profileId)) || 'null');
      if (!raw || typeof raw !== 'object') return empty;
      for (const [id, value] of Object.entries(raw.books || {}).slice(-50)) {
        if (identity('books', id) && Number.isFinite(value?.ratio)) empty.books[id] = { ratio: Math.max(0, Math.min(1, value.ratio)), title: text(value.title), at: Number(value.at) || 0 };
      }
      for (const [id, value] of Object.entries(raw.audio || {}).slice(-100)) {
        if (id.length < 500 && Number.isFinite(value) && value >= 0 && value < 604800) empty.audio[id] = value;
      }
      const last = raw.last;
      if (['music', 'podcasts'].includes(last?.kind) && identity(last.kind, last.parentId) && typeof last.trackId === 'string') {
        empty.last = { kind: last.kind, parentId: last.parentId, trackId: text(last.trackId), title: text(last.title) };
      }
    } catch { /* A damaged or blocked store must not prevent playback. */ }
    return empty;
  }
  function writeProgress(store, profileId, change) {
    if (typeof profileId !== 'string' || !profileId) return;
    try {
      const value = readProgress(store, profileId); change(value);
      value.books = Object.fromEntries(Object.entries(value.books).slice(-50));
      value.audio = Object.fromEntries(Object.entries(value.audio).slice(-100));
      store?.setItem(KEY + encodeURIComponent(profileId), JSON.stringify(value));
    } catch { /* Keep a working session when private storage is full. */ }
  }

  /** A single HTML audio element. Saved records contain IDs, never expiring URLs. */
  function createAudioPlayer({ audio, store = storage(), resolveItems, onChange = () => {}, onStart = () => {} }) {
    let profile = null, queue = [], index = -1, generation = 0, playAttempt = 0, dismissed = false, phase = 'idle', message = '', permissionAction = '', listeners = [], resumeAt = 0, lastSaved = -1;
    const track = () => queue[index] || null;
    const snapshot = () => ({ profileId: profile?.id || null, queue: copy(queue), index, track: track() ? copy(track()) : null, phase, message, permissionAction,
      position: Number(audio.currentTime) || 0, duration: Number.isFinite(audio.duration) ? audio.duration : null,
      last: !dismissed && profileAllowed(profile) ? readProgress(store, profile.id).last : null });
    const emit = () => onChange(snapshot());
    const save = (position = audio.currentTime) => {
      const item = track(); if (!profileAllowed(profile) || !item || !Number.isFinite(position)) return;
      if (phase === 'ended') position = 0;
      else if (resumeAt > 0) position = resumeAt;
      writeProgress(store, profile.id, (value) => {
        delete value.audio[item.id]; value.audio[item.id] = Math.max(0, Math.min(604799, position));
        value.last = { kind: item.kind, parentId: item.parentId, trackId: item.id, title: item.title };
      });
    };
    const unbind = () => { listeners.forEach(([name, fn]) => audio.removeEventListener(name, fn)); listeners = []; };
    const listen = (name, fn) => { audio.addEventListener(name, fn); listeners.push([name, fn]); };
    function stopSource() {
      ++generation; ++playAttempt; unbind(); audio.pause(); audio.removeAttribute('src'); audio.load(); resumeAt = 0; lastSaved = -1;
    }
    function setProfile(value) {
      save(); stopSource(); profile = profileAllowed(value) ? { ...value } : null;
      queue = []; index = -1; dismissed = false; phase = 'idle'; message = ''; permissionAction = ''; emit();
    }
    async function play() {
      if (!profileAllowed(profile) || !track()) return false;
      if (phase === 'error') { resumeAt = readProgress(store, profile.id).audio[track().id] || 0; audio.load(); }
      const expected = generation, attempt = ++playAttempt; message = ''; phase = 'loading'; emit();
      try {
        onStart(); await audio.play();
        if (expected !== generation || attempt !== playAttempt || !profileAllowed(profile)) return false;
        phase = 'playing'; save(); emit(); return true;
      } catch {
        if (expected !== generation || attempt !== playAttempt) return false;
        phase = 'error'; message = 'Audio could not start. Press Play to try again, or choose another track.'; emit(); return false;
      }
    }
    function select(next, autoplay = true, resume = true) {
      if (!profileAllowed(profile) || !queue[next]) return false;
      save(); stopSource(); index = next; phase = 'paused'; message = '';
      const expected = generation, selected = track();
      resumeAt = resume ? readProgress(store, profile.id).audio[selected.id] || 0 : 0;
      audio.src = selected.url; audio.preload = 'metadata';
      const current = () => expected === generation && profileAllowed(profile) && track() === selected;
      listen('loadedmetadata', () => {
        if (!current()) return;
        if (resumeAt > 0 && Number.isFinite(audio.duration) && resumeAt < audio.duration - 3) audio.currentTime = resumeAt;
        resumeAt = 0; emit();
      });
      listen('timeupdate', () => {
        if (!current()) return;
        if (Math.abs(audio.currentTime - lastSaved) >= 5) { save(); lastSaved = audio.currentTime; }
        emit();
      });
      listen('playing', () => { if (current()) { phase = 'playing'; message = ''; emit(); } });
      listen('pause', () => { if (current() && phase !== 'error' && phase !== 'ended') { phase = 'paused'; save(); emit(); } });
      listen('waiting', () => { if (current()) { phase = 'loading'; emit(); } });
      listen('error', () => { if (current()) { phase = 'error'; message = 'This audio file could not be played. Try Play again, or choose another track.'; emit(); } });
      listen('ended', () => {
        if (!current()) return;
        phase = 'ended'; save(0);
        if (index + 1 < queue.length) select(index + 1, true, false);
        else { phase = 'ended'; message = 'Queue finished.'; emit(); }
      });
      emit(); if (autoplay) void play(); return true;
    }
    function setQueue(items, start, kind, parentId) {
      if (!profileAllowed(profile) || !identity(kind, parentId)) return false;
      save(); stopSource(); dismissed = false; permissionAction = '';
      const seen = new Set();
      queue = (Array.isArray(items) ? items : []).slice(0,100).filter((item) => {
        if (!item || typeof item.id !== 'string' || !item.id || !httpsURL(item.url) || seen.has(item.id)) return false;
        seen.add(item.id); return true;
      }).map((item) => ({ id: text(item.id), title: text(item.title) || 'Untitled audio', creator: text(item.creator), url: httpsURL(item.url), kind, parentId }));
      index = -1;
      const at = typeof start === 'string' ? queue.findIndex((item) => item.id === start) : Number(start) || 0;
      if (!queue[at]) { phase = 'error'; message = 'This track is no longer available. Choose another track.'; emit(); return false; }
      return select(at);
    }
    async function resume() {
      if (!profileAllowed(profile)) return false;
      const last = readProgress(store, profile.id).last; if (!last) return false;
      save(); stopSource(); dismissed = false; queue = []; index = -1;
      const expected = generation; phase = 'loading'; message = ''; permissionAction = ''; emit();
      try {
        const data = await resolveItems(last.kind, last.parentId);
        if (expected !== generation || !profileAllowed(profile)) return false;
        if (data?.id !== last.parentId || !Array.isArray(data.items)) throw new Error('Audio identity changed');
        return setQueue(data.items, last.trackId, last.kind, last.parentId);
      } catch (error) {
        if (expected === generation) {
          phase = 'error'; permissionAction = accessAction(error);
          message = permissionAction ? 'Open your profile to resume saved audio.' : 'Saved audio could not be reached. Try Resume again.'; emit();
        }
        return false;
      }
    }
    function pause() { if (track()) { ++playAttempt; audio.pause(); save(); if (phase !== 'ended') phase = 'paused'; emit(); } }
    function seek(seconds) {
      if (!profileAllowed(profile) || !track() || !Number.isFinite(audio.duration) || !Number.isFinite(seconds)) return;
      audio.currentTime = Math.max(0, Math.min(audio.duration, seconds)); save(); emit();
    }
    return { setProfile, setQueue, resume, play, pause, seek, select, snapshot,
      next: () => select(index + 1, true, false), previous: () => audio.currentTime > 3 ? seek(0) : select(index - 1),
      toggle: () => ['playing', 'loading'].includes(phase) ? pause() : play(),
      clear: () => { save(); stopSource(); queue = []; index = -1; dismissed = true; phase = 'idle'; message = ''; emit(); },
      flush: save };
  }

  const state = { profile: null, route: 'books', active: false, services: null, host: null, playerHost: null, generation: 0, requests: new Set(), query: '', items: [], reader: null };
  let player = null, playerNodes = null, audioElement = null, room = null;
  const node = (tag, cls, value) => { const out = document.createElement(tag); if (cls) out.className = cls; if (value) out.textContent = value; return out; };
  const button = (label, fn, cls = 'secondary-button') => { const out = node('button', cls, label); out.type = 'button'; if (fn) out.addEventListener('click', fn); return out; };
  const invalidate = () => { ++state.generation; state.requests.forEach((request) => request.abort()); state.requests.clear(); };
  const current = (generation) => generation === state.generation && state.active && profileAllowed(state.profile);
  async function request(path) {
    if (!profileAllowed(state.profile) || typeof state.services?.request !== 'function') throw new Error('Profile unavailable');
    const controller = new AbortController(); state.requests.add(controller);
    const timer = setTimeout(() => controller.abort(), 30000);
    try { return await state.services.request(path, { signal: controller.signal }); }
    finally { clearTimeout(timer); state.requests.delete(controller); }
  }
  const audioItems = (kind, id) => request(`/media/${kind}/${encodeURIComponent(id)}/${kind === 'music' ? 'tracks' : 'episodes'}`);
  function status(message, retry) {
    if (!room) return;
    room.status.replaceChildren(node('span', '', message));
    if (retry) room.status.append(button('Try again', retry));
  }
  function chooseProfile(label = 'Choose profile') {
    return button(label, () => window.BlazingProfile?.open?.());
  }
  function profileStatus(message = 'These libraries have no age ratings. Choose a Mature or Adult profile to open them.', label = 'Choose profile') {
    status(message); room?.status.append(chooseProfile(label));
  }
  function failure(error, message, retry) {
    const action = accessAction(error);
    if (!action) { status(message, retry); return; }
    reset(null, false);
    profileStatus(action === 'Sign in' ? 'Sign in to open your library.' : 'Choose and unlock your profile to open this library.', action);
  }
  function clock(seconds) { seconds = Math.max(0, Math.floor(Number(seconds) || 0)); return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`; }
  function renderPlayer(data) {
    if (!playerNodes) return;
    const ui = playerNodes, visible = profileAllowed(state.profile) && Boolean(data.track || data.last);
    state.playerHost.hidden = !visible;
    if (!visible) { ui.title.textContent = ''; ui.creator.textContent = ''; ui.status.textContent = ''; ui.queue.replaceChildren(); ui.queueKey = null; return; }
    ui.title.textContent = data.track?.title || data.last?.title || 'Your saved audio';
    ui.creator.textContent = data.track?.creator || 'Ready when you are';
    ui.play.textContent = data.permissionAction || (['playing', 'loading'].includes(data.phase) ? 'Pause' : data.track ? 'Play' : 'Resume');
    ui.play.setAttribute('aria-label', ui.play.textContent);
    ui.previous.disabled = !data.track || data.index === 0 && data.position <= 3;
    ui.next.disabled = !data.track || data.index >= data.queue.length - 1;
    ui.seek.disabled = !data.track || !Number.isFinite(data.duration) || data.duration <= 0;
    ui.seek.max = String(data.duration || 1); ui.seek.value = String(data.position);
    ui.seek.setAttribute('aria-valuetext', `${clock(data.position)} of ${clock(data.duration)}`);
    ui.time.textContent = `${clock(data.position)} / ${clock(data.duration)}`;
    ui.status.textContent = data.message || (data.phase === 'loading' ? 'Loading audio…' : '');
    if (data.permissionAction) ui.status.append(chooseProfile(data.permissionAction));
    const key = data.queue.map((item) => item.id).join('|');
    if (ui.queueKey !== key) {
      ui.queueKey = key; ui.queue.replaceChildren(...data.queue.map((item, index) => {
        const row = node('li'); row.append(button(item.title, () => player.select(index))); return row;
      }));
    }
    Array.from(ui.queue.children).forEach((row, index) => row.firstElementChild.setAttribute('aria-current', index === data.index ? 'true' : 'false'));
  }
  function buildPlayer(host) {
    if (state.playerHost === host && playerNodes) return;
    state.playerHost?.replaceChildren(); state.playerHost = host;
    host.classList.add('media-audio-player'); host.setAttribute('aria-label', 'Audio player');
    const title = node('strong', 'media-audio-title'), creator = node('span', 'media-audio-creator');
    const info = node('div', 'media-audio-info'); info.append(title, creator);
    const controls = node('div', 'media-audio-controls');
    const previous = button('Previous', () => player.previous()), play = button('Play', () => player.snapshot().permissionAction
      ? window.BlazingProfile?.open?.() : player.snapshot().track ? player.toggle() : player.resume(), 'primary-button');
    const next = button('Next', () => player.next()), stop = button('Close player', () => player.clear());
    controls.append(previous, play, next, stop);
    const seek = node('input', 'media-audio-seek'); seek.type = 'range'; seek.min = '0'; seek.step = '1'; seek.setAttribute('aria-label', 'Audio position');
    // Keep native seeking. The page's TV focus navigator also handles arrows.
    seek.addEventListener('keydown', (event) => {
      if (['ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) event.stopPropagation();
    });
    seek.addEventListener('input', () => player.seek(Number(seek.value)));
    const time = node('span', 'media-audio-time'), message = node('p', 'media-audio-status'); message.setAttribute('role', 'status');
    const details = node('details', 'media-audio-queue'), summary = node('summary', '', 'Play queue'), queue = node('ol'); details.append(summary, queue);
    host.replaceChildren(info, controls, seek, time, message, details);
    playerNodes = { title, creator, previous, play, next, seek, time, status: message, queue, queueKey: null };
    if (!player) {
      audioElement = document.createElement('audio'); audioElement.hidden = true; audioElement.className = 'media-audio-element';
      player = createAudioPlayer({ audio: audioElement, resolveItems: audioItems, onChange: renderPlayer, onStart: () => state.services?.pauseVideo?.() });
      player.setProfile(state.profile);
    }
    host.append(audioElement);
    renderPlayer(player.snapshot());
  }
  function saveReader() {
    const reader = state.reader;
    if (!reader || !reader.restored || reader.profileId !== state.profile?.id) return;
    const range = reader.body.scrollHeight - reader.body.clientHeight;
    const ratio = range > 0 ? Math.max(0, Math.min(1, reader.body.scrollTop / range)) : 0;
    writeProgress(storage(), reader.profileId, (value) => { delete value.books[reader.id]; value.books[reader.id] = { ratio, title: reader.title, at: Date.now() }; });
    reader.progress.textContent = `${Math.round(ratio * 100)}% read`;
  }
  function closeReader(restore = true) {
    const reader = state.reader; if (!reader) return;
    saveReader(); state.reader = null; reader.dialog.close(); reader.dialog.remove();
    if (restore && reader.returnFocus?.isConnected) reader.returnFocus.focus();
  }
  function showReader(data, trigger) {
    closeReader(false);
    const dialog = node('dialog', 'media-book-reader'); dialog.setAttribute('aria-label', text(data.title));
    const bar = node('div', 'media-book-toolbar'), title = node('h2', '', text(data.title));
    const progress = node('span', 'media-book-progress'), close = button('Close book', () => closeReader());
    bar.append(title, progress, close);
    const body = node('div', 'media-book-text'); body.tabIndex = 0; body.setAttribute('role', 'document'); body.textContent = String(data.text);
    body.addEventListener('keydown', (event) => {
      if (event.key === 'Back' || event.key === 'GoBack' || event.keyCode === 461) { event.preventDefault(); event.stopPropagation(); closeReader(); }
      else if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) event.stopPropagation();
    });
    dialog.append(bar, body); state.host.append(dialog);
    const saved = readProgress(storage(), state.profile.id).books[data.id]?.ratio || 0;
    const reader = { dialog, body, progress, id: data.id, title: text(data.title), profileId: state.profile.id, returnFocus: trigger, restored: false };
    state.reader = reader;
    body.addEventListener('scroll', () => { if (state.reader === reader) saveReader(); });
    dialog.addEventListener('cancel', (event) => { event.preventDefault(); closeReader(); });
    dialog.showModal(); body.focus();
    requestAnimationFrame(() => {
      if (state.reader !== reader) return;
      body.scrollTop = saved * Math.max(0, body.scrollHeight - body.clientHeight); reader.restored = true; progress.textContent = `${Math.round(saved * 100)}% read`;
    });
  }
  async function openBook(item, trigger) {
    invalidate(); const expected = state.generation;
    status('Opening book…'); room.detail.replaceChildren();
    try {
      const data = await request(`/media/books/${encodeURIComponent(item.id)}/text`);
      if (!current(expected)) return;
      if (data?.id !== item.id || typeof data.text !== 'string' || !data.text.trim() || data.truncated === true) throw new Error('Book unavailable');
      status(''); showReader(data, trigger);
    } catch (error) { if (current(expected)) failure(error, 'This book could not be opened.', () => openBook(item, trigger)); }
  }
  async function openAudio(item, trigger) {
    invalidate(); closeReader(false); const expected = state.generation, kind = state.route;
    status(`Loading ${kind === 'music' ? 'tracks' : 'episodes'}…`); room.detail.replaceChildren();
    try {
      const data = await audioItems(kind, item.id);
      if (!current(expected)) return;
      if (data?.id !== item.id || !Array.isArray(data.items)) throw new Error('Audio unavailable');
      const items = data.items.filter((entry) => typeof entry?.id === 'string' && httpsURL(entry.url));
      const back = button('Back to results', () => { room.detail.replaceChildren(); trigger?.focus(); });
      room.detail.append(back, node('h2', '', text(data.title || item.title)));
      if (!items.length) { status('No playable audio files are available here.'); return; }
      const list = node('ol', 'media-track-list');
      items.forEach((entry) => {
        const row = node('li', 'media-track-row');
        const play = button(text(entry.title) || 'Play audio', () => { if (current(expected)) player.setQueue(items, entry.id, kind, item.id); });
        row.append(play); if (entry.durationSeconds) row.append(node('span', '', clock(entry.durationSeconds))); list.append(row);
      });
      room.detail.append(list); status(''); back.focus();
    } catch (error) { if (current(expected)) failure(error, 'This audio list could not be reached.', () => openAudio(item, trigger)); }
  }
  function card(item) {
    const out = button(text(item.title), null, 'card media-library-card');
    out.replaceChildren(); out.setAttribute('aria-label', `${state.route === 'books' ? 'Read' : 'Open'} ${text(item.title)}`);
    const image = node('img', 'card-image'); image.alt = ''; image.loading = 'lazy'; image.decoding = 'async';
    if (httpsURL(item.poster)) image.src = httpsURL(item.poster); else out.classList.add('no-image');
    image.addEventListener('error', () => out.classList.add('no-image'), { once: true });
    out.append(image, node('span', 'card-label', text(item.title)));
    const creator = Array.isArray(item.authors) ? item.authors.join(', ') : item.creator;
    if (creator) out.append(node('span', 'media-card-creator', text(creator)));
    if (state.route === 'books') {
      const ratio = readProgress(storage(), state.profile?.id).books[item.id]?.ratio;
      if (ratio > 0) out.append(node('span', 'media-reading-position', `${Math.round(ratio * 100)}% read`));
    }
    const kind = state.route;
    out.addEventListener('click', () => { if (!state.active || !profileAllowed(state.profile) || !state.items.includes(item) || state.route !== kind) return; kind === 'books' ? openBook(item, out) : openAudio(item, out); });
    return out;
  }
  async function load(query = '') {
    if (!state.active || !room) return;
    invalidate(); closeReader(false); const expected = state.generation;
    state.query = text(query,160); state.items = []; room.input.value = state.query; room.results.replaceChildren(); room.detail.replaceChildren();
    if (!profileAllowed(state.profile)) { profileStatus(); return; }
    status(`Loading ${state.route}…`);
    try {
      const data = await request(`/media/${state.route}?q=${encodeURIComponent(state.query)}&limit=24`);
      if (!current(expected)) return;
      if (!Array.isArray(data?.items)) throw new Error('Library unavailable');
      state.items = data.items.filter((item) => identity(state.route, item?.id) && item.title);
      room.results.replaceChildren(...state.items.map(card));
      status(state.items.length ? state.query ? `${state.items.length} results for “${state.query}”` : '' : state.query ? 'No matches. Try a different title or name.' : 'This library has no titles available right now.');
    } catch (error) { if (current(expected)) failure(error, 'This library could not be reached.', () => load(state.query)); }
  }
  function mount(route, services) {
    if (!KINDS.includes(route) || !services?.host || !services.playerHost) return false;
    const profileChanged = Object.hasOwn(services, 'profile') && JSON.stringify(services.profile) !== JSON.stringify(state.profile);
    const initialQuery = typeof services.initialQuery === 'string' ? text(services.initialQuery, 160) : null;
    const initialItem = services.initialItem;
    const changed = state.host !== services.host || state.route !== route || !state.active || profileChanged || initialQuery !== null || initialItem != null;
    state.services = services; state.host = services.host; state.active = true; state.route = route;
    buildPlayer(services.playerHost);
    if (profileChanged) reset(services.profile, false);
    if (!changed && room) return true;
    invalidate(); closeReader(false);
    const tabs = node('nav', 'media-library-tabs'); tabs.setAttribute('aria-label', 'Books and audio');
    KINDS.forEach((kind) => { const tab = button(kind[0].toUpperCase() + kind.slice(1), () => services.navigate?.(kind)); tab.setAttribute('aria-current', kind === route ? 'page' : 'false'); tabs.append(tab); });
    const form = node('form', 'media-library-search'), label = node('label', '', `Search ${route}`), input = node('input');
    input.type = 'search'; input.maxLength = 160; input.placeholder = route === 'books' ? 'Book title or author' : route === 'music' ? 'Music title' : 'Podcast name or topic';
    label.append(input); const submit = node('button', 'primary-button', 'Search'); submit.type = 'submit'; form.append(label, submit);
    form.addEventListener('submit', (event) => { event.preventDefault(); load(input.value); });
    const message = node('div', 'media-library-status'); message.setAttribute('role', 'status');
    const results = node('div', 'media-library-grid'), detail = node('section', 'media-library-detail');
    room = { form, input, status: message, results, detail };
    state.host.classList.add('media-library'); state.host.replaceChildren(tabs, form, message, detail, results);
    if (initialItem != null && profileAllowed(state.profile)) {
      state.query = initialQuery || ''; state.items = []; input.value = state.query;
      const expectedType = { books: 'book', music: 'album', podcasts: 'podcast' }[route];
      if (!identity(route, initialItem?.id) || typeof initialItem?.title !== 'string' || !text(initialItem.title)
        || initialItem.type != null && initialItem.type !== expectedType) {
        status('This selection is not available in this library. Search for another title.'); return true;
      }
      const item = { ...initialItem }; state.items = [item];
      const trigger = card(item); results.append(trigger);
      route === 'books' ? openBook(item, trigger) : openAudio(item, trigger);
    } else load(initialQuery || '');
    return true;
  }
  function reset(profile, reload = true) {
    closeReader(false); invalidate(); state.profile = profileAllowed(profile) ? { ...profile } : null; state.query = ''; state.items = [];
    player?.setProfile(state.profile); if (room) { room.input.value = ''; room.results.replaceChildren(); room.detail.replaceChildren(); }
    if (reload && state.active) load();
  }
  function leave() { closeReader(false); invalidate(); state.active = false; }
  document.addEventListener('blazing-profile-selected', (event) => reset(event.detail));
  document.addEventListener('blazing-profile-signed-out', () => reset(null));
  document.addEventListener('blazing-profile-unlock-expired', () => reset(null));
  window.addEventListener('pagehide', () => { saveReader(); player?.flush(); });
  window.BlazingMediaLibrary = { mount, leave, reset, pause: () => player?.pause(), closeReader,
    core: { createAudioPlayer, profileAllowed, readProgress, writeProgress } };
})();
